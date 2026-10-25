<?php
/** Real WordPress wpdb/MySQL gate; run only through check-mysql-preview-registry.sh. */
require __DIR__ . '/mysql-race-observer.php';
use Pbin\Preview\Tests\RaceObserver;
if (($argv[1] ?? '') === 'worker') {
    set_exception_handler(static function (Throwable $error): void {
        fwrite(STDERR, 'WORKER_ERROR ' . json_encode(RaceObserver::error($error), JSON_THROW_ON_ERROR) . "\n"); exit(1);
    });
    register_shutdown_function(static function (): void {
        $error = error_get_last();
        if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
            fwrite(STDERR, 'WORKER_ERROR ' . json_encode(['class' => 'PHPFatal', 'file' => basename($error['file']), 'line' => $error['line'], 'category' => RaceObserver::category($error['message'])], JSON_THROW_ON_ERROR) . "\n");
        }
    });
}
function verify(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
$pbinRegistryFixture = getenv('PBIN_WP_FIXTURE') ?: '';
$pbinRegistryLoad = getenv('PBIN_WORDPRESS_LOAD') ?: '';
$pbinRegistryDatabase = getenv('PBIN_TEST_DB_NAME') ?: '';
verify(getenv('PBIN_TEST_ALLOW_DATABASE_MUTATION') === '1', 'Explicit disposable mutation flag required');
verify(is_dir($pbinRegistryFixture) && realpath($pbinRegistryFixture) === $pbinRegistryFixture && str_contains($pbinRegistryFixture, '/pbin-wp-ci.'), 'Expected canonical disposable fixture');
verify($pbinRegistryLoad === $pbinRegistryFixture . '/site/wp-load.php' && realpath($pbinRegistryLoad) === $pbinRegistryLoad, 'Expected fixture WordPress core');
verify(preg_match('/\Apbin_ci_[a-f0-9]{24}\z/', $pbinRegistryDatabase) === 1, 'Expected random disposable database');
// Boot core wpdb, not active or branch plugins. No public route is introduced.
define('SHORTINIT', true);
require $pbinRegistryLoad;
verify(defined('DB_NAME') && DB_NAME === $pbinRegistryDatabase, 'Wrong database');
verify(defined('DB_HOST') && preg_match('/\A(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\z/', DB_HOST) === 1, 'Expected local MySQL fixture');
require dirname(__DIR__) . '/preview/mysql-registry.php';
use Pbin\Preview\MysqlRegistry;
use Pbin\Preview\RegistryException;
use Pbin\Preview\RegistryConflict;
use Pbin\Preview\RegistryCommitUncertain;

function releaseState(string $letter, array $retained = []): array {
    return ['enabled' => true, 'active' => str_repeat($letter, 40), 'releases' => $retained + [str_repeat($letter, 40) => ['artifact_sha256' => str_repeat($letter, 64), 'manifest_sha256' => str_repeat('e', 64)]]];
}
function refusal(callable $operation, string $type = RegistryException::class): void {
    try { $operation(); } catch (Throwable $error) { verify($error instanceof $type, 'Unexpected failure type: ' . get_class($error)); return; }
    throw new RuntimeException('Expected refusal: ' . $type);
}
function sql(string $query): void {
    global $wpdb;
    verify($wpdb->query($query) !== false && $wpdb->last_error === '', 'Fixture SQL failed');
}
function fingerprints(array $excluded): array {
    global $wpdb;
    $result = [];
    $tables = $wpdb->get_col('SHOW TABLES');
    verify(is_array($tables) && $wpdb->last_error === '', 'Cannot enumerate ordinary fixture tables');
    foreach ($tables as $table) {
        verify(preg_match('/\A[a-zA-Z0-9_]+\z/', $table) === 1, 'Unsafe fixture table');
        if (in_array($table, $excluded, true)) { continue; }
        $rows = $wpdb->get_results("SELECT * FROM `$table`", ARRAY_A);
        verify(is_array($rows) && $wpdb->last_error === '', 'Cannot read ordinary fixture data');
        $encoded = array_map(fn($row) => json_encode($row, JSON_THROW_ON_ERROR), $rows);
        sort($encoded, SORT_STRING); $result[$table] = hash('sha256', json_encode($encoded, JSON_THROW_ON_ERROR));
    }
    ksort($result, SORT_STRING); return $result;
}

$pbinRegistryMode = $argv[1] ?? 'run';
$pbinRegistryPrefixRoot = $wpdb->base_prefix . 'registry_fixture_';
$fixtureRegistryTables = [];
function fixtureRegistry(string $tag, bool $install = true): MysqlRegistry {
    global $wpdb, $table, $pbinRegistryPrefixRoot, $fixtureRegistryTables;
    verify(in_array($tag, ['main', 'absent', 'upgrade', 'enabled', 'retained'], true), 'Unknown registry fixture scope');
    $wpdb->set_prefix($pbinRegistryPrefixRoot . $tag . '_');
    $table = $wpdb->base_prefix . 'pbin_preview_registry';
    verify($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) === null, 'Refusing to reuse a registry fixture table');
    $fixtureRegistryTables[] = $table;
    $registry = new MysqlRegistry($wpdb, ['max_enabled' => 1]);
    if ($install) { $registry->installSchema(); }
    return $registry;
}
if ($pbinRegistryMode === 'worker') {
    $request = json_decode($argv[2] ?? '', true, 16, JSON_THROW_ON_ERROR);
    $prefix = $request['registry_prefix'] ?? '';
    verify(is_string($prefix) && in_array($prefix, array_map(fn($tag) => $pbinRegistryPrefixRoot . $tag . '_', ['main', 'absent', 'upgrade', 'enabled', 'retained']), true), 'Invalid worker registry fixture scope');
    $wpdb->set_prefix($prefix);
    $registry = new MysqlRegistry($wpdb, ['max_enabled' => 1]);
    echo "READY:" . $wpdb->get_var('SELECT CONNECTION_ID()') . "\n"; flush();
    try {
        $record = $request['operation'] === 'retire'
            ? $registry->retire($request['tenant'], $request['token'])
            : $registry->compareAndSwap($request['tenant'], $request['token'], $request['desired']);
        echo json_encode(['outcome' => 'committed', 'record' => $record], JSON_THROW_ON_ERROR) . "\n";
    } catch (RegistryConflict $error) { echo "{\"outcome\":\"conflict\"}\n"; }
    catch (RegistryException $error) { echo json_encode(['outcome' => in_array($error->getMessage(), ['Enabled tenant bound exceeded', 'Retained data tenant bound exceeded'], true) ? 'quota' : 'refused', 'type' => get_class($error), 'reason' => RaceObserver::category($error->getMessage())], JSON_THROW_ON_ERROR) . "\n"; }
    exit;
}
verify($pbinRegistryMode === 'run', 'Unknown integration mode');
$before = fingerprints([]);
$registry = fixtureRegistry('main', false);
refusal(fn() => $registry->snapshot());
$registry->installSchema(); $registry->installSchema();
verify($registry->snapshot() === ['version' => 2, 'tenants' => []], 'Expected empty registry');
$a = $registry->compareAndSwap('pr-910010', null, releaseState('a'));
verify($registry->compareAndSwap('pr-910010', $a['state_token'], releaseState('a')) === $a, 'Exact no-op changed token');
refusal(fn() => $registry->compareAndSwap('pr-910010', null, releaseState('a')), RegistryConflict::class);
$b = $registry->compareAndSwap('pr-910010', $a['state_token'], releaseState('b', $a['releases']));
$again = $registry->compareAndSwap('pr-910010', $b['state_token'], releaseState('a', $b['releases']));
verify($again['state_token'] !== $a['state_token'], 'ABA not fenced');
refusal(fn() => $registry->retire('pr-910010', $a['state_token']), RegistryConflict::class);
$retired = $registry->retire('pr-910010', $again['state_token']);
verify(!$retired['enabled'] && $retired['releases'] === $again['releases'], 'Retire discarded releases');
$tombstone = $registry->retire('pr-9999999999', null);
verify($tombstone['active'] === null && !$tombstone['enabled'], 'Missing absence tombstone');
refusal(fn() => $registry->compareAndSwap('pr-9999999999', null, releaseState('a')), RegistryConflict::class);
echo "PASS: real MySQL round-trip, exact no-op, tombstones, retirement and ABA fencing\n";

