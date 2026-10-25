<?php
/** Offline administrative library. Deliberately outside the installable plugin. */
namespace Pbin\Migration;

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

class MigrationException extends \RuntimeException {}
class CommitUncertain extends MigrationException {}

final class ExportFile {
    public const FORMAT = 'pbin-bolt-export-v1';
    public const MAX_EXPORT_BYTES = 67108864;
    public const MAX_CONTENT_BYTES = 33554432;
    public const MAX_RECORD_BYTES = 4194304;
    public const MAX_RECORDS = 100000;
    public const COLUMNS = [
        'pastes' => ['id', 'created_at', 'language', 'text', 'title'],
        'diffs' => ['id', 'created_at', 'old_text', 'new_text'],
        'snapshots' => ['id', 'created_at', 'paste_id', 'name', 'language', 'text', 'title'],
    ];

    private function __construct(public readonly array $data, public readonly string $sha256) {}

    public static function rowHash(string $kind, array $fields): string {
        $hash = hash_init('sha256'); hash_update($hash, "pbin-row-v1\0$kind\0");
        foreach ($fields as $field) { hash_update($hash, strlen($field) . ':' . $field); }
        return hash_final($hash);
    }
    public static function json($value): string {
        return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
    }
    public static function keys(array $value, array $keys): void {
        if (array_keys($value) !== $keys) { throw new MigrationException('Unsupported, missing or reordered fields'); }
    }
    public static function hex($value): void {
        if (!is_string($value) || !preg_match('/\A[a-f0-9]{64}\z/', $value)) { throw new MigrationException('Expected a lowercase SHA-256'); }
    }
    private static function uuid(string $value): bool {
        return preg_match('/\A[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\z/', $value) === 1;
    }
    private static function timestamp(string $value): bool {
        if (strlen($value) > 30 || !preg_match('/\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(?:Z|[+-]([0-9]{2}):([0-9]{2}))\z/', $value, $m)) { return false; }
        $year = (int) $m[1]; $month = (int) $m[2]; $day = (int) $m[3];
        $days = [31, ($year % 4 === 0 && ($year % 100 !== 0 || $year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        return $month >= 1 && $month <= 12 && $day >= 1 && $day <= $days[$month - 1]
            && (int) $m[4] <= 23 && (int) $m[5] <= 59 && (int) $m[6] <= 59
            && (int) ($m[7] ?? '0') <= 23 && (int) ($m[8] ?? '0') <= 59;
    }
    public static function read(string $path, string $expectedHash): self {
        self::hex($expectedHash);
        $info = @lstat($path);
        if (!$info || ($info['mode'] & 0170000) !== 0100000 || $info['size'] > self::MAX_EXPORT_BYTES) {
            throw new MigrationException('Supply a regular export file of at most 64 MiB, not a symlink');
        }
        $handle = @fopen($path, 'rb');
        if ($handle === false) { throw new MigrationException('Cannot read export'); }
        try { $raw = stream_get_contents($handle, self::MAX_EXPORT_BYTES + 1); }
        finally { fclose($handle); }
        if (!is_string($raw) || strlen($raw) > self::MAX_EXPORT_BYTES || !hash_equals($expectedHash, hash('sha256', $raw))) {
            throw new MigrationException('Export size or SHA-256 mismatch');
        }
        return self::parse($raw, $expectedHash);
    }
    public static function parse(string $raw, string $expectedHash): self {
        self::hex($expectedHash);
        if (strlen($raw) > self::MAX_EXPORT_BYTES || !hash_equals($expectedHash, hash('sha256', $raw))) { throw new MigrationException('Export size or SHA-256 mismatch'); }
        try { $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { throw new MigrationException('Invalid export JSON', 0, $error); }
        if (!is_array($data)) { throw new MigrationException('Expected an export object'); }
        self::keys($data, ['format', 'source_sha256', 'counts', 'content_sha256', 'records']);
        if ($data['format'] !== self::FORMAT || !is_array($data['counts']) || !is_array($data['records']) || !array_is_list($data['records']) || count($data['records']) > self::MAX_RECORDS) {
            throw new MigrationException('Unsupported export format or record bound');
        }
        self::hex($data['source_sha256']); self::hex($data['content_sha256']);
        self::keys($data['counts'], array_keys(self::COLUMNS));
        $counts = ['pastes' => 0, 'diffs' => 0, 'snapshots' => 0]; $parents = []; $totalBytes = 0; $lastOrder = '';
        $content = hash_init('sha256'); hash_update($content, "pbin-content-v1\n");
        foreach ($data['records'] as $position => $record) {
            if (!is_array($record)) { throw new MigrationException('Invalid export record'); }
            self::keys($record, ['kind', 'fields', 'sha256']); $kind = $record['kind']; $values = $record['fields'];
            if (!is_string($kind) || !isset(self::COLUMNS[$kind]) || !is_array($values) || !array_is_list($values) || count($values) !== count(self::COLUMNS[$kind])) { throw new MigrationException('Unsupported export record shape'); }
            $recordBytes = 0;
            foreach ($values as $value) {
                if (!is_string($value)) { throw new MigrationException('Export fields must be strings'); }
                $recordBytes += strlen($value);
            }
            $totalBytes += $recordBytes;
            if ($recordBytes > self::MAX_RECORD_BYTES || $totalBytes > self::MAX_CONTENT_BYTES) { throw new MigrationException('Export content bound exceeded'); }
            if (!self::uuid($values[0]) || !self::timestamp($values[1])) { throw new MigrationException("Record $position has an unsupported ID or timestamp; no normalization allowed"); }
            $order = array_search($kind, array_keys(self::COLUMNS), true) . ':' . $values[0];
            if (strcmp($order, $lastOrder) <= 0) { throw new MigrationException('Duplicate or unsorted export ID'); } $lastOrder = $order;
            if ($kind === 'pastes') { $parents[$values[0]] = true; }
            if ($kind === 'snapshots' && !isset($parents[$values[2]])) { throw new MigrationException('Snapshot parent is absent from source export'); }
            self::hex($record['sha256']);
            if (!hash_equals($record['sha256'], self::rowHash($kind, $values))) { throw new MigrationException("Record $position content hash mismatch"); }
            hash_update($content, $record['sha256'] . "\n"); $counts[$kind]++;
        }
        if ($counts !== $data['counts'] || !hash_equals($data['content_sha256'], hash_final($content))) { throw new MigrationException('Export counts or content digest mismatch'); }
        // Exact Go/PHP canonical encoding also rejects duplicate keys, aliases,
        // alternate numeric representations and unpaired Unicode surrogates.
        if (self::json($data) !== $raw) { throw new MigrationException('Non-canonical export JSON; do not edit or reserialize exports'); }
        return new self($data, $expectedHash);
    }
}

interface Destination {
    public function identity(): string;
    public function schema(): void;
    public function counts(): array;
    public function read(string $kind, string $id, bool $lock): ?array;
    public function checkInsert(string $kind, array $fields): void;
    public function begin(): void;
    public function insert(string $kind, array $fields): void;
    public function commit(): void;
    public function rollback(): void;
}

final class Importer {
    public function __construct(private Destination $target) {}

    public function reconcile(ExportFile $export, bool $locked = false): array {
        $this->target->schema(); $before = $this->target->counts();
        $summary = ['insert' => 0, 'identical' => 0, 'conflict' => 0]; $samples = [];
        $state = hash_init('sha256'); hash_update($state, "pbin-plan-v1\n" . $this->target->identity() . "\n" . $export->sha256 . "\n" . ExportFile::json($before));
        foreach ($export->data['records'] as $position => $record) {
            $this->target->checkInsert($record['kind'], $record['fields']);
            $existing = $this->target->read($record['kind'], $record['fields'][0], $locked);
            $status = $existing === null ? 'insert' : ($existing === $record['fields'] ? 'identical' : 'conflict');
            $existingHash = $existing === null ? '-' : ExportFile::rowHash($record['kind'], $existing);
            hash_update($state, "$position:$status:$existingHash\n"); $summary[$status]++;
            if ($status === 'conflict' && count($samples) < 20) {
                $samples[] = ['record' => $position, 'kind' => $record['kind'], 'source_sha256' => $record['sha256'], 'target_sha256' => $existingHash];
            }
        }
        // Recheck under the transaction's metadata locks before any inserts.
        if ($locked) { $this->target->schema(); }
        return ['mode' => 'dry-run', 'target_sha256' => $this->target->identity(), 'export_sha256' => $export->sha256,
            'source_sha256' => $export->data['source_sha256'], 'content_sha256' => $export->data['content_sha256'],
            'source_counts' => $export->data['counts'], 'target_counts_before' => $before,
            'rows' => $summary, 'conflict_samples' => $samples, 'plan_sha256' => hash_final($state)];
    }

    public function apply(ExportFile $export, string $expectedPlan, bool $writesFrozen): array {
        ExportFile::hex($expectedPlan);
        if (!$writesFrozen) { throw new MigrationException('Explicit offline-writes confirmation is required'); }
        $this->target->begin();
        try {
            $plan = $this->reconcile($export, true);
            if (!hash_equals($expectedPlan, $plan['plan_sha256'])) { throw new MigrationException('Plan changed; run and review a new dry run'); }
            if ($plan['rows']['conflict'] !== 0) { throw new MigrationException('Conflicting existing IDs; no overwrite or partial import is permitted'); }
            $inserted = ['pastes' => 0, 'diffs' => 0, 'snapshots' => 0];
            foreach ($export->data['records'] as $record) {
                $existing = $this->target->read($record['kind'], $record['fields'][0], true);
                if ($existing === null) { $this->target->insert($record['kind'], $record['fields']); $inserted[$record['kind']]++; }
                elseif ($existing !== $record['fields']) { throw new MigrationException('Target changed inside apply'); }
            }
            foreach ($export->data['records'] as $record) {
                if ($this->target->read($record['kind'], $record['fields'][0], true) !== $record['fields']) { throw new MigrationException('Byte-for-byte verification failed; rolling back'); }
            }
            $after = $this->target->counts();
            foreach ($after as $kind => $count) {
                if ($count !== $plan['target_counts_before'][$kind] + $inserted[$kind]) { throw new MigrationException('Target counts changed unexpectedly; rolling back'); }
            }
            $this->target->commit();
            return array_merge($plan, ['mode' => 'applied', 'inserted_counts' => $inserted, 'target_counts_after' => $after, 'verified_source_content_sha256' => $export->data['content_sha256']]);
        } catch (\Throwable $error) {
            try { $this->target->rollback(); } catch (\Throwable $ignored) {}
            throw $error;
        }
    }
}

/** Uses the core wpdb from a dedicated SHORTINIT CLI process, never plugin APIs. */
final class WpdbDestination implements Destination {
    private ?string $connection = null;
    private ?string $guard = null;
    private bool $started = false;
    private int $packet = 0;

    public function __construct(private object $db, private string $prefix, private string $targetIdentity, private string $database) {
        if (!preg_match('/\A[a-zA-Z0-9_]{1,54}\z/', $prefix)) { throw new MigrationException('Unsafe target table prefix'); }
        if (!is_string($db->prefix ?? null) || $prefix !== $db->prefix . 'pbin_') { throw new MigrationException('Only the explicitly selected WordPress default pbin tables are supported; preview imports are refused'); }
        ExportFile::hex($targetIdentity);
        if (!preg_match('/\A[a-zA-Z0-9_]{1,64}\z/', $database)) { throw new MigrationException('Unsupported database name'); }
        foreach (['prepare', 'query', 'get_results', 'suppress_errors'] as $method) {
            if (!is_callable([$db, $method])) { throw new MigrationException('A dedicated core wpdb is required'); }
        }
        $db->suppress_errors(true);
    }
    public function identity(): string { return $this->targetIdentity; }
    private function sql(string $sql, ...$values): string {
        $result = $this->db->prepare($sql, ...$values);
        if (!is_string($result) || $result === '') { throw new MigrationException('Cannot prepare query'); } return $result;
    }
    private function query(string $sql): int {
        $result = $this->db->query($sql);
        if ($result === false || ($this->db->last_error ?? '') !== '') { throw new MigrationException('Database operation failed; raw SQL/errors suppressed'); }
        return (int) $result;
    }
    private function rows(string $sql): array {
        $rows = $this->db->get_results($sql, 'ARRAY_A');
        if (!is_array($rows) || ($this->db->last_error ?? '') !== '') { throw new MigrationException('Database read failed; raw SQL/errors suppressed'); } return $rows;
    }
    private function table(string $kind): string {
        if (!isset(ExportFile::COLUMNS[$kind])) { throw new MigrationException('Unsupported table'); } return $this->prefix . $kind;
    }
    private function session(): array {
        $rows = $this->rows('SELECT CONNECTION_ID() AS connection_id, @@session.autocommit AS autocommit, @@session.sql_mode AS sql_mode, @@character_set_client AS client_charset, @@character_set_connection AS connection_charset, @@character_set_results AS results_charset, @@max_allowed_packet AS packet, @pbin_migration_guard AS migration_guard');
        if (count($rows) !== 1 || !preg_match('/\A[1-9][0-9]*\z/', (string) ($rows[0]['connection_id'] ?? ''))) { throw new MigrationException('Cannot identify dedicated database session'); }
        $session = $rows[0];
        if ($this->started && ((string) $session['connection_id'] !== $this->connection || ($session['migration_guard'] ?? null) !== $this->guard)) { throw new MigrationException('Database session changed; no automatic apply retry'); }
        return $session;
    }
    public function schema(): void {
        $session = $this->session();
        $database = $this->rows('SELECT DATABASE() AS database_name');
        if (count($database) !== 1 || ($database[0]['database_name'] ?? null) !== $this->database) { throw new MigrationException('Connected to the wrong database'); }
        if ((string) ($session['autocommit'] ?? '') !== '1') { throw new MigrationException('Dedicated autocommit connection required'); }
        if ($this->started && !preg_match('/(?:\A|,)(?:STRICT_ALL_TABLES|STRICT_TRANS_TABLES)(?:,|\z)/', $session['sql_mode'] ?? '')) { throw new MigrationException('Apply lost strict SQL mode'); }
        foreach (['client_charset', 'connection_charset', 'results_charset'] as $key) {
            if (($session[$key] ?? '') !== 'utf8mb4') { throw new MigrationException('End-to-end utf8mb4 database connection required'); }
        }
        $this->packet = min(67108864, (int) ($session['packet'] ?? 0));
        if ($this->packet < 1024) { throw new MigrationException('Unsupported packet limit'); }
        // TRIGGERS silently omits entries without TRIGGER privilege. Require an
        // explicit direct grant so an empty metadata result is meaningful. Role-
        // only grants are conservatively refused, not guessed or expanded.
        $grants = array_map(fn($row) => (string) reset($row), $this->rows('SHOW GRANTS FOR CURRENT_USER'));
        foreach (ExportFile::COLUMNS as $kind => $fields) {
            $table = $this->table($kind);
            $visible = false;
            foreach ($grants as $grant) {
                if (!preg_match('/\AGRANT (.+) ON (.+) TO /', $grant, $m)) { continue; }
                $privileges = explode(', ', $m[1]);
                if (in_array('ALL PRIVILEGES', $privileges, true) || in_array('TRIGGER', $privileges, true)) {
                    if (in_array($m[2], ['*.*', '`' . $this->database . '`.*', '`' . $this->database . '`.`' . $table . '`'], true)) { $visible = true; }
                }
            }
            if (!$visible) { throw new MigrationException('Cannot prove trigger metadata visibility; explicit direct TRIGGER grant required (no permissions are changed)'); }
            $info = $this->rows($this->sql('SELECT ENGINE, TABLE_TYPE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table));
            if (count($info) !== 1 || $info[0]['ENGINE'] !== 'InnoDB' || $info[0]['TABLE_TYPE'] !== 'BASE TABLE' || !str_starts_with($info[0]['TABLE_COLLATION'] ?? '', 'utf8mb4_')) { throw new MigrationException('Expected existing InnoDB/utf8mb4 pbin tables; no schema is installed or repaired'); }
            $columns = $this->rows($this->sql('SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table));
            if (count($columns) !== count($fields)) { throw new MigrationException('Unsupported pbin schema columns'); }
            $seen = [];
            foreach ($columns as $column) {
                $name = $column['COLUMN_NAME']; $id = in_array($name, ['id', 'paste_id'], true);
                $type = $id ? 'varchar(36)' : ($name === 'created_at' ? 'varchar(30)' : 'longtext');
                if (!in_array($name, $fields, true) || isset($seen[$name]) || $column['COLUMN_TYPE'] !== $type || $column['IS_NULLABLE'] !== 'NO' || $column['COLUMN_DEFAULT'] !== null || $column['EXTRA'] !== ''
                    || $column['CHARACTER_SET_NAME'] !== ($id ? 'ascii' : 'utf8mb4') || ($id && $column['COLLATION_NAME'] !== 'ascii_bin')) { throw new MigrationException('Unsupported pbin column shape, precision or collation'); }
                $seen[$name] = true;
            }
            $indexes = $this->rows("SHOW INDEX FROM `$table`"); $shape = [];
            foreach ($indexes as $index) {
                if ($index['Sub_part'] !== null || ($index['Index_type'] ?? '') !== 'BTREE') { throw new MigrationException('Unsupported pbin index'); }
                $shape[$index['Key_name']][(int) $index['Seq_in_index']] = [$index['Column_name'], (string) $index['Non_unique']];
            }
            foreach ($shape as &$index) { ksort($index); } unset($index); ksort($shape);
            $expected = ['PRIMARY' => [1 => ['id', '0']]];
            if ($kind === 'snapshots') { $expected['paste_created'] = [1 => ['paste_id', '1'], 2 => ['created_at', '1'], 3 => ['id', '1']]; }
            if ($shape !== $expected) { throw new MigrationException('Unsupported pbin index shape'); }
            if ($this->rows($this->sql('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = %s', $table)) !== []
                || $this->rows($this->sql("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = %s AND CONSTRAINT_TYPE = 'FOREIGN KEY'", $table)) !== []) { throw new MigrationException('Triggers/foreign keys require a separate migration review'); }
        }
    }
    public function counts(): array {
        $result = [];
        foreach (ExportFile::COLUMNS as $kind => $_) {
            $rows = $this->rows('SELECT COUNT(*) AS row_count FROM `' . $this->table($kind) . '`');
            $count = $rows[0]['row_count'] ?? null;
            if (count($rows) !== 1 || !preg_match('/\A[0-9]{1,7}\z/', (string) $count) || (int) $count > 1000000) { throw new MigrationException('Target count invalid or exceeds one-million-row safety bound'); }
            $result[$kind] = (int) $count;
        }
        if ($this->started) { $this->session(); } return $result;
    }
    public function read(string $kind, string $id, bool $lock): ?array {
        if ($lock && !$this->started) { throw new MigrationException('Locked reads require an importer-owned transaction'); }
        $table = $this->table($kind); $columns = ExportFile::COLUMNS[$kind];
        $size = implode(' + ', array_map(fn($column) => "OCTET_LENGTH(`$column`)", $columns));
        $parts = array_map(fn($column) => "CASE WHEN ($size) <= " . ExportFile::MAX_RECORD_BYTES . " THEN `$column` ELSE NULL END AS `$column`", $columns);
        $rows = $this->rows($this->sql('SELECT ' . implode(',', $parts) . ", ($size) AS row_bytes FROM `$table` WHERE id = %s" . ($lock ? ' FOR UPDATE' : ''), $id));
        if ($this->started) { $this->session(); }
        if ($rows === []) { return null; }
        if (count($rows) !== 1 || (int) $rows[0]['row_bytes'] > ExportFile::MAX_RECORD_BYTES) { throw new MigrationException('Target record exceeds the safety bound'); }
        $result = [];
        foreach ($columns as $column) { if (!is_string($rows[0][$column] ?? null)) { throw new MigrationException('Invalid target record'); } $result[] = $rows[0][$column]; }
        return $result;
    }
    private function insertSQL(string $kind, array $fields, string $connection, string $guard): string {
        $table = $this->table($kind); $columns = ExportFile::COLUMNS[$kind];
        if (count($fields) !== count($columns)) { throw new MigrationException('Invalid insert shape'); }
        return $this->sql("INSERT INTO `$table` (`" . implode('`,`', $columns) . '`) SELECT ' . implode(',', array_fill(0, count($fields), '%s')) . ' WHERE CONNECTION_ID() = %s AND @pbin_migration_guard = %s', ...array_merge($fields, [$connection, $guard]));
    }
    public function checkInsert(string $kind, array $fields): void {
        if (strlen($this->insertSQL($kind, $fields, '18446744073709551615', str_repeat('a', 64))) + 1024 > $this->packet) { throw new MigrationException('Record exceeds target max_allowed_packet; no automatic splitting'); }
    }
    public function begin(): void {
        if ($this->started) { throw new MigrationException('Transaction already started'); }
        $this->schema(); $session = $this->session();
        $this->connection = (string) $session['connection_id']; $this->guard = bin2hex(random_bytes(32));
        // Rejected inside an existing transaction, rather than implicitly committing it.
        $this->query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        // Core wpdb normally removes strict modes. Enable it on this dedicated,
        // short-lived APPLY connection only; dry runs issue SELECT/SHOW only.
        $modes = array_filter(explode(',', (string) ($session['sql_mode'] ?? '')));
        $modes[] = 'STRICT_ALL_TABLES';
        $this->query($this->sql('SET SESSION sql_mode = %s', implode(',', array_unique($modes))));
        $this->started = true;
        try {
            $this->query('START TRANSACTION');
            $this->query($this->sql('SET @pbin_migration_guard = %s', $this->guard));
            $this->session();
        } catch (\Throwable $error) { $this->rollback(); throw $error; }
    }
    public function insert(string $kind, array $fields): void {
        if (!$this->started || $this->connection === null || $this->guard === null) { throw new MigrationException('Importer transaction required'); }
        $this->checkInsert($kind, $fields);
        // A wpdb reconnect/replay must insert zero rows, never autocommit on a
        // new connection. There is no REPLACE/IGNORE/UPDATE or duplicate fallback.
        if ($this->query($this->insertSQL($kind, $fields, $this->connection, $this->guard)) !== 1) { throw new MigrationException('Insert lost its guarded transaction'); }
        $warnings = $this->rows('SELECT @@warning_count AS warning_count');
        if (count($warnings) !== 1 || (string) $warnings[0]['warning_count'] !== '0') { throw new MigrationException('Insert produced warnings; refusing possible coercion'); }
        $this->session();
    }
    public function commit(): void {
        if (!$this->started) { throw new MigrationException('No importer transaction to commit'); }
        $this->session();
        try { $this->query('COMMIT'); $this->session(); }
        catch (\Throwable $error) { throw new CommitUncertain('Commit outcome is uncertain; freeze writes and reconcile before any retry', 0, $error); }
        $this->started = false;
    }
    public function rollback(): void {
        if ($this->started) { try { $this->query('ROLLBACK'); } finally { $this->started = false; } }
    }
}
