<?php
require dirname(__DIR__) . '/importer.php';
use Pbin\Migration\ExportFile;
use Pbin\Migration\Destination;
use Pbin\Migration\Importer;
use Pbin\Migration\WpdbDestination;
use Pbin\Migration\MigrationException;
use Pbin\Migration\CommitUncertain;

function check(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
function refuses(callable $action, string $class = MigrationException::class): void {
    try { $action(); } catch (Throwable $error) { check($error instanceof $class, 'Unexpected error: ' . get_class($error) . ' ' . $error->getMessage()); return; }
    throw new RuntimeException('Expected refusal');
}
function encodeFixture(array $data): ExportFile {
    $raw = ExportFile::json($data); return ExportFile::parse($raw, hash('sha256', $raw));
}

final class MemoryDestination implements Destination {
    public array $rows = ['pastes' => [], 'diffs' => [], 'snapshots' => []];
    public array $operations = [];
    public ?array $saved = null;
    public int $failInsert = 0;
    public int $inserts = 0;
    public bool $corruptInsert = false;
    public bool $uncertain = false;
    public bool $commitReallyHappened = false;
    public string $target = 'synthetic-target';
    public function identity(): string { return hash('sha256', $this->target); }
    public function schema(): void { $this->operations[] = 'schema'; }
    public function counts(): array { return array_map('count', $this->rows); }
    public function read(string $kind, string $id, bool $lock): ?array { return $this->rows[$kind][$id] ?? null; }
    public function checkInsert(string $kind, array $fields): void {}
    public function begin(): void { check($this->saved === null, 'Nested fake transaction'); $this->operations[] = 'begin'; $this->saved = $this->rows; }
    public function insert(string $kind, array $fields): void {
        check($this->saved !== null, 'Insert outside transaction'); $this->operations[] = 'insert'; $this->inserts++;
        if ($this->inserts === $this->failInsert) { throw new MigrationException('Injected mid-import failure'); }
        check(!isset($this->rows[$kind][$fields[0]]), 'Would overwrite existing data');
        if ($this->corruptInsert) { $fields[count($fields) - 1] .= 'corruption'; }
        $this->rows[$kind][$fields[0]] = $fields;
    }
    public function commit(): void {
        $this->operations[] = 'commit';
        if ($this->commitReallyHappened) { $this->saved = null; }
        if ($this->uncertain) { throw new CommitUncertain('Injected lost commit receipt'); }
        $this->saved = null;
    }
    public function rollback(): void { $this->operations[] = 'rollback'; if ($this->saved !== null) { $this->rows = $this->saved; $this->saved = null; } }
}

$path = $argv[1] ?? __DIR__ . '/synthetic.json';
$export = ExportFile::read($path, hash_file('sha256', $path));
check($export->data['counts'] === ['pastes' => 2, 'diffs' => 1, 'snapshots' => 2], 'Wrong Go fixture counts');
check($export->data['content_sha256'] === '77ee8fb3b1e75997c45b7d8674a567b77e1b0822ca0865c51f9a47a46d95d061', 'Synthetic source content changed');
check(str_contains($export->data['records'][0]['fields'][3], "😀\r\n<script>&\"\\/\t\0\u{2028}\u{2029}"), 'Unicode/control fixture changed');
check($export->data['records'][3]['fields'][1] === '2038-01-19T03:14:08.123456789Z', 'Nanosecond precision changed');

$target = new MemoryDestination(); $importer = new Importer($target);
$before = $target->rows; $plan = $importer->reconcile($export);
check($target->rows === $before && $target->operations === ['schema'], 'Dry run mutated target or started a transaction');
check($plan['rows'] === ['insert' => 5, 'identical' => 0, 'conflict' => 0], 'Incorrect dry-run counts');
check($importer->reconcile($export) === $plan, 'Plan is nondeterministic');
refuses(fn() => $importer->apply($export, $plan['plan_sha256'], false));
check($target->rows === $before, 'Missing confirmation mutated rows');
$applied = $importer->apply($export, $plan['plan_sha256'], true);
check($applied['inserted_counts'] === $export->data['counts'], 'Wrong inserted counts');
foreach ($export->data['records'] as $record) { check($target->rows[$record['kind']][$record['fields'][0]] === $record['fields'], 'Bytes/relationships changed'); }
$rerun = $importer->reconcile($export); check($rerun['rows'] === ['insert' => 0, 'identical' => 5, 'conflict' => 0], 'Rerun not idempotent');
$inserts = $target->inserts; $importer->apply($export, $rerun['plan_sha256'], true); check($target->inserts === $inserts, 'Identical rows were rewritten');
refuses(fn() => $importer->apply($export, $plan['plan_sha256'], true));

$target = new MemoryDestination(); $first = $export->data['records'][0]; $row = $first['fields']; $row[3] = 'conflicting synthetic text';
$target->rows['pastes'][$row[0]] = $row; $original = $target->rows; $importer = new Importer($target); $plan = $importer->reconcile($export);
check($plan['rows']['conflict'] === 1 && count($plan['conflict_samples']) === 1, 'Conflict not reported');
check(!str_contains(ExportFile::json($plan), 'conflicting synthetic text'), 'Report leaked content');
refuses(fn() => $importer->apply($export, $plan['plan_sha256'], true)); check($target->rows === $original && $target->inserts === 0, 'Conflict changed existing data');

foreach ([1, 2, 3, 4, 5] as $failure) {
    $target = new MemoryDestination(); $target->failInsert = $failure; $importer = new Importer($target); $plan = $importer->reconcile($export); $before = $target->rows;
    refuses(fn() => $importer->apply($export, $plan['plan_sha256'], true)); check($target->rows === $before, 'Interrupted apply left partial data');
    $target->failInsert = 0; $retry = $importer->reconcile($export); $importer->apply($export, $retry['plan_sha256'], true);
    check($target->counts() === $export->data['counts'], 'Reconciled retry failed');
}
$target = new MemoryDestination(); $target->corruptInsert = true; $importer = new Importer($target); $plan = $importer->reconcile($export); $before = $target->rows;
refuses(fn() => $importer->apply($export, $plan['plan_sha256'], true)); check($target->rows === $before, 'Failed readback not rolled back');

foreach ([false, true] as $reallyCommitted) {
    $target = new MemoryDestination(); $target->uncertain = true; $target->commitReallyHappened = $reallyCommitted;
    $importer = new Importer($target); $plan = $importer->reconcile($export);
    refuses(fn() => $importer->apply($export, $plan['plan_sha256'], true), CommitUncertain::class);
    $reconcile = $importer->reconcile($export); check($reconcile['rows'][$reallyCommitted ? 'identical' : 'insert'] === 5, 'Uncertain commit reconciliation incorrect');
}

$target = new MemoryDestination(); $unrelated = $first['fields']; $unrelated[0] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
$target->rows['pastes'][$unrelated[0]] = $unrelated; $importer = new Importer($target); $plan = $importer->reconcile($export);
$importer->apply($export, $plan['plan_sha256'], true); check($target->rows['pastes'][$unrelated[0]] === $unrelated, 'Unrelated row changed');
$target = new MemoryDestination(); $importer = new Importer($target); $plan = $importer->reconcile($export); $target->target = 'different-target';
refuses(fn() => $importer->apply($export, $plan['plan_sha256'], true)); check($target->inserts === 0, 'Plan not bound to destination');

$base = $export->data;
$mutations = [
    function (&$d) { $d['format'] = 'future-format'; },
    function (&$d) { $d['counts']['pastes'] = 3; },
    function (&$d) { $d['records'][0]['fields'][3] .= '!'; },
    function (&$d) { $d['records'][0]['fields'][4] = null; },
    function (&$d) { unset($d['records'][0]['fields'][4]); },
    function (&$d) { $d['records'][0]['unknown'] = 'x'; },
    function (&$d) { $d['records'][1] = $d['records'][0]; },
    function (&$d) { $d['records'][3]['fields'][2] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    function (&$d) { $d['records'][0]['fields'][1] = '2026-02-30T00:00:00Z'; },
    function (&$d) { $d['records'][0]['fields'][1] = '2026-02-28T00:00:00+24:00'; },
    function (&$d) { $d['records'][0]['fields'][1] = '2026-02-28T00:00:00.123456789+01:00'; },
    function (&$d) { $d['records'][0]['fields'][3] = str_repeat('x', ExportFile::MAX_RECORD_BYTES); },
];
foreach ($mutations as $change) { $data = $base; $change($data); refuses(fn() => encodeFixture($data)); }
$raw = file_get_contents($path);
refuses(fn() => ExportFile::parse($raw, str_repeat('0', 64)));
foreach ([str_replace('"format":', '"format":"discarded-duplicate","format":', $raw), ' ' . $raw, str_replace('😀', '\ud83d\ude00', $raw)] as $bad) {
    refuses(fn() => ExportFile::parse($bad, hash('sha256', $bad)));
}
echo "PASS: Go/PHP byte compatibility, read-only dry run, exact apply, idempotence, conflicts, plan binding, interrupted rollback, uncertain commits, bounds and Unicode\n";

/** Adapter unit double: verifies issued SQL and reconnection fencing. Not MySQL. */
final class SqlFixture {
    public string $prefix = 'wp_'; public string $last_error = ''; public array $queries = [];
    public string $connection = '123'; public ?string $guard = null; public bool $reconnectInsert = false;
    public bool $lostCommit = false; public bool $guardFails = false; public bool $strict = true;
    public bool $triggers = false; public bool $triggerVisibility = true; public int $packet = 67108864;
    public function suppress_errors(bool $value): bool { return true; }
    public function prepare(string $sql, ...$args): string {
        $i = 0; return preg_replace_callback('/%s/', function () use ($args, &$i) { return "'" . str_replace(["\\", "'"], ["\\\\", "\\'"], (string) $args[$i++]) . "'"; }, $sql);
    }
    public function query(string $sql) {
        $this->queries[] = $sql; $this->last_error = '';
        if (str_starts_with($sql, 'SET @pbin_migration_guard')) {
            if ($this->guardFails) { $this->last_error = 'fake'; return false; }
            preg_match("/ = '([a-f0-9]{64})'/", $sql, $m); $this->guard = $m[1];
        }
        if (str_starts_with($sql, 'SET SESSION sql_mode')) { $this->strict = true; }
        if (str_starts_with($sql, 'INSERT INTO')) {
            check(str_contains($sql, "WHERE CONNECTION_ID() = '123' AND @pbin_migration_guard = '" . $this->guard . "'"), 'Insert has no exact connection/token fence');
            check(!str_contains($sql, 'IGNORE') && !str_contains($sql, 'REPLACE'), 'Unsafe collision semantics');
            if ($this->reconnectInsert) { $this->connection = '124'; $this->guard = null; return 0; } return 1;
        }
        if ($sql === 'COMMIT' && $this->lostCommit) { $this->connection = '124'; $this->guard = null; }
        return 0;
    }
    public function get_results(string $sql, string $format): array {
        $this->queries[] = $sql; $this->last_error = '';
        if (str_starts_with($sql, 'SELECT CONNECTION_ID()')) { return [['connection_id' => $this->connection, 'autocommit' => '1', 'sql_mode' => $this->strict ? 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION' : '', 'client_charset' => 'utf8mb4', 'connection_charset' => 'utf8mb4', 'results_charset' => 'utf8mb4', 'packet' => (string) $this->packet, 'migration_guard' => $this->guard]]; }
        if ($sql === 'SELECT DATABASE() AS database_name') { return [['database_name' => 'synthetic']]; }
        if ($sql === 'SHOW GRANTS FOR CURRENT_USER') { return [['grant' => $this->triggerVisibility ? 'GRANT SELECT, INSERT, TRIGGER ON `synthetic`.* TO `fixture`@`localhost`' : 'GRANT SELECT, INSERT ON `synthetic`.* TO `fixture`@`localhost`']]; }
        if (str_contains($sql, 'information_schema.TABLES ')) { return [['ENGINE' => 'InnoDB', 'TABLE_TYPE' => 'BASE TABLE', 'TABLE_COLLATION' => 'utf8mb4_unicode_ci']]; }
        $kind = str_contains($sql, 'wp_pbin_snapshots') ? 'snapshots' : (str_contains($sql, 'wp_pbin_diffs') ? 'diffs' : 'pastes');
        if (str_contains($sql, 'information_schema.COLUMNS ')) {
            return array_map(function ($name) { $id = in_array($name, ['id', 'paste_id'], true); return ['COLUMN_NAME' => $name, 'COLUMN_TYPE' => $id ? 'varchar(36)' : ($name === 'created_at' ? 'varchar(30)' : 'longtext'), 'IS_NULLABLE' => 'NO', 'COLUMN_DEFAULT' => null, 'EXTRA' => '', 'CHARACTER_SET_NAME' => $id ? 'ascii' : 'utf8mb4', 'COLLATION_NAME' => $id ? 'ascii_bin' : 'utf8mb4_unicode_ci']; }, ExportFile::COLUMNS[$kind]);
        }
        if (str_starts_with($sql, 'SHOW INDEX')) {
            $rows = [['Key_name' => 'PRIMARY', 'Seq_in_index' => '1', 'Column_name' => 'id', 'Non_unique' => '0', 'Sub_part' => null, 'Index_type' => 'BTREE']];
            if ($kind === 'snapshots') { foreach (['paste_id', 'created_at', 'id'] as $i => $column) { $rows[] = ['Key_name' => 'paste_created', 'Seq_in_index' => (string) ($i+1), 'Column_name' => $column, 'Non_unique' => '1', 'Sub_part' => null, 'Index_type' => 'BTREE']; } } return $rows;
        }
        if (str_contains($sql, 'information_schema.TRIGGERS')) { return $this->triggers ? [['TRIGGER_NAME' => 'unsafe']] : []; }
        if (str_contains($sql, 'information_schema.TABLE_CONSTRAINTS')) { return []; }
        if ($sql === 'SELECT @@warning_count AS warning_count') { return [['warning_count' => '0']]; }
        throw new RuntimeException('Unimplemented adapter fixture query');
    }
}
function adapter(SqlFixture $db, string $prefix = 'wp_pbin_'): WpdbDestination { return new WpdbDestination($db, $prefix, hash('sha256', 'test'), 'synthetic'); }
$db = new SqlFixture(); $destination = adapter($db); $destination->schema();
foreach ($db->queries as $query) { check(str_starts_with($query, 'SELECT') || str_starts_with($query, 'SHOW'), 'Schema dry run mutated database'); }
$destination->begin(); $destination->insert('pastes', $first['fields']); $destination->commit();
check(in_array('COMMIT', $db->queries, true), 'No commit');
refuses(fn() => adapter(new SqlFixture(), 'wp_pbin_pr_123_'));
$db = new SqlFixture(); $db->strict = false; $destination = adapter($db); $destination->schema(); check(!$db->strict, 'Dry run enabled strict mode'); $destination->begin(); check($db->strict, 'Apply did not enable strict mode'); $destination->rollback();
$db = new SqlFixture(); $db->triggerVisibility = false; refuses(fn() => adapter($db)->schema());
$db = new SqlFixture(); $db->triggers = true; refuses(fn() => adapter($db)->schema());
$db = new SqlFixture(); $db->packet = 1024; $destination = adapter($db); $destination->schema(); refuses(fn() => $destination->checkInsert('pastes', $first['fields']));
$db = new SqlFixture(); $destination = adapter($db); $destination->begin(); $db->reconnectInsert = true;
refuses(fn() => $destination->insert('pastes', $first['fields'])); $destination->rollback(); check(in_array('ROLLBACK', $db->queries, true), 'No rollback on reconnect');
$db = new SqlFixture(); $destination = adapter($db); $db->guardFails = true;
refuses(fn() => $destination->begin()); check(in_array('ROLLBACK', $db->queries, true), 'Guard failure left a transaction open');
$db = new SqlFixture(); $destination = adapter($db); $destination->begin(); $db->lostCommit = true;
refuses(fn() => $destination->commit(), CommitUncertain::class); $destination->rollback();
echo "PASS: adapter read-only admission, default-table restriction, schema/trigger/packet refusal, connection/token-fenced inserts and uncertain commit handling (SQL double, not MySQL)\n";
