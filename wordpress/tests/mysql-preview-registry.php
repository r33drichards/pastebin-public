<?php
/** Protocol tests with a recording wpdb double, NOT MySQL/locking proof. */
require dirname(__DIR__) . '/preview/mysql-registry.php';
require __DIR__ . '/mysql-race-observer.php';
use Pbin\Preview\MysqlRegistry;
use Pbin\Preview\RegistryException;
use Pbin\Preview\RegistryConflict;
use Pbin\Preview\RegistryCommitUncertain;

function expect(bool $condition, string $label): void {
    if (!$condition) { throw new RuntimeException($label); }
}
function rejects(callable $action, string $class = RegistryException::class): void {
    try { $action(); } catch (Throwable $error) {
        expect($error instanceof $class, 'Wrong exception: ' . get_class($error)); return;
    }
    throw new RuntimeException('Expected rejection: ' . $class);
}
function desired(string $sha = 'a', array $extra = []): array {
    $revision = str_repeat($sha, 40);
    return ['enabled' => true, 'active' => $revision, 'releases' => $extra + [$revision => ['artifact_sha256' => str_repeat($sha, 64), 'manifest_sha256' => str_repeat('e', 64)]]];
}
final class RecordingWpdb {
    public string $base_prefix = 'wp_';
    public string $prefix = 'wp_unrelated_tenant_';
    public string $last_error = '';
    public bool $exists = false;
    public bool $suppressed = false;
    public bool $transaction = false;
    public string $engine = 'InnoDB';
    public string $collation = 'utf8mb4_bin';
    public int $connection = 10;
    public string $autocommit = '1';
    public string $state = '';
    public string $version = '2';
    public bool $extraRow = false;
    public array $queries = [];
    public array $columns;
    public ?string $fail = null;
    public ?string $reconnect = null;
    public array $dataTables = [];
    private ?string $before = null;
    public function __construct() {
        $this->columns = [];
        foreach (['singleton_id' => ['tinyint unsigned', 'PRI'], 'schema_version' => ['smallint unsigned', ''], 'state_json' => ['mediumtext', '']] as $name => $shape) {
            $this->columns[] = ['Field' => $name, 'Type' => $shape[0], 'Null' => 'NO', 'Key' => $shape[1], 'Default' => null, 'Extra' => ''];
        }
    }
    public function suppress_errors(bool $value): bool { $old = $this->suppressed; $this->suppressed = $value; return $old; }
    public function prepare(string $sql, ...$args): string {
        foreach ($args as $arg) { $sql = preg_replace_callback('/%s/', fn() => "'" . str_replace("'", "''", $arg) . "'", $sql, 1); }
        return $sql;
    }
    private function event(string $sql): bool {
        $this->queries[] = $sql; $this->last_error = '';
        if ($this->reconnect !== null && str_starts_with($sql, $this->reconnect)) {
            $this->reconnect = null; $this->connection++;
            if ($this->transaction && $this->before !== null) { $this->state = $this->before; }
            $this->transaction = false; $this->before = null;
        }
        if ($this->fail !== null && str_starts_with($sql, $this->fail)) {
            $this->fail = null; $this->last_error = 'test failure'; return false;
        }
        return true;
    }
    public function query(string $sql) {
        if (!$this->event($sql)) { return false; }
        if (str_starts_with($sql, 'CREATE TABLE')) { expect(!$this->exists, 'Already exists'); $this->exists = true; return 0; }
        if (str_starts_with($sql, 'INSERT INTO')) { preg_match("/VALUES \(1, 2, '(.*)'\)$/s", $sql, $matches); $this->state = str_replace("''", "'", $matches[1]); return 1; }
        if ($sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') {
            if ($this->transaction) { $this->last_error = 'already active'; return false; } return 0;
        }
        if ($sql === 'START TRANSACTION') { $this->before = $this->state; $this->transaction = true; return 0; }
        if ($sql === 'ROLLBACK') { if ($this->transaction) { $this->state = $this->before; } $this->transaction = false; return 0; }
        if ($sql === 'COMMIT') { $this->transaction = false; $this->before = null; return 0; }
        if (str_starts_with($sql, 'UPDATE')) {
            preg_match("/SET state_json = '(.*)' WHERE singleton_id = 1 AND schema_version = 2 AND CONNECTION_ID\(\) = '([0-9]+)'$/s", $sql, $matches);
            expect(count($matches) === 3, 'Mutation must be fenced by connection');
            if ((string) $this->connection !== $matches[2]) { return 0; }
            expect($this->transaction, 'Update must be in transaction');
            $this->state = str_replace("''", "'", $matches[1]); return 1;
        }
        throw new RuntimeException('Unexpected SQL: ' . $sql);
    }
    public function get_results(string $sql, string $format): ?array {
        expect($format === 'ARRAY_A', 'wpdb result format');
        if (!$this->event($sql)) { return null; }
        if (str_starts_with($sql, 'SELECT TABLE_NAME')) { return array_map(fn($table) => ['TABLE_NAME' => $table], $this->dataTables); }
        if (str_starts_with($sql, 'SELECT ENGINE')) { return $this->exists ? [['ENGINE' => $this->engine, 'TABLE_COLLATION' => $this->collation]] : []; }
        if (str_starts_with($sql, 'SHOW COLUMNS')) { return $this->columns; }
        if (str_starts_with($sql, 'SELECT CONNECTION_ID')) { return [['connection_id' => (string) $this->connection, 'autocommit' => $this->autocommit]]; }
        if (str_starts_with($sql, 'SELECT singleton_id')) {
            if ($this->state === '') { return []; }
            $row = ['singleton_id' => '1', 'schema_version' => $this->version, 'state_bytes' => (string) strlen($this->state), 'state_json' => $this->state, 'connection_id' => (string) $this->connection];
            return $this->extraRow ? [$row, $row] : [$row];
        }
        throw new RuntimeException('Unexpected read: ' . $sql);
    }
}
function fixture(array $limits = []): array {
    $db = new RecordingWpdb(); $registry = new MysqlRegistry($db, $limits); $registry->installSchema(); return [$db, $registry];
}