function race(array $requests): array {
    global $wpdb, $table;
    // Hold the actual database row while independent PHP/wpdb connections start.
    // This forces both contenders to contend on the same InnoDB lock.
    $blocker = (string) $wpdb->get_var('SELECT CONNECTION_ID()');
    sql('START TRANSACTION'); sql("SELECT singleton_id FROM `$table` WHERE singleton_id = 1 FOR UPDATE");
    verify((string) $wpdb->get_var('SELECT CONNECTION_ID()') === $blocker, 'Fixture blocker connection changed');
    $observer = new wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
    $observer->suppress_errors(true);
    $children = []; $observed = []; $captured = [];
    try {
        foreach ($requests as $request) {
            $request['registry_prefix'] = $wpdb->base_prefix;
            $process = proc_open([PHP_BINARY, __FILE__, 'worker', json_encode($request, JSON_THROW_ON_ERROR)], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            verify(is_resource($process), 'Cannot launch concurrent PHP worker'); fclose($pipes[0]);
            stream_set_timeout($pipes[1], 15); stream_set_timeout($pipes[2], 15);
            $children[] = [$process, $pipes];
        }
        $connections = [];
        foreach ($children as $index => [$process, $pipes]) {
            $ready = fgets($pipes[1]);
            $captured[$index][1] = is_string($ready) ? $ready : '';
            verify(is_string($ready) && preg_match('/\AREADY:([1-9][0-9]*)\n\z/', $ready, $matches) === 1, 'Concurrent worker failed before lock contention');
            $connections[] = $matches[1];
        }
        $waitQuery = RaceObserver::query($observer, $connections, $blocker, $table);
        $deadline = microtime(true) + 15;
        do {
            $observed = $observer->get_results($waitQuery, ARRAY_A);
            verify(is_array($observed) && $observer->last_error === '', 'Cannot observe live MySQL row-lock dependencies');
            if (RaceObserver::allWaiting($observed, $connections)) { break; }
            foreach ($children as [$process, $pipes]) {
                verify(proc_get_status($process)['running'], 'Concurrent writer exited before the lock barrier');
            }
            usleep(200000);
        } while (microtime(true) < $deadline);
        verify(RaceObserver::allWaiting($observed, $connections), 'Both independent writers must demonstrably wait on the held registry row lock');
        echo "PASS: live MySQL row-lock dependency proved for both independent writers\n";
        sql('COMMIT');
        $outcomes = [];
        foreach ($children as $index => [$process, $pipes]) {
            $output = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]);
            $captured[$index][1] = ($captured[$index][1] ?? '') . $output;
            $captured[$index][2] = $error;
            fclose($pipes[1]); fclose($pipes[2]); $status = proc_close($process);
            verify($status === 0 && $error === '', 'Concurrent PHP worker failed');
            $outcomes[] = json_decode(trim($output), true, 16, JSON_THROW_ON_ERROR);
        }
        return $outcomes;
    } catch (Throwable $error) {
        $diagnostics = ['observed_waiters' => is_array($observed) ? count($observed) : null, 'workers' => []];
        foreach ($children as $index => [$process, $pipes]) {
            $status = is_resource($process) ? proc_get_status($process) : [];
            $report = ['running' => $status['running'] ?? false, 'exitcode' => $status['exitcode'] ?? null];
            foreach ([1 => 'stdout', 2 => 'stderr'] as $descriptor => $name) {
                $raw = $captured[$index][$descriptor] ?? '';
                if (is_resource($pipes[$descriptor])) {
                    stream_set_blocking($pipes[$descriptor], false);
                    $raw .= stream_get_contents($pipes[$descriptor], 8192) ?: '';
                }
                $report[$name] = RaceObserver::output($raw);
            }
            $diagnostics['workers'][] = $report;
        }
        fwrite(STDERR, 'Sanitized registry race diagnostics: ' . json_encode($diagnostics, JSON_THROW_ON_ERROR) . "\n");
        throw $error;
    } finally {
        $wpdb->query('ROLLBACK');
        $observer->close();
        foreach ($children as [$process, $pipes]) {
            foreach ($pipes as $pipe) { if (is_resource($pipe)) { fclose($pipe); } }
            if (is_resource($process)) { proc_terminate($process); proc_close($process); }
        }
    }
}
function outcomes(array $actual, array $expected): void {
    $found = array_column($actual, 'outcome'); sort($found); sort($expected); verify($found === $expected, 'Unexpected concurrent outcomes: ' . json_encode($actual));
}
function retireCurrent(MysqlRegistry $registry, string $tenant): void {
    $record = $registry->tenant($tenant); if ($record !== null) { $registry->retire($tenant, $record['state_token']); }
}
$registry = fixtureRegistry('absent');
$out = race([
    ['operation' => 'install', 'tenant' => 'pr-910012', 'token' => null, 'desired' => releaseState('a')],
    ['operation' => 'retire', 'tenant' => 'pr-910012', 'token' => null],
]);
outcomes($out, ['committed', 'conflict']);
$winner = array_values(array_filter($out, fn($entry) => $entry['outcome'] === 'committed'))[0]['record'];
verify($registry->tenant('pr-910012') === $winner, 'Absent race lost authoritative winner');
// If install won the race, close must re-read and reconcile, not assume it won.
retireCurrent($registry, 'pr-910012');
$registry = fixtureRegistry('upgrade');
$a = $registry->compareAndSwap('pr-910013', null, releaseState('a'));
$out = race([
    ['operation' => 'install', 'tenant' => 'pr-910013', 'token' => $a['state_token'], 'desired' => releaseState('b', $a['releases'])],
    ['operation' => 'install', 'tenant' => 'pr-910013', 'token' => $a['state_token'], 'desired' => releaseState('c', $a['releases'])],
]);
outcomes($out, ['committed', 'conflict']); retireCurrent($registry, 'pr-910013');
$registry = fixtureRegistry('enabled');
$out = race([
    ['operation' => 'install', 'tenant' => 'pr-910014', 'token' => null, 'desired' => releaseState('a')],
    ['operation' => 'install', 'tenant' => 'pr-910015', 'token' => null, 'desired' => releaseState('b')],
]);
outcomes($out, ['committed', 'quota']);
verify(count(array_filter($registry->snapshot()['tenants'], fn($record) => $record['enabled'])) === 1, 'Concurrent quota was exceeded');
retireCurrent($registry, 'pr-910014'); retireCurrent($registry, 'pr-910015');
echo "PASS: independent MySQL writers serialize absent-create/retire, same-token upgrades and cross-tenant admission\n";

