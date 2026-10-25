<?php
namespace Pbin\Plugin;

use RuntimeException;
use OutOfBoundsException;
use Throwable;
defined('ABSPATH') || exit;

/** An application data bound for trusted preview PHP, not a disk quota/sandbox. */
final class PreviewQuotaExceeded extends RuntimeException {}
final class PreviewQuotaCommitUncertain extends RuntimeException {}

final class PreviewQuota {
    public const MAX_BYTES = 8 * 1024 * 1024;
    public const MAX_DOCUMENTS = 1000;
    public const MAX_BUCKETS = 1024;
    private const FIELDS = [
        'pastes' => ['text', 'language', 'title'],
        'diffs' => ['old_text', 'new_text'],
        'snapshots' => ['name', 'text', 'language', 'title'],
    ];
    private object $db;
    private string $prefix;

    public function __construct(object $db, string $prefix) {
        if (!Instance::current()->preview || !preg_match('/\A[a-zA-Z0-9_]{1,54}\z/', $prefix)) {
            throw new RuntimeException('Invalid preview quota scope');
        }
        $this->db = $db;
        $this->prefix = $prefix;
    }

    /** Called ONLY by the normal selected-instance schema migration. Existing
     * quota state is never reset or repaired by a request's document mutation. */
    public function install(): void {
        $this->quiet(function (): void {
            $this->idle();
            $table = $this->prefix . 'quota';
            $existing = $this->rows($this->sql('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $table));
            if ($existing === []) {
                // Competing or partial installation fails closed. No INSERT IGNORE.
                $this->query("CREATE TABLE `$table` (singleton_id tinyint unsigned NOT NULL, schema_version smallint unsigned NOT NULL, PRIMARY KEY (singleton_id)) ENGINE=InnoDB");
            }
            $this->transaction(function (): void {
                $usage = $this->usage();
                $buckets = $this->bucketCount();
                if ($usage['bytes'] > self::MAX_BYTES || $usage['documents'] > self::MAX_DOCUMENTS || $buckets > self::MAX_BUCKETS) {
                    throw new PreviewQuotaExceeded('Existing preview data exceeds quota; no documents were deleted');
                }
            }, $existing === []);
        });
    }

    public function insert(string $table, array $row, ?string $parent = null): void {
        $bytes = $this->bytes($table, $row);
        $this->transaction(function (string $connection) use ($table, $row, $bytes, $parent): void {
            $usage = $this->usage();
            $this->admit($usage, $bytes, 1);
            if ($parent !== null) { $this->record('pastes', $parent, $connection); }
            $columns = implode(',', array_keys($row));
            // wpdb's whole-query charset check treats mixed ASCII-ID/utf8mb4
            // tables as ASCII. Encode values, not the schema or quota accounting.
            $placeholders = implode(',', array_fill(0, count($row), 'CONVERT(UNHEX(%s) USING utf8mb4)'));
            $values = array_map([self::class, 'utf8Hex'], array_values($row));
            $changed = $this->query($this->sql("INSERT INTO `{$this->prefix}{$table}` ($columns) SELECT $placeholders WHERE CONNECTION_ID() = %s", ...[...$values, $connection]));
            if ($changed !== 1) { throw new RuntimeException('Preview insert lost its transaction'); }
            $this->verify($table, $row, $connection);
        });
    }

    public function updatePaste(string $id, array $row): void {
        $bytes = $this->bytes('pastes', $row);
        $this->transaction(function (string $connection) use ($id, $row, $bytes): void {
            $usage = $this->usage();
            $old = $this->record('pastes', $id, $connection);
            $oldBytes = $this->bytes('pastes', $old, false);
            $this->admit($usage, $bytes - $oldBytes, 0);
            $changed = $this->query($this->sql("UPDATE `{$this->prefix}pastes` SET text = CONVERT(UNHEX(%s) USING utf8mb4), language = CONVERT(UNHEX(%s) USING utf8mb4), title = CONVERT(UNHEX(%s) USING utf8mb4) WHERE id = %s AND CONNECTION_ID() = %s", self::utf8Hex($row['text']), self::utf8Hex($row['language']), self::utf8Hex($row['title']), $id, $connection));
            // MySQL returns zero for no-op updates. The locked read proved existence.
            if ($changed > 1) { throw new RuntimeException('Unexpected preview update count'); }
            $this->verify('pastes', ['id' => $id] + $row, $connection);
        });
    }

    public function allowRequest(string $bucket, float $now, float $rate): bool {
        return $this->transaction(function (string $connection) use ($bucket, $now, $rate): bool {
            $table = $this->prefix . 'limits';
            $rows = $this->rows($this->sql("SELECT available_at FROM `$table` WHERE bucket = %s AND CONNECTION_ID() = %s", $bucket, $connection));
            if ($rows === []) {
                // Only expired limiter metadata is reclaimable; never documents.
                $this->query($this->sql("DELETE FROM `$table` WHERE available_at < %f AND CONNECTION_ID() = %s", $now - 3600, $connection));
                if ($this->bucketCount() >= self::MAX_BUCKETS) { return false; }
                if ($this->query($this->sql("INSERT INTO `$table` (bucket,available_at) SELECT %s,0 WHERE CONNECTION_ID() = %s", $bucket, $connection)) !== 1) {
                    throw new RuntimeException('Preview limiter insert lost its transaction');
                }
            }
            return $this->query($this->sql("UPDATE `$table` SET available_at = %f WHERE bucket = %s AND available_at <= %f AND CONNECTION_ID() = %s", $now + 1 / $rate, $bucket, $now, $connection)) === 1;
        });
    }

    private static function utf8Hex(string $value): string {
        if (preg_match('//u', $value) !== 1) { throw new PreviewQuotaExceeded('Preview document must be valid UTF-8'); }
        // ASCII-only parameters preserve quotes, controls (including NUL), empty
        // strings and supplementary code points without disabling wpdb checks.
        return bin2hex($value);
    }

    private function bytes(string $table, array $row, bool $validate = true): int {
        $bytes = 0;
        foreach (self::FIELDS[$table] as $field) {
            $value = $row[$field];
            $length = strlen($value); // UTF-8 bytes, not characters.
            if ($validate && $length > self::MAX_BYTES - $bytes) { throw new PreviewQuotaExceeded('Preview document exceeds the 8 MiB logical data quota'); }
            if ($validate && preg_match('//u', $value) !== 1) { throw new PreviewQuotaExceeded('Preview document must be valid UTF-8'); }
            $bytes += $length;
        }
        return $bytes;
    }

    private function admit(array $usage, int $bytes, int $documents): void {
        // Never evict data. A shrink/no-op may repair old over-budget data, but
        // no growth or new record may increase an already exhausted resource.
        if (($bytes > 0 && $usage['bytes'] > self::MAX_BYTES - $bytes)
            || ($documents > 0 && $usage['documents'] > self::MAX_DOCUMENTS - $documents)) {
            throw new PreviewQuotaExceeded('Preview data quota reached; existing documents remain available');
        }
    }

    private function usage(): array {
        $usage = ['bytes' => 0, 'documents' => 0];
        foreach (self::FIELDS as $table => $fields) {
            $sum = implode(' + ', array_map(static fn($field) => "OCTET_LENGTH($field)", $fields));
            $rows = $this->rows("SELECT COUNT(*) AS documents, COALESCE(SUM($sum),0) AS bytes FROM `{$this->prefix}{$table}`");
            if (count($rows) !== 1) { throw new RuntimeException('Preview usage unavailable'); }
            foreach ($usage as $key => $value) {
                $raw = (string) ($rows[0][$key] ?? '');
                // Saturate above the platform-safe bound. Refuse corrupt/huge
                // legacy aggregates rather than overflowing on wasm32 PHP.
                if (!preg_match('/\A[0-9]{1,9}\z/', $raw)) { throw new RuntimeException('Preview usage is out of range'); }
                $usage[$key] += (int) $raw;
                if ($usage[$key] > 1000000000) { throw new RuntimeException('Preview usage is out of range'); }
            }
        }
        return $usage;
    }

    private function bucketCount(): int {
        $rows = $this->rows("SELECT COUNT(*) AS buckets FROM `{$this->prefix}limits`");
        $value = (string) ($rows[0]['buckets'] ?? '');
        if (count($rows) !== 1 || !preg_match('/\A[0-9]{1,9}\z/', $value)) { throw new RuntimeException('Preview limiter usage unavailable'); }
        return (int) $value;
    }

    private function record(string $table, string $id, string $connection): array {
        $rows = $this->rows($this->sql("SELECT * FROM `{$this->prefix}{$table}` WHERE id = %s AND CONNECTION_ID() = %s", $id, $connection));
        if ($this->connection() !== $connection) { throw new RuntimeException('Preview transaction connection changed'); }
        if ($rows === []) { throw new OutOfBoundsException('record not found'); }
        if (count($rows) !== 1) { throw new RuntimeException('Invalid preview record'); }
        return $rows[0];
    }

    private function verify(string $table, array $expected, string $connection): void {
        $stored = $this->record($table, $expected['id'], $connection);
        foreach ($expected as $key => $value) {
            // Fail/rollback on non-strict SQL truncation or charset conversion.
            if (($stored[$key] ?? null) !== $value) { throw new RuntimeException('Preview document did not round-trip unchanged'); }
        }
    }

    private function transaction(callable $action, bool $initialize = false) {
        return $this->quiet(function () use ($action, $initialize) {
            $connection = $this->idle();
            $started = false;
            $committing = false;
            try {
                $this->query('START TRANSACTION');
                $started = true;
                $rows = $this->rows($this->sql("SELECT singleton_id, schema_version, CONNECTION_ID() AS connection_id FROM `{$this->prefix}quota` FOR UPDATE"));
                if ($initialize && $rows === []) {
                    if ($this->query($this->sql("INSERT INTO `{$this->prefix}quota` (singleton_id, schema_version) SELECT 1,1 WHERE CONNECTION_ID() = %s", $connection)) !== 1) {
                        throw new RuntimeException('Preview quota initialization lost its transaction');
                    }
                    $rows = $this->rows("SELECT singleton_id, schema_version, CONNECTION_ID() AS connection_id FROM `{$this->prefix}quota` FOR UPDATE");
                }
                if (count($rows) !== 1 || (string) ($rows[0]['singleton_id'] ?? '') !== '1'
                    || (string) ($rows[0]['schema_version'] ?? '') !== '1' || (string) ($rows[0]['connection_id'] ?? '') !== $connection) {
                    throw new RuntimeException('Preview quota is missing, corrupt or disconnected; run the selected-instance migration');
                }
                // Acquire metadata locks on all participating tables before
                // validating engines. This excludes concurrent non-InnoDB DDL.
                foreach (['pastes', 'diffs', 'snapshots', 'limits'] as $table) {
                    $this->rows("SELECT 1 FROM `{$this->prefix}{$table}` LIMIT 0");
                }
                $this->schema();
                $result = $action($connection);
                if ($this->connection() !== $connection) { throw new RuntimeException('Preview transaction connection changed'); }
                $committing = true;
                $this->query('COMMIT');
                $started = false;
                if ($this->connection() !== $connection) { throw new PreviewQuotaCommitUncertain('Preview commit outcome is unknown; read before retrying'); }
                return $result;
            } catch (Throwable $error) {
                if ($started) { try { $this->query('ROLLBACK'); } catch (Throwable $ignored) {} }
                if ($committing && !($error instanceof PreviewQuotaCommitUncertain)) {
                    throw new PreviewQuotaCommitUncertain('Preview commit outcome is unknown; read before retrying', 0, $error);
                }
                throw $error;
            }
        });
    }

    private function schema(): void {
        foreach (['pastes', 'diffs', 'snapshots', 'limits', 'quota'] as $table) {
            $rows = $this->rows($this->sql('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $this->prefix . $table));
            if (count($rows) !== 1 || ($rows[0]['ENGINE'] ?? '') !== 'InnoDB') { throw new RuntimeException('Preview quota requires InnoDB tables'); }
        }
        $columns = $this->rows("SHOW COLUMNS FROM `{$this->prefix}quota`");
        $expected = ['singleton_id' => ['tinyint unsigned', 'PRI'], 'schema_version' => ['smallint unsigned', '']];
        if (count($columns) !== 2) { throw new RuntimeException('Unsupported preview quota schema'); }
        foreach ($columns as $column) {
            $shape = $expected[$column['Field'] ?? ''] ?? null;
            if ($shape === null || ($column['Type'] ?? null) !== $shape[0] || ($column['Key'] ?? null) !== $shape[1]
                || ($column['Null'] ?? null) !== 'NO' || ($column['Extra'] ?? null) !== '' || ($column['Default'] ?? null) !== null) {
                throw new RuntimeException('Unsupported preview quota schema');
            }
            unset($expected[$column['Field']]);
        }
    }

    private function connection(): string {
        $rows = $this->rows('SELECT CONNECTION_ID() AS connection_id, @@session.autocommit AS autocommit');
        $id = (string) ($rows[0]['connection_id'] ?? '');
        if (count($rows) !== 1 || !preg_match('/\A[1-9][0-9]*\z/', $id) || (string) ($rows[0]['autocommit'] ?? '') !== '1') {
            throw new RuntimeException('Preview quota requires an autocommit connection');
        }
        return $id;
    }
    private function idle(): string {
        $connection = $this->connection();
        // Refuse a caller-owned transaction instead of implicitly committing it.
        $this->query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        return $connection;
    }
    private function sql(string $query, ...$args): string { return $args === [] ? $query : $this->db->prepare($query, ...$args); }
    private function query(string $query): int {
        $result = $this->db->query($query);
        if ($result === false || ($this->db->last_error ?? '') !== '') { throw new RuntimeException('Preview quota database operation failed'); }
        return (int) $result;
    }
    private function rows(string $query): array {
        $rows = $this->db->get_results($query, ARRAY_A);
        if (!is_array($rows) || ($this->db->last_error ?? '') !== '') { throw new RuntimeException('Preview quota database read failed'); }
        return $rows;
    }
    private function quiet(callable $action) {
        $previous = $this->db->suppress_errors(true);
        try { return $action(); }
        finally { $this->db->suppress_errors($previous); }
    }
}
