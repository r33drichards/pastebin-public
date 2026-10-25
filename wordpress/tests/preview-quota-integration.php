<?php
/** Hosted-only real MySQL 8 + WordPress fixture. Never target an existing site. */
use Pbin\Plugin\Instance;
use Pbin\Plugin\PBIN_Store;
use Pbin\Plugin\PreviewQuota;
use Pbin\Plugin\PreviewQuotaExceeded;
use Pbin\Preview\Tests\RaceObserver;
require __DIR__ . '/mysql-race-observer.php';
if (($argv[1] ?? '') === 'candidate') {
    set_exception_handler(static function (Throwable $error): void {
        fwrite(STDERR, 'WORKER_ERROR ' . json_encode(RaceObserver::error($error), JSON_THROW_ON_ERROR) . "\n"); exit(1);
    });
}
function integrationCheck(bool $value, string $message): void { if (!$value) { throw new RuntimeException($message); } }
function integrationReject(callable $action, string $type = RuntimeException::class): void {
    try { $action(); } catch (Throwable $error) { integrationCheck($error instanceof $type, 'Wrong rejection type'); return; }
    throw new RuntimeException('Expected rejection');
}
integrationCheck(getenv('PBIN_TEST_ALLOW_DATABASE_MUTATION') === '1', 'Explicit disposable database mutation flag required');
$pbinQuotaRoot = getenv('PBIN_WP_FIXTURE') ?: '';
$pbinQuotaLoad = getenv('PBIN_WORDPRESS_LOAD') ?: '';
$pbinQuotaDB = getenv('PBIN_TEST_DATABASE_NAME') ?: '';
integrationCheck($pbinQuotaRoot !== '' && is_dir($pbinQuotaRoot) && realpath($pbinQuotaRoot) === $pbinQuotaRoot, 'Canonical fixture root required');
integrationCheck($pbinQuotaLoad === $pbinQuotaRoot . '/site/wp-load.php' && is_file($pbinQuotaLoad) && realpath($pbinQuotaLoad) === $pbinQuotaLoad, 'Fixture wp-load.php required');
integrationCheck(preg_match('/^pbin_ci_[a-f0-9]{24}$/D', $pbinQuotaDB) === 1, 'Unique disposable database required');
$pbinQuotaMode = $argv[1] ?? '';
$pbinQuotaKey = $argv[2] ?? '';
integrationCheck(in_array($pbinQuotaMode, ['bytes', 'rows', 'candidate'], true), 'Unknown fixture mode');
integrationCheck(in_array($pbinQuotaKey, ['pr_920002', 'pr_920003'], true), 'Dedicated quota fixture tenant required');
$pbinQuotaInput = isset($argv[3]) ? json_decode($argv[3], true, 8, JSON_THROW_ON_ERROR) : [];
require dirname($pbinQuotaLoad) . '/wp-includes/plugin.php';
$pbinQuotaNormal = getenv('PBIN_TEST_NORMAL_PLUGIN') ?: 'pbin/pbin.php';
add_filter('option_active_plugins', static fn($plugins) => array_values(array_diff((array) $plugins, [$pbinQuotaNormal])));
add_filter('site_option_active_sitewide_plugins', static function ($plugins) use ($pbinQuotaNormal) { unset($plugins[$pbinQuotaNormal]); return $plugins; });
require $pbinQuotaLoad;
integrationCheck(defined('DB_NAME') && DB_NAME === $pbinQuotaDB, 'Refusing a database outside this fixture');
integrationCheck(defined('DB_HOST') && preg_match('~^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+|:/[^\r\n]+)?$~D', DB_HOST) === 1, 'Fixture database must be localhost');
integrationCheck(!class_exists(Instance::class, false), 'Plugin selected an instance before fixture');
$pbinQuotaPlugin = getenv('PBIN_TEST_PLUGIN_DIR') ?: realpath(dirname(__DIR__) . '/pbin');
integrationCheck(is_dir($pbinQuotaPlugin) && realpath($pbinQuotaPlugin) === $pbinQuotaPlugin && is_file($pbinQuotaPlugin . '/runtime.php') && !is_link($pbinQuotaPlugin . '/runtime.php'), 'Canonical extracted plugin required');
require $pbinQuotaPlugin . '/runtime.php';
Instance::select(new Instance($pbinQuotaKey, '/previews/' . str_replace('_', '-', $pbinQuotaKey), $pbinQuotaPlugin, str_repeat('a', 40), true));
$db = $GLOBALS['wpdb']; $store = new PBIN_Store($db); $prefix = $db->prefix . Instance::current()->storagePrefix();
if ($pbinQuotaMode === 'candidate') {
    $ready = $pbinQuotaInput['ready'] ?? '';
    integrationCheck(is_string($ready) && dirname($ready) === $pbinQuotaRoot && preg_match('/^quota-ready-[a-f0-9]{16}$/D', basename($ready)) === 1 && !file_exists($ready), 'Unsafe ready-file path');
    $connection = $db->get_var('SELECT CONNECTION_ID()');
    integrationCheck(ctype_digit((string) $connection), 'Worker connection unavailable');
    integrationCheck(file_put_contents($ready, (string) $connection, LOCK_EX) !== false, 'Worker readiness unavailable');
    $operation = $pbinQuotaInput['operation'] ?? '';
    integrationCheck(in_array($operation, ['diff', 'update', 'snapshot'], true), 'Unknown candidate operation');
    $parent = $pbinQuotaInput['parent'] ?? '';
    integrationCheck(is_string($parent) && preg_match('/^[a-f0-9-]{36}$/D', $parent) === 1, 'Invalid candidate parent');
    try {
        if ($operation === 'update') { $store->UpdatePaste($parent, str_repeat('x', PreviewQuota::MAX_BYTES), '', ''); $id = $parent; }
        elseif ($operation === 'snapshot') { $id = $store->AddSnapshot($parent, '😀', '', '', '')['ID']; }
        else { $id = $store->AddDiff('😀', ''); }
        echo json_encode(['admitted' => true, 'id' => $id, 'operation' => $operation]), "\n";
    }
    catch (PreviewQuotaExceeded $error) { echo json_encode(['admitted' => false]), "\n"; }
    exit;
}
// Each scenario requires fresh tables, not a destructive reset of existing data.
integrationCheck($db->get_var($db->prepare('SHOW TABLES LIKE %s', $db->esc_like($prefix . 'pastes'))) === null, 'Quota fixture tenant already exists');
$productionSchema = get_option('pbin_schema_version');
PBIN_Store::install();
integrationCheck(get_option('pbin_schema_version') === $productionSchema, 'Preview migration changed production marker');
$seed = $store->AddPaste($pbinQuotaMode === 'bytes' ? str_repeat('x', PreviewQuota::MAX_BYTES - 4) : '', '', '');
if ($pbinQuotaMode === 'rows') {
    for ($i = 1; $i < PreviewQuota::MAX_DOCUMENTS - 1; ++$i) { $store->AddDiff('', ''); }
}
// Hold admission while two distinct PHP/wpdb connections enter LOCK WAIT.
// This is genuine concurrent contention, not sequential "parallel" calls.
$blocker = (string) $db->get_var('SELECT CONNECTION_ID()');
integrationCheck($db->query('START TRANSACTION') !== false, 'Cannot begin coordinator transaction');
integrationCheck($db->get_row("SELECT singleton_id FROM `{$prefix}quota` FOR UPDATE") !== null, 'Cannot hold quota lock');
$workers = []; $locked = true;
try {
    for ($i = 0; $i < 2; ++$i) {
        $ready = $pbinQuotaRoot . '/quota-ready-' . bin2hex(random_bytes(8));
        $command = [PHP_BINARY, __FILE__, 'candidate', $pbinQuotaKey, json_encode(['ready' => $ready, 'parent' => $seed, 'operation' => $i === 1 ? 'snapshot' : ($pbinQuotaMode === 'bytes' ? 'update' : 'diff')], JSON_THROW_ON_ERROR)];
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        integrationCheck(is_resource($process), 'Cannot launch concurrent fixture worker');
        fclose($pipes[0]); stream_set_timeout($pipes[1], 20); stream_set_timeout($pipes[2], 20); $workers[] = ['process' => $process, 'pipes' => $pipes, 'ready' => $ready];
    }
    $deadline = microtime(true) + 15; $waiting = false;
    while (microtime(true) < $deadline) {
        $ids = [];
        foreach ($workers as $worker) { if (is_file($worker['ready'])) { $id = file_get_contents($worker['ready']); if (ctype_digit($id)) { $ids[] = $id; } } }
        if (count($ids) === 2) {
            $observed = $db->get_results(RaceObserver::query($db, $ids, $blocker, $prefix . 'quota'), ARRAY_A);
            integrationCheck(is_array($observed) && $db->last_error === '', 'Cannot inspect live MySQL row-lock dependencies');
            if (RaceObserver::allWaiting($observed, $ids)) { $waiting = true; break; }
        }
        foreach ($workers as $worker) { integrationCheck(proc_get_status($worker['process'])['running'], 'Concurrent candidate exited before the lock barrier'); }
        usleep(200000);
    }
    integrationCheck($waiting, 'Both workers must prove concurrent InnoDB lock contention before release');
    integrationCheck((string) $db->get_var('SELECT CONNECTION_ID()') === $blocker, 'Coordinator connection changed');
    integrationCheck($db->query('COMMIT') !== false, 'Coordinator release failed'); $locked = false;
    $results = [];
    foreach ($workers as &$worker) {
        $stdout = stream_get_contents($worker['pipes'][1]); $stderr = stream_get_contents($worker['pipes'][2]);
        fclose($worker['pipes'][1]); fclose($worker['pipes'][2]);
        $status = proc_close($worker['process']); $worker['process'] = null;
        integrationCheck($status === 0 && $stderr === '', 'Concurrent candidate failed: ' . json_encode(RaceObserver::output($stderr), JSON_THROW_ON_ERROR));
        $results[] = json_decode($stdout, true, 8, JSON_THROW_ON_ERROR);
    }
    unset($worker);
    integrationCheck(array_sum(array_column($results, 'admitted')) === 1, 'Exactly one final-capacity candidate must commit');
} finally {
    if ($locked) { $db->query('ROLLBACK'); }
    foreach ($workers as $worker) {
        if (is_resource($worker['process'])) { proc_terminate($worker['process']); foreach ($worker['pipes'] as $pipe) { if (is_resource($pipe)) { fclose($pipe); } } proc_close($worker['process']); }
        if (is_file($worker['ready'])) { unlink($worker['ready']); }
    }
}
$documents = (int) $db->get_var("SELECT (SELECT COUNT(*) FROM `{$prefix}pastes`) + (SELECT COUNT(*) FROM `{$prefix}diffs`) + (SELECT COUNT(*) FROM `{$prefix}snapshots`)");
if ($pbinQuotaMode === 'bytes') {
    $bytes = (int) $db->get_var("SELECT (SELECT COALESCE(SUM(OCTET_LENGTH(text)+OCTET_LENGTH(language)+OCTET_LENGTH(title)),0) FROM `{$prefix}pastes`) + (SELECT COALESCE(SUM(OCTET_LENGTH(old_text)+OCTET_LENGTH(new_text)),0) FROM `{$prefix}diffs`) + (SELECT COALESCE(SUM(OCTET_LENGTH(name)+OCTET_LENGTH(text)+OCTET_LENGTH(language)+OCTET_LENGTH(title)),0) FROM `{$prefix}snapshots`)");
    integrationCheck($bytes === PreviewQuota::MAX_BYTES && in_array($documents, [1, 2], true), 'Byte admission exceeded or underfilled exact UTF-8 cap');
    $original = $store->GetPaste($seed)['Text']; $store->UpdatePaste($seed, $original, '', '');
    integrationReject(fn() => $store->AddSnapshot($seed, 'n', '', '', ''), PreviewQuotaExceeded::class);
    $store->UpdatePaste($seed, '😀', '', '');
    $snapshot = $store->AddSnapshot($seed, 'kept', 'immutable', '', '');
    // Force an actual storage failure AFTER admission, without deleting documents.
    $diffsBeforeFailure = (int) $db->get_var("SELECT COUNT(*) FROM `{$prefix}diffs`");
    $trigger = $prefix . 'reject_diff';
    integrationCheck($db->query("CREATE TRIGGER `$trigger` BEFORE INSERT ON `{$prefix}diffs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic quota fixture failure'") !== false, 'Cannot install disposable failure fixture');
    try { integrationReject(fn() => $store->AddDiff('failed', 'mutation')); }
    finally { integrationCheck($db->query("DROP TRIGGER `$trigger`") !== false, 'Cannot remove disposable failure fixture'); }
    integrationCheck((int) $db->get_var("SELECT COUNT(*) FROM `{$prefix}diffs`") === $diffsBeforeFailure, 'Failed write was not rolled back');
    $store->AddDiff('subsequent', 'admission');
    integrationCheck($store->GetSnapshot($snapshot['ID'])['Text'] === 'immutable', 'Failed write affected retained snapshot');
} else {
    integrationCheck($documents === PreviewQuota::MAX_DOCUMENTS, 'Concurrent admission exceeded exact row cap');
    integrationReject(fn() => $store->AddPaste('', '', ''), PreviewQuotaExceeded::class);
    integrationReject(fn() => $store->AddSnapshot($seed, 'n', '', '', ''), PreviewQuotaExceeded::class);
    $store->UpdatePaste($seed, 'editable at row cap', '', '');
    $store->UpdatePaste($seed, 'editable at row cap', '', '');
}
integrationCheck($db->last_error === '', 'Unexpected database error');
echo 'PASS: actual MySQL preview ', $pbinQuotaMode, " cap, two proven concurrent lock waiters, one admission, preserved documents and update behavior\n";