// Independent fresh registry preserves all prior synthetic records rather than
// pretending retirement frees data capacity or resetting a shared registry.
$registry = fixtureRegistry('retained');
$kept = $registry->compareAndSwap('pr-910020', null, releaseState('a'));
$kept = $registry->retire('pr-910020', $kept['state_token']);
for ($i = 910100; $i < 910120; ++$i) { $registry->retire('pr-' . $i, null); }
$out = race([
    ['operation' => 'install', 'tenant' => 'pr-910021', 'token' => null, 'desired' => releaseState('b')],
    ['operation' => 'install', 'tenant' => 'pr-910022', 'token' => null, 'desired' => releaseState('c')],
]);
outcomes($out, ['committed', 'quota']);
retireCurrent($registry, 'pr-910021'); retireCurrent($registry, 'pr-910022');
refusal(fn() => $registry->compareAndSwap('pr-910023', null, releaseState('d')));
verify($registry->tenant('pr-910020') === $kept, 'Global admission lost the original retired reservation');
verify(count(array_filter($registry->snapshot()['tenants'], fn($record) => $record['releases'] !== [])) === 2, 'Retained data tenant bound exceeded');
// Create a fresh synthetic orphan in this disposable database; never adopt or
// delete existing user tables, and do not depend on another gate's setup.
$orphanTable = $wpdb->base_prefix . 'pbin_pr_910099_pastes';
verify($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($orphanTable))) === null, 'Orphan fixture table already exists');
sql("CREATE TABLE `$orphanTable` (id int NOT NULL, marker varchar(32) NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB");
$fixtureRegistryTables[] = $orphanTable; // Exact newly owned fixture object only.
sql("INSERT INTO `$orphanTable` (id, marker) VALUES (1, 'preserve-synthetic-orphan')");
refusal(fn() => $registry->assertDataInventory());
$registry->retire('pr-910099', null); // Empty tombstone still cannot own data.
refusal(fn() => $registry->assertDataInventory());
verify($wpdb->get_var("SELECT marker FROM `$orphanTable` WHERE id = 1") === 'preserve-synthetic-orphan', 'Inventory rejection changed orphan data');
echo "PASS: real MySQL retained data admission keeps both retired slots, ignores empty tombstones, rejects orphan inventory and proves concurrent final-slot contention\n";

