<?php
/** Real WordPress wpdb/MySQL gate; run only through check-mysql-preview-registry.sh. */
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
function fingerprints(string $excluded): array {
    global $wpdb;
    $result = [];
    $tables = $wpdb->get_col('SHOW TABLES');
    verify(is_array($tables) && $wpdb->last_error === '', 'Cannot enumerate ordinary fixture tables');
    foreach ($tables as $table) {
        verify(preg_match('/\A[a-zA-Z0-9_]+\z/', $table) === 1, 'Unsafe fixture table');
        if ($table === $excluded) { continue; }
        $rows = $wpdb->get_results("SELECT * FROM `$table`", ARRAY_A);
        verify(is_array($rows) && $wpdb->last_error === '', 'Cannot read ordinary fixture data');
        $encoded = array_map(fn($row) => json_encode($row, JSON_THROW_ON_ERROR), $rows);
        sort($encoded, SORT_STRING); $result[$table] = hash('sha256', json_encode($encoded, JSON_THROW_ON_ERROR));
    }
    ksort($result, SORT_STRING); return $result;
}

$pbinRegistryMode = $argv[1] ?? 'run';
$registry = new MysqlRegistry($wpdb, ['max_enabled' => 1]);
if ($pbinRegistryMode === 'worker') {
    $request = json_decode($argv[2] ?? '', true, 16, JSON_THROW_ON_ERROR);
    echo "READY:" . $wpdb->get_var('SELECT CONNECTION_ID()') . "\n"; flush();
    try {
        $record = $request['operation'] === 'retire'
            ? $registry->retire($request['tenant'], $request['token'])
            : $registry->compareAndSwap($request['tenant'], $request['token'], $request['desired']);
        echo json_encode(['outcome' => 'committed', 'record' => $record], JSON_THROW_ON_ERROR) . "\n";
    } catch (RegistryConflict $error) { echo "{\"outcome\":\"conflict\"}\n"; }
    catch (RegistryException $error) { echo json_encode(['outcome' => $error->getMessage() === 'Enabled tenant bound exceeded' ? 'quota' : 'refused', 'type' => get_class($error)], JSON_THROW_ON_ERROR) . "\n"; }
    exit;
}
verify($pbinRegistryMode === 'run', 'Unknown integration mode');
$table = $wpdb->base_prefix . 'pbin_preview_registry';
$before = fingerprints($table);
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
    sql('START TRANSACTION'); sql("SELECT singleton_id FROM `$table` WHERE singleton_id = 1 FOR UPDATE");
    $children = [];
    try {
        foreach ($requests as $request) {
            $process = proc_open([PHP_BINARY, __FILE__, 'worker', json_encode($request, JSON_THROW_ON_ERROR)], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            verify(is_resource($process), 'Cannot launch concurrent PHP worker'); fclose($pipes[0]);
            stream_set_timeout($pipes[1], 15); stream_set_timeout($pipes[2], 15);
            $children[] = [$process, $pipes];
        }
        $connections = [];
        foreach ($children as [$process, $pipes]) {
            $ready = fgets($pipes[1]);
            verify(is_string($ready) && preg_match('/\AREADY:([1-9][0-9]*)\n\z/', $ready, $matches) === 1, 'Concurrent worker failed before lock contention');
            $connections[] = $matches[1];
        }
        $waiting = 0; $deadline = microtime(true) + 15;
        do {
            $waiting = (int) $wpdb->get_var("SELECT COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT' AND trx_mysql_thread_id IN (" . implode(',', $connections) . ')');
            verify($wpdb->last_error === '', 'Cannot observe real InnoDB lock waiters; disposable CI account needs PROCESS');
            if ($waiting === count($children)) { break; }
            usleep(20000);
        } while (microtime(true) < $deadline);
        verify($waiting === count($children), 'Both independent writers must demonstrably wait on the InnoDB lock');
        sql('COMMIT');
        $outcomes = [];
        foreach ($children as [$process, $pipes]) {
            $output = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]);
            fclose($pipes[1]); fclose($pipes[2]); $status = proc_close($process);
            verify($status === 0 && $error === '', 'Concurrent PHP worker failed');
            $outcomes[] = json_decode(trim($output), true, 16, JSON_THROW_ON_ERROR);
        }
        return $outcomes;
    } finally {
        $wpdb->query('ROLLBACK');
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
$out = race([
    ['operation' => 'install', 'tenant' => 'pr-910012', 'token' => null, 'desired' => releaseState('a')],
    ['operation' => 'retire', 'tenant' => 'pr-910012', 'token' => null],
]);
outcomes($out, ['committed', 'conflict']);
$winner = array_values(array_filter($out, fn($entry) => $entry['outcome'] === 'committed'))[0]['record'];
verify($registry->tenant('pr-910012') === $winner, 'Absent race lost authoritative winner');
// If install won the race, close must re-read and reconcile, not assume it won.
retireCurrent($registry, 'pr-910012');
$a = $registry->compareAndSwap('pr-910013', null, releaseState('a'));
$out = race([
    ['operation' => 'install', 'tenant' => 'pr-910013', 'token' => $a['state_token'], 'desired' => releaseState('b', $a['releases'])],
    ['operation' => 'install', 'tenant' => 'pr-910013', 'token' => $a['state_token'], 'desired' => releaseState('c', $a['releases'])],
]);
outcomes($out, ['committed', 'conflict']); retireCurrent($registry, 'pr-910013');
$out = race([
    ['operation' => 'install', 'tenant' => 'pr-910014', 'token' => null, 'desired' => releaseState('a')],
    ['operation' => 'install', 'tenant' => 'pr-910015', 'token' => null, 'desired' => releaseState('b')],
]);
outcomes($out, ['committed', 'quota']);
verify(count(array_filter($registry->snapshot()['tenants'], fn($record) => $record['enabled'])) === 1, 'Concurrent quota was exceeded');
retireCurrent($registry, 'pr-910014'); retireCurrent($registry, 'pr-910015');
echo "PASS: independent MySQL writers serialize absent-create/retire, same-token upgrades and cross-tenant admission\n";

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
verify(fingerprints($table) === $before, 'Ordinary WordPress or application tables changed');
echo "PASS: corrupt/oversize/unknown/non-InnoDB state fails closed; ordinary WordPress tables unchanged\n";
echo "PASS: real WordPress wpdb/MySQL registry gate (not a Wasmer/controller deployment test)\n";