$count = 0;
function test(string $name, callable $action): void { global $count; $action(); ++$count; echo "PASS: $name\n"; }

test('missing table fails closed without implicit migration', function () {
    $db = new RecordingWpdb(); $registry = new MysqlRegistry($db);
    rejects(fn() => $registry->snapshot()); rejects(fn() => $registry->retire('pr-1', null));
    expect(!$db->exists && !$db->suppressed, 'Read created state or leaked error suppression');
});
test('explicit schema migration is idempotent and separate from tenant tables', function () {
    [$db, $registry] = fixture(); $old = $db->state; $registry->installSchema();
    expect($registry->snapshot() === ['version' => 2, 'tenants' => []] && $db->state === $old, 'Migration reset state');
    expect(!str_contains(implode("\n", $db->queries), $db->prefix), 'Used current tenant prefix');
});
test('prefix and constructor inputs are fail closed', function () {
    foreach (['x`; DROP TABLE wp_options;--', '', str_repeat('a', 44)] as $prefix) {
        $db = new RecordingWpdb(); $db->base_prefix = $prefix; rejects(fn() => new MysqlRegistry($db)); expect($db->queries === [], 'Unsafe prefix reached SQL');
    }
    rejects(fn() => new MysqlRegistry(new stdClass()));
    foreach ([['unknown' => 1], ['max_enabled' => 0], ['max_tenants' => 1025], ['max_releases' => '3']] as $limits) { rejects(fn() => new MysqlRegistry(new RecordingWpdb(), $limits)); }
});
test('canonical ten digit PR identifiers remain strings', function () {
    [$db, $registry] = fixture(); $registry->retire('pr-9999999999', null);
    foreach (['pr-0', 'pr-01', 'pr-10000000000', 'pr-1\n', 'pr-1`'] as $name) { rejects(fn() => $registry->retire($name, null)); }
});
test('first CAS creates random token and locks before writing', function () {
    [$db, $registry] = fixture(); $record = $registry->compareAndSwap('pr-1', null, desired());
    expect(preg_match('/\A[a-f0-9]{64}\z/', $record['state_token']) === 1, 'Bad token');
    expect($registry->tenant('pr-1') === $record && $registry->tenant('pr-2') === null, 'Read mismatch');
    $sql = implode("\n", $db->queries); expect(strpos($sql, 'FOR UPDATE') < strpos($sql, 'UPDATE `'), 'Unserialized mutation');
});
test('exact no-op checks CAS and preserves token and bytes', function () {
    [$db, $registry] = fixture(); $record = $registry->compareAndSwap('pr-1', null, desired()); $bytes = $db->state;
    expect($registry->compareAndSwap('pr-1', $record['state_token'], desired()) === $record && $db->state === $bytes, 'No-op rotated token');
    rejects(fn() => $registry->compareAndSwap('pr-1', null, desired()), RegistryConflict::class);
    rejects(fn() => $registry->compareAndSwap('pr-1', str_repeat('f', 64), desired()), RegistryConflict::class);
});
test('retire absence creates tombstone and fences stale installation', function () {
    [$db, $registry] = fixture(); $record = $registry->retire('pr-1', null);
    expect(!$record['enabled'] && $record['active'] === null && $record['releases'] === [], 'Not a tombstone');
    rejects(fn() => $registry->compareAndSwap('pr-1', null, desired()), RegistryConflict::class);
    expect($registry->retire('pr-1', $record['state_token']) === $record, 'Repeated retirement rotated token');
});
test('retire retains artifacts and must use current token', function () {
    [$db, $registry] = fixture(); $record = $registry->compareAndSwap('pr-1', null, desired());
    rejects(fn() => $registry->retire('pr-1', null), RegistryConflict::class);
    $retired = $registry->retire('pr-1', $record['state_token']);
    expect(!$retired['enabled'] && $retired['releases'] === $record['releases'] && $retired['state_token'] !== $record['state_token'], 'Retirement lost state');
});
test('A B A pointer transitions cannot reuse token', function () {
    [$db, $registry] = fixture(); $a = $registry->compareAndSwap('pr-1', null, desired());
    $b = $registry->compareAndSwap('pr-1', $a['state_token'], desired('b', $a['releases']));
    $again = $registry->compareAndSwap('pr-1', $b['state_token'], desired('a', $b['releases']));
    expect($again['active'] === $a['active'] && count(array_unique([$a['state_token'], $b['state_token'], $again['state_token']])) === 3, 'ABA reused token');
    rejects(fn() => $registry->retire('pr-1', $a['state_token']), RegistryConflict::class);
});
test('retained metadata cannot be replaced or deleted', function () {
    [$db, $registry] = fixture(); $record = $registry->compareAndSwap('pr-1', null, desired()); $bytes = $db->state;
    $bad = desired(); $bad['releases'][str_repeat('a', 40)]['artifact_sha256'] = str_repeat('f', 64);
    rejects(fn() => $registry->compareAndSwap('pr-1', $record['state_token'], $bad));
    rejects(fn() => $registry->compareAndSwap('pr-1', $record['state_token'], desired('b')));
    expect($db->state === $bytes, 'Rejected mutation changed state');
});
test('strict record fields, hashes, booleans and tombstone shape', function () {
    [$db, $registry] = fixture(); $cases = [];
    $cases[] = desired() + ['state_token' => str_repeat('f', 64)];
    $bad = desired(); $bad['enabled'] = 1; $cases[] = $bad;
    $bad = desired(); $bad['active'] = null; $cases[] = $bad;
    $bad = desired(); $bad['active'] = str_repeat('b', 40); $cases[] = $bad;
    $bad = desired(); $bad['releases'][str_repeat('a', 40)]['manifest_sha256'] = str_repeat('A', 64); $cases[] = $bad;
    $cases[] = ['enabled' => false, 'active' => null, 'releases' => [str_repeat('a', 40) => desired()['releases'][str_repeat('a', 40)]]];
    foreach ($cases as $case) { rejects(fn() => $registry->compareAndSwap('pr-1', null, $case)); }
    expect($registry->tenant('pr-1') === null, 'Invalid record committed');
});
test('enabled, release and tombstone bounds are enforced atomically', function () {
    [$db, $registry] = fixture(['max_enabled' => 1, 'max_releases' => 1, 'max_tenants' => 2]);
    $a = $registry->compareAndSwap('pr-1', null, desired());
    rejects(fn() => $registry->compareAndSwap('pr-2', null, desired()));
    rejects(fn() => $registry->compareAndSwap('pr-1', $a['state_token'], desired('b', $a['releases'])));
    $registry->retire('pr-2', null); rejects(fn() => $registry->retire('pr-3', null));
    expect($registry->tenant('pr-1') === $a, 'Admission failure changed existing state');
});
test('two retained data tenants exhaust capacity even after retirement', function () {
    [$db, $registry] = fixture();
    $one = $registry->compareAndSwap('pr-1', null, desired());
    $registry->retire('pr-1', $one['state_token']);
    for ($i = 10; $i < 30; ++$i) { $registry->retire('pr-' . $i, null); }
    $two = $registry->compareAndSwap('pr-2', null, desired());
    $two = $registry->retire('pr-2', $two['state_token']);
    $before = $db->state;
    rejects(fn() => $registry->compareAndSwap('pr-3', null, desired()));
    expect($db->state === $before, 'Third data tenant changed retained state');
    $registry->compareAndSwap('pr-2', $two['state_token'], desired('b', $two['releases']));
    expect(count($registry->snapshot()['tenants']) === 22, 'Tombstones incorrectly consumed data slots');
});
test('provisioning inventory rejects unregistered, tombstone and foreign tables', function () {
    [$db, $registry] = fixture();
    $db->prefix = 'wp_';
    $registry->assertDataInventory();
    foreach (['wp_pbin_pr_1_pastes', 'wp_pbin_pr_01_pastes', 'foreign_pbin_pr_1_pastes', 'wp_pbin_pr_1_unknown'] as $table) {
        $db->dataTables = [$table]; rejects(fn() => $registry->assertDataInventory());
    }
    $db->dataTables = ['wp_pbin_pr_1_pastes'];
    $tombstone = $registry->retire('pr-1', null); rejects(fn() => $registry->assertDataInventory());
    $record = $registry->compareAndSwap('pr-1', $tombstone['state_token'], desired());
    $registry->assertDataInventory();
    $registry->retire('pr-1', $record['state_token']); $registry->assertDataInventory();
    $db->dataTables[] = 'wp_pbin_pr_2_quota'; rejects(fn() => $registry->assertDataInventory());
    expect(count($db->dataTables) === 2, 'Inventory modified tables');
});
test('corrupt JSON, duplicate keys, unknown version and extra rows fail closed', function () {
    foreach (['{', '{"version":2,"tenants":[],"extra":0}', '{"version":2,"tenants":{},"version":2}', '{"version":3,"tenants":{}}', ' {"version":2,"tenants":{}}', str_repeat('x', 1048577)] as $json) {
        [$db, $registry] = fixture(); $db->state = $json; rejects(fn() => $registry->snapshot()); rejects(fn() => $registry->retire('pr-1', null));
    }
    [$db, $registry] = fixture(); $db->version = '3'; rejects(fn() => $registry->snapshot());
    [$db, $registry] = fixture(); $db->extraRow = true; rejects(fn() => $registry->snapshot());
    [$db, $registry] = fixture(); $db->state = ''; rejects(fn() => $registry->installSchema());
});
test('nontransactional and unknown table schemas are refused', function () {
    [$db, $registry] = fixture(); $db->engine = 'MyISAM'; rejects(fn() => $registry->snapshot());
    [$db, $registry] = fixture(); $db->columns[0]['Key'] = ''; rejects(fn() => $registry->snapshot());
    [$db, $registry] = fixture(); $db->columns[0]['Extra'] = 'auto_increment'; rejects(fn() => $registry->snapshot());
});
test('nested transaction and autocommit off are not silently committed', function () {
    [$db, $registry] = fixture(); $db->transaction = true;
    rejects(fn() => $registry->retire('pr-1', null)); expect($db->transaction, 'Caller transaction lost');
    rejects(fn() => $registry->installSchema()); expect($db->transaction, 'DDL committed caller transaction');
    [$db, $registry] = fixture(); $db->autocommit = '0'; rejects(fn() => $registry->retire('pr-1', null));
});
test('database read/update failures roll back and restore suppression', function () {
    foreach (['SELECT singleton_id', 'UPDATE'] as $failure) {
        [$db, $registry] = fixture(); $before = $db->state; $db->fail = $failure;
        rejects(fn() => $registry->retire('pr-1', null)); expect($db->state === $before && !$db->transaction && !$db->suppressed, 'Failed mutation escaped transaction');
    }
});
test('wpdb reconnect before lock or update cannot write unlocked', function () {
    foreach (['START TRANSACTION', 'SELECT singleton_id', 'UPDATE'] as $phase) {
        [$db, $registry] = fixture(); $before = $db->state; $db->reconnect = $phase;
        rejects(fn() => $registry->retire('pr-1', null)); expect($db->state === $before, 'Reconnect changed state without lock');
    }
});
test('failed or replayed COMMIT is explicitly uncertain', function () {
    [$db, $registry] = fixture(); $db->fail = 'COMMIT';
    rejects(fn() => $registry->retire('pr-1', null), RegistryCommitUncertain::class);
    [$db, $registry] = fixture(); $db->reconnect = 'COMMIT';
    rejects(fn() => $registry->retire('pr-1', null), RegistryCommitUncertain::class);
});
test('race observer requires both exact live row-lock dependencies, not cached INNODB_TRX', function () {
    $sql = Pbin\Preview\Tests\RaceObserver::query(new RecordingWpdb(), ['12', '13'], '11', 'wp_pbin_preview_registry');
    expect(str_contains($sql, 'performance_schema.data_lock_waits') && str_contains($sql, 'performance_schema.threads') && str_contains($sql, 'performance_schema.data_locks'), 'Missing live dependency proof');
    expect(str_contains($sql, "requested.LOCK_STATUS = 'WAITING'") && str_contains($sql, "requested.LOCK_TYPE = 'RECORD'") && str_contains($sql, 'blocking.PROCESSLIST_ID = 11'), 'Missing exact held-row constraints');
    expect(!str_contains($sql, 'information_schema.INNODB_TRX'), 'Observer reintroduced stale last-read cache');
    expect(Pbin\Preview\Tests\RaceObserver::allWaiting([['connection_id' => 13], ['connection_id' => '12']], ['12', '13']), 'Distinct exact writer proof rejected');
    foreach ([[], [['connection_id' => 12]], [['connection_id' => 12], ['connection_id' => 12]], [['connection_id' => 12], ['connection_id' => 14]]] as $rows) {
        expect(!Pbin\Preview\Tests\RaceObserver::allWaiting($rows, ['12', '13']), 'Incomplete/unrelated waiting set accepted');
    }
});
test('race diagnostics never replay raw stdout, stderr, registry tokens or credentials', function () {
    $secret = 'synthetic-secret-not-for-logs';
    $raw = "arbitrary credential " . $secret . "\n" . json_encode(['outcome' => 'refused', 'type' => 'Pbin\\Preview\\RegistryException', 'record' => ['state_token' => $secret], 'message' => $secret]) . "\nWORKER_ERROR " . json_encode(['class' => 'Error', 'file' => 'fixture.php', 'line' => 42, 'category' => 'missing_function', 'message' => $secret]);
    $raw .= "\n" . json_encode(array_fill_keys(['class', 'type', 'file', 'outcome', 'reason', 'category'], $secret));
    $summary = json_encode(Pbin\Preview\Tests\RaceObserver::output($raw));
    expect(!str_contains($summary, $secret) && !str_contains($summary, 'state_token'), 'Diagnostics exposed arbitrary runtime data');
    expect(str_contains($summary, 'missing_function') && str_contains($summary, 'fixture.php') && str_contains($summary, 'refused'), 'Safe failure context missing');
});
echo "PASS: $count wpdb-double protocol groups; no real MySQL/locking claim\n";