// Real wpdb reconnect/replay fault injection on a separate disposable connection.
class DisconnectOnceWpdb extends wpdb {
    public string $disconnectAt = '';
    public function query($query) {
        if ($this->disconnectAt !== '' && str_starts_with($query, $this->disconnectAt)) {
            $this->disconnectAt = '';
            $id = parent::get_var('SELECT CONNECTION_ID()');
            $killer = new wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
            verify($killer->query('KILL CONNECTION ' . (string) (int) $id) !== false, 'Cannot inject disconnect in disposable test');
            $killer->close();
        }
        return parent::query($query);
    }
}
foreach (['UPDATE' => RegistryException::class, 'COMMIT' => RegistryCommitUncertain::class] as $phase => $type) {
    $faultDb = new DisconnectOnceWpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
    $faultDb->set_prefix($wpdb->base_prefix);
    $faultRegistry = new MysqlRegistry($faultDb, ['max_enabled' => 1]);
    $faultDb->disconnectAt = $phase;
    refusal(fn() => $faultRegistry->retire('pr-910016', null), $type);
    verify($registry->tenant('pr-910016') === null, 'Reconnection published an unlocked mutation');
    $faultDb->close();
}
echo "PASS: real wpdb reconnect cannot publish an unlocked mutation; commit disconnect is uncertain\n";

$saved = $wpdb->get_var("SELECT state_json FROM `$table` WHERE singleton_id = 1");
foreach (['{"version":3,"tenants":{}}', '{"version":2,"tenants":{},"version":2}', '{', str_repeat('x', 1048577)] as $corrupt) {
    sql($wpdb->prepare("UPDATE `$table` SET state_json = %s WHERE singleton_id = 1", $corrupt));
    refusal(fn() => $registry->snapshot()); refusal(fn() => $registry->retire('pr-910017', null));
}
sql($wpdb->prepare("UPDATE `$table` SET state_json = %s WHERE singleton_id = 1", $saved));
sql("UPDATE `$table` SET schema_version = 3 WHERE singleton_id = 1"); refusal(fn() => $registry->snapshot());
sql("UPDATE `$table` SET schema_version = 2 WHERE singleton_id = 1");
sql('START TRANSACTION'); refusal(fn() => $registry->retire('pr-910017', null)); sql('ROLLBACK');
sql("ALTER TABLE `$table` ENGINE=MyISAM"); refusal(fn() => $registry->snapshot());
sql("ALTER TABLE `$table` ENGINE=InnoDB");
verify($registry->snapshot()['version'] === 2, 'Failed to restore valid registry');
verify(fingerprints($fixtureRegistryTables) === $before, 'Ordinary WordPress or application tables changed');
echo "PASS: corrupt/oversize/unknown/non-InnoDB state fails closed; ordinary WordPress tables unchanged\n";
echo "PASS: real WordPress wpdb/MySQL registry gate (not a Wasmer/controller deployment test)\n";
