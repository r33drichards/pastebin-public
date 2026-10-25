<?php
/**
 * Focused preview control-plane and functional tenancy checks.
 * Run: php wordpress/tests/preview-tenancy.php
 * WordPress hooks/options/database calls are mocked. Loader web cases execute an
 * exact source copy with ONLY PHP_SAPI's CLI check disabled. No live HTTP server,
 * real WordPress boot, actual SQL execution, or MySQL isolation is claimed by
 * the default suite. The explicit --wordpress-context mode below is a separate
 * real-WordPress/MySQL gate, requiring a disposable fixture and opt-in flags.
 */
use Pbin\Plugin\Instance;
use Pbin\Plugin\PBIN_Store;
use Pbin\Preview\Selector;

const PREVIEW_TEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PREVIEW_TEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PREVIEW_TEST_OLD = 'cccccccccccccccccccccccccccccccccccccccc';

function check(bool $value, string $message): void {
    if (!$value) { throw new RuntimeException($message); }
}
function fixtureDirectory(string $path): void {
    if (!is_dir($path) && !mkdir($path, 0700, true) && !is_dir($path)) { throw new RuntimeException('Cannot create fixture'); }
}
function removeFixture(string $path): void {
    if (is_link($path) || is_file($path)) { unlink($path); return; }
    foreach (scandir($path) ?: [] as $name) {
        if ($name !== '.' && $name !== '..') { removeFixture($path . '/' . $name); }
    }
    rmdir($path);
}
function expectedException(callable $action, string $message, string $type = RuntimeException::class): void {
    try { $action(); } catch (Throwable $error) {
        check($error instanceof $type, $message . ': wrong exception ' . get_class($error));
        return;
    }
    throw new RuntimeException($message . ': expected rejection');
}
function createPackage(string $root, string $tenant, string $revision): string {
    $package = $root . '/releases/' . $tenant . '/' . $revision . '/pbin';
    fixtureDirectory($package . '/includes');
    fixtureDirectory($package . '/static/js');
    copy(dirname(__DIR__) . '/pbin/runtime.php', $package . '/runtime.php');
    foreach (glob(dirname(__DIR__) . '/pbin/includes/*.php') as $file) {
        copy($file, $package . '/includes/' . basename($file));
    }
    file_put_contents($package . '/static/js/fixture.js', 'const release = ' . json_encode($revision) . ';');
    return $package;
}
function child(string $mode, string $root): array {
    $command = escapeshellarg(PHP_BINARY) . ' -n ' . escapeshellarg(__FILE__) . ' ' . escapeshellarg($mode) . ' ' . escapeshellarg($root);
    exec($command . ' 2>&1', $lines, $status);
    check($status === 0, $mode . ' subprocess failed: ' . implode("\n", $lines));
    $result = json_decode(implode("\n", $lines), true);
    check(is_array($result), $mode . ' subprocess did not return JSON: ' . implode("\n", $lines));
    return $result;
}

// Minimal WordPress stubs. These deliberately record calls instead of claiming
// to exercise a real WP database, hooks pipeline, migrations or object cache.
$mode = $argv[1] ?? '';
$GLOBALS['test_actions'] = $GLOBALS['test_filters'] = $GLOBALS['test_options'] = $GLOBALS['test_ddl'] = [];
if (!str_starts_with($mode, '--wordpress-context=')) {
function add_action(string $name, callable $callback, int $priority = 10, int $args = 1): void { $GLOBALS['test_actions'][$name][] = $callback; }
function add_filter(string $name, callable $callback, int $priority = 10, int $args = 1): void { $GLOBALS['test_filters'][$name][] = $callback; }
function apply_filters(string $name, $value) { foreach ($GLOBALS['test_filters'][$name] ?? [] as $callback) { $value = $callback($value); } return $value; }
function get_option(string $name, $fallback = false) { return $GLOBALS['test_options'][$name] ?? $fallback; }
function update_option(string $name, $value, bool $autoload = true): void { $GLOBALS['test_options'][$name] = $value; }
function dbDelta(string $query): void { $GLOBALS['test_ddl'][] = $query; }
function home_url(string $path): string { return 'https://fixture.invalid' . $path; }
function is_admin(): bool { return defined('WP_ADMIN') && WP_ADMIN; }
function plugin_basename(string $file): string { return 'pbin/' . basename($file); }
function register_activation_hook(string $file, callable $callback): void { $GLOBALS['test_activation'][] = $callback; }
function wp_generate_uuid4(): string { static $counter = 0; return sprintf('00000000-0000-4000-8000-%012d', ++$counter); }
function wp_salt(string $scheme): string { return 'test-only-public-salt'; }
}

require_once __DIR__ . '/preview-quota-fixture.php';
final class PreviewFixtureDB extends PreviewQuotaFixtureDB {}

// Optional real-MySQL CI gate. Run only against the disposable localhost fixture.
// Every invocation is a distinct PHP process, just like distinct HTTP requests.
// write [optional JSON {run_id}] => full JSON record bundle
// read <bundle>               => verify the same tenant's actual persisted data
// expect-missing <bundle>     => prove other tenant's IDs are absent
if (str_starts_with($mode, '--wordpress-context=')) {
    check(getenv('PBIN_TEST_ALLOW_DATABASE_MUTATION') === '1', 'Real WordPress tests require an explicit disposable fixture mutation flag');
    // WordPress bootstraps in global scope and may reuse/unset generic names
    // (default-filters.php unsets $action). Keep our request state distinct,
    // without moving WordPress requires into function/local scope.
    $pbinFixtureRoot = getenv('PBIN_WP_FIXTURE') ?: '';
    check($pbinFixtureRoot !== '' && is_dir($pbinFixtureRoot) && realpath($pbinFixtureRoot) === $pbinFixtureRoot, 'PBIN_WP_FIXTURE must name the canonical disposable fixture directory');
    $pbinFixtureKey = substr($mode, strlen('--wordpress-context='));
    check(preg_match('/^pr_9[0-9]{5,9}$/D', $pbinFixtureKey) === 1, 'Real database test requires a dedicated pr_9xxxxx tenant');
    $pbinFixtureAction = $argv[2] ?? '';
    check(in_array($pbinFixtureAction, ['write', 'read', 'expect-missing'], true), 'Invalid real database action');
    $pbinFixtureInput = isset($argv[3]) ? json_decode($argv[3], true, 32, JSON_THROW_ON_ERROR) : [];
    check(is_array($pbinFixtureInput), 'Real database input must be an object');
    $pbinFixtureWpLoad = getenv('PBIN_WORDPRESS_LOAD') ?: '';
    check($pbinFixtureWpLoad === $pbinFixtureRoot . '/site/wp-load.php' && is_file($pbinFixtureWpLoad) && realpath($pbinFixtureWpLoad) === $pbinFixtureWpLoad, 'PBIN_WORDPRESS_LOAD must name this disposable fixture site/wp-load.php');
    $pbinFixtureExpectedDB = getenv('PBIN_TEST_DATABASE_NAME') ?: '';
    check(preg_match('/^pbin_ci_[a-f0-9]{24}$/D', $pbinFixtureExpectedDB) === 1, 'PBIN_TEST_DATABASE_NAME must identify the unique pbin_ci_ fixture database');
    // Register filters before wp-settings loads active plugins. The MU control
    // plane rejects native CLI, so neither it nor the default plugin can select
    // a context before this explicit fixture request.
    require dirname($pbinFixtureWpLoad) . '/wp-includes/plugin.php';
    $pbinFixtureNormalPlugin = getenv('PBIN_TEST_NORMAL_PLUGIN') ?: 'pbin/pbin.php';
    add_filter('option_active_plugins', static fn($plugins) => array_values(array_diff((array) $plugins, [$pbinFixtureNormalPlugin])));
    add_filter('site_option_active_sitewide_plugins', static function ($plugins) use ($pbinFixtureNormalPlugin) { unset($plugins[$pbinFixtureNormalPlugin]); return $plugins; });
    // The guarded disposable fixture config disables cron before core loads.
    require $pbinFixtureWpLoad;
    check(defined('DB_NAME') && DB_NAME === $pbinFixtureExpectedDB, 'Refusing to test a database outside the named fixture');
    check(defined('DB_HOST') && preg_match('~^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+|:/[^\r\n]+)?$~D', DB_HOST) === 1, 'Real database fixture must use localhost');
    check(!class_exists(Instance::class, false), 'A plugin selected or loaded its runtime before the fixture');
    $plugin = getenv('PBIN_TEST_PLUGIN_DIR') ?: realpath(dirname(__DIR__) . '/pbin');
    check(is_dir($plugin) && realpath($plugin) === $plugin && is_file($plugin . '/runtime.php') && !is_link($plugin . '/runtime.php'), 'PBIN_TEST_PLUGIN_DIR must name the canonical extracted plugin');
    require $plugin . '/runtime.php';
    $instance = new Instance($pbinFixtureKey, '/previews/' . str_replace('_', '-', $pbinFixtureKey), $plugin, PREVIEW_TEST_A, true);
    Instance::select($instance);
    $store = new PBIN_Store($GLOBALS['wpdb']);
    $db = $GLOBALS['wpdb'];
    $prefix = $db->prefix . $instance->storagePrefix();
    if ($pbinFixtureAction === 'write') {
        $runId = $pbinFixtureInput['run_id'] ?? bin2hex(random_bytes(8));
        check(is_string($runId) && preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $runId) === 1, 'Invalid fixture run ID');
        $defaultSchema = get_option('pbin_schema_version', null);
        $defaultMarker = get_option('pbin_fixture_marker', null);
        PBIN_Store::install();
        check(get_option($instance->optionKey('schema_version')) === PBIN_Store::schemaVersion(), 'Real schema option missing');
        $tables = [];
        foreach (['pastes', 'diffs', 'snapshots', 'limits'] as $name) {
            $table = $prefix . $name;
            check($db->get_var($db->prepare('SHOW TABLES LIKE %s', $db->esc_like($table))) === $table, 'Actual tenant table missing');
            $tables[] = $table;
        }
        $text = $pbinFixtureKey . ':' . $runId;
        $pasteID = $store->AddPaste('original:' . $text, 'text', 'fixture');
        $diffID = $store->AddDiff('old:' . $text, 'new:' . $text);
        $snapshot = $store->AddSnapshot($pasteID, 'fixture-snapshot', 'snapshot:' . $text, 'text', 'immutable-fixture');
        $store->UpdatePaste($pasteID, 'updated:' . $text, 'php', 'updated-fixture');
        check($store->GetSnapshot($snapshot['ID'])['Text'] === 'snapshot:' . $text, 'Snapshot changed when paste changed');
        check(count($store->ListSnapshots($pasteID)) === 1, 'Actual snapshot listing failed');
        $marker = 'marker:' . $text;
        update_option($instance->optionKey('fixture_marker'), $marker, false);
        $route = '/fixture-preview-isolation/' . $runId;
        $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
        check($store->AllowRequest($route, 0.001), 'First actual tenant limiter request denied');
        check(!$store->AllowRequest($route, 0.001), 'Actual tenant limiter did not isolate/update its bucket');
        check(get_option('pbin_schema_version', null) === $defaultSchema && get_option('pbin_fixture_marker', null) === $defaultMarker, 'Preview altered production option');
        $result = ['key' => $pbinFixtureKey, 'run_id' => $runId, 'prefix' => $prefix, 'tables' => $tables,
            'schema_option' => $instance->optionKey('schema_version'), 'marker' => $marker,
            'paste' => $store->GetPaste($pasteID), 'diff' => $store->GetDiff($diffID), 'snapshot' => $store->GetSnapshot($snapshot['ID']),
            'actual_mysql' => true];
    } else {
        foreach (['paste', 'diff', 'snapshot'] as $type) { check(isset($pbinFixtureInput[$type]['ID']), 'Missing input ' . $type . ' ID'); }
        $getters = ['paste' => 'GetPaste', 'diff' => 'GetDiff', 'snapshot' => 'GetSnapshot'];
        if ($pbinFixtureAction === 'read') {
            check(($pbinFixtureInput['key'] ?? null) === $pbinFixtureKey, 'Use expect-missing for cross-tenant reads');
            foreach ($getters as $type => $method) { check($store->$method($pbinFixtureInput[$type]['ID']) === $pbinFixtureInput[$type], 'Actual persisted ' . $type . ' changed'); }
            check(get_option($instance->optionKey('fixture_marker')) === ($pbinFixtureInput['marker'] ?? null), 'Actual tenant option changed');
            check(get_option($instance->optionKey('schema_version')) === PBIN_Store::schemaVersion(), 'Actual schema option changed');
        } else {
            check(($pbinFixtureInput['key'] ?? null) !== $pbinFixtureKey, 'Cross-tenant negative test requires another tenant');
            foreach ($getters as $type => $method) { expectedException(fn() => $store->$method($pbinFixtureInput[$type]['ID']), 'Cross-tenant ' . $type . ' visibility', OutOfBoundsException::class); }
            check($store->ListSnapshots($pbinFixtureInput['paste']['ID']) === [], 'Cross-tenant snapshot listing leaked data');
            check(get_option($instance->optionKey('fixture_marker')) !== ($pbinFixtureInput['marker'] ?? null), 'Cross-tenant option leaked marker');
        }
        $result = ['key' => $pbinFixtureKey, 'action' => $pbinFixtureAction, 'verified' => true, 'actual_mysql' => true];
    }
    check($db->last_error === '', 'Real database reported an error');
    echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), "\n";
    exit;
}

if (str_starts_with($mode, '--context=')) {
    $key = substr($mode, strlen('--context='));
    $root = $argv[2];
    define('ABSPATH', $root . '/wp/');
    define('ARRAY_A', 'ARRAY_A');
    $preview = $key !== 'default';
    $base = $preview ? '/previews/' . str_replace('_', '-', $key) : '/site/pbin';
    $plugin = realpath(dirname(__DIR__) . '/pbin');
    // Demonstrate coexistence with global symbols commonly supplied by another
    // plugin, while the selected package owns Pbin\\Plugin and PbinVendor.
    eval('class PBIN_Store {} class PBIN_HTTP {} class PBIN_Completion {} class Parsedown {} class ParsedownExtra {} class Spyc {} function pbin_path() { return "unrelated"; }');
    require $plugin . '/runtime.php';
    $instance = new Instance($key, $base, $plugin, $preview ? PREVIEW_TEST_A : '', $preview, null, $preview ? $root . '/data/' . str_replace('_', '-', $key) : null);
    \Pbin\Plugin\bootstrap($instance);
    expectedException(fn() => Instance::select($instance), 'Second instance selection', LogicException::class);
    $GLOBALS['wpdb'] = $db = new PreviewFixtureDB();
    foreach ($GLOBALS['test_actions']['plugins_loaded'] ?? [] as $callback) { $callback(); }
    $store = new PBIN_Store($db);
    $paste = $store->AddPaste('tenant:' . $key, 'text', 'title');
    check($store->GetPaste($paste)['Text'] === 'tenant:' . $key, 'Read own paste');
    $store->UpdatePaste($paste, 'updated:' . $key, 'php', 'next');
    check($store->GetPaste($paste)['Text'] === 'updated:' . $key, 'Update own paste');
    $diff = $store->AddDiff('old:' . $key, 'new:' . $key);
    check($store->GetDiff($diff)['NewText'] === 'new:' . $key, 'Read own diff');
    $snapshot = $store->AddSnapshot($paste, 'named', 'snapshot:' . $key, 'text', 'snapshot');
    check($store->GetSnapshot($snapshot['ID'])['Text'] === 'snapshot:' . $key, 'Read own snapshot');
    check(count($store->ListSnapshots($paste)) === 1, 'List own snapshots');
    check($store->AllowRequest('/paste', 2), 'Limiter executes through tenant table mock');
    $prefix = $db->prefix . $instance->storagePrefix();
    foreach ($db->touched as $table) { check(str_starts_with($table, $prefix), 'Storage operation escaped tenant prefix'); }
    foreach ($GLOBALS['test_ddl'] as $ddl) { check(str_contains($ddl, 'CREATE TABLE ' . $prefix), 'DDL escaped tenant prefix'); }
    check(count($GLOBALS['test_ddl']) === 4, 'Four schema tables');
    check(array_keys($GLOBALS['test_options']) === [$instance->optionKey('schema_version')], 'Schema option escaped tenant prefix');
    require $plugin . '/includes/completion.php';
    putenv('HF_TOKEN=fixture-never-a-real-secret');
    putenv('COMPLETION_FALLBACK_URL=https://fixture.invalid');
    if ($preview) { check(\Pbin\Plugin\PBIN_Completion::providers() === [], 'Preview inherited live inference configuration'); }
    require $plugin . '/includes/markdown.php';
    check(class_exists('PbinVendor\\Parsedown') && class_exists('PbinVendor\\ParsedownExtra') && class_exists('PbinVendor\\Spyc'), 'Vendor namespace missing');
    check(\pbin_path() === 'unrelated', 'Global helper overwritten');
    check(!class_exists('PBIN_CollabStore', false) && !class_exists('PBIN_TextOp', false), 'Inactive prototype loaded');
    $data = ['Text' => '', 'Language' => 'text', 'Title' => '', 'ID' => $paste];
    ob_start(); require $plugin . '/templates/paste.php'; $html = ob_get_clean();
    $storageScope = $preview ? 'pbin:' . $key . ':' : '';
    check(str_contains($html, 'window.pbinStoragePrefix = ' . json_encode($storageScope)), 'Rendered storage scope');
    check(str_contains($html, $instance->path('/static/js/storage.js')), 'Rendered pinned storage asset');
    echo json_encode(['key' => $key, 'prefix' => $instance->storagePrefix(), 'cache' => $instance->cacheGroup(),
        'schema' => $instance->optionKey('schema_version'), 'path' => \Pbin\Plugin\pbin_path('/paste'),
        'asset' => \Pbin\Plugin\pbin_path('/static/js/storage.js'), 'data' => $instance->dataDir,
        'tables' => array_values(array_unique($db->touched)), 'ddl_count' => count($GLOBALS['test_ddl'])]);
    exit;
}

if (str_starts_with($mode, '--loader=')) {
    $case = substr($mode, strlen('--loader='));
    $root = $argv[2];
    if (str_starts_with($case, 'v2-')) {
        $originalRegistry = file_get_contents($root . '/registry.json');
        $version2 = json_decode($originalRegistry, true);
        $version2['version'] = 2;
        foreach ($version2['tenants'] as &$record) { $record['state_token'] = str_repeat('1', 64); }
        unset($record);
        file_put_contents($root . '/registry.json', json_encode($version2));
        register_shutdown_function(static fn() => file_put_contents($root . '/registry.json', $originalRegistry));
        $case = substr($case, 3);
    }
    define('ABSPATH', $root . '/wp/');
    define('PBIN_PREVIEW_REGISTRY_BACKEND', 'file');
    if ($case !== 'unconfigured') { define('PBIN_PREVIEW_ROOT', $root); }
    $_SERVER['REQUEST_URI'] = '/previews/pr-101/paste';
    if ($case === 'unrelated') { $_SERVER['REQUEST_URI'] = '/somewhere-else'; }
    if ($case === 'admin-path') { $_SERVER['REQUEST_URI'] = '/wp-admin/plugins.php'; }
    if ($case === 'rest-path') { $_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/posts'; }
    if ($case === 'retained-assets') { $_SERVER['REQUEST_URI'] = '/previews/pr-101/_releases/' . PREVIEW_TEST_OLD . '/static/js/fixture.js'; }
    foreach (['admin' => 'WP_ADMIN', 'cron' => 'DOING_CRON', 'ajax' => 'DOING_AJAX', 'rest' => 'REST_REQUEST', 'wp-cli' => 'WP_CLI'] as $name => $constant) {
        if ($case === $name) { define($constant, true); }
    }
    if ($case === 'rest-query') { $_GET['rest_route'] = '/wp/v2/posts'; }
    $rejections = ['unconfigured', 'unknown', 'malformed', 'raw-control', 'disabled', 'tombstone', 'enabled-null', 'missing-token', 'missing-enabled', 'invalid-registry', 'huge-registry', 'missing-registry', 'symlink-registry', 'missing-entry', 'duplicate'];
    if (in_array($case, $rejections, true)) {
        $originalRegistry = file_get_contents($root . '/registry.json');
        $runtime = $root . '/releases/pr-101/' . PREVIEW_TEST_A . '/pbin/runtime.php';
        if ($case === 'unknown') { $_SERVER['REQUEST_URI'] = '/previews/pr-999/paste'; }
        if ($case === 'malformed') { $_SERVER['REQUEST_URI'] = '/previews/pr-101/../pr-202/paste'; }
        if ($case === 'raw-control') { $_SERVER['REQUEST_URI'] = "/previews/pr-101/paste\n"; }
        if ($case === 'disabled' || $case === 'missing-enabled') {
            $registry = json_decode($originalRegistry, true);
            if ($case === 'disabled') { $registry['tenants']['pr-101']['enabled'] = false; }
            else { unset($registry['tenants']['pr-101']['enabled']); }
            file_put_contents($root . '/registry.json', json_encode($registry));
        }
        if (in_array($case, ['tombstone', 'enabled-null', 'missing-token'], true)) {
            $registry = json_decode($originalRegistry, true);
            $registry['version'] = 2;
            if ($case !== 'missing-token') {
                $registry['tenants']['pr-101'] = ['enabled' => $case === 'enabled-null',
                    'active' => null, 'releases' => [], 'state_token' => str_repeat('1', 64)];
            }
            file_put_contents($root . '/registry.json', json_encode($registry));
        }
        if ($case === 'invalid-registry') { file_put_contents($root . '/registry.json', '{invalid'); }
        if ($case === 'huge-registry') { file_put_contents($root . '/registry.json', str_repeat(' ', 1048577)); }
        if ($case === 'missing-registry') { unlink($root . '/registry.json'); }
        if ($case === 'symlink-registry') {
            file_put_contents($root . '/registry-copy.json', $originalRegistry);
            unlink($root . '/registry.json');
            symlink($root . '/registry-copy.json', $root . '/registry.json');
        }
        if ($case === 'missing-entry') { rename($runtime, $runtime . '.disabled'); }
        if ($case === 'duplicate') { $GLOBALS['pbin_preview_selected'] = 'already-selected'; }
        ini_set('error_log', $root . '/expected-loader-errors.log');
        ob_start();
        // Rejected loader requests intentionally exit. Verify at shutdown that
        // no branch PHP executed, and restore fixtures for subsequent cases.
        register_shutdown_function(static function () use ($case, $root, $runtime, $originalRegistry): void {
            $body = ob_get_clean();
            if (is_link($root . '/registry.json')) { unlink($root . '/registry.json'); }
            file_put_contents($root . '/registry.json', $originalRegistry);
            if (is_file($runtime . '.disabled')) { rename($runtime . '.disabled', $runtime); }
            check(http_response_code() === 404 && $body === "Preview unavailable.\n", 'Rejected loader did not fail closed for ' . $case);
            check(!class_exists('Pbin\\Plugin\\Instance', false), 'Rejected loader executed branch PHP for ' . $case);
            check($GLOBALS['test_actions'] === [], 'Rejected loader registered branch actions for ' . $case);
            echo json_encode(['case' => $case, 'loaded' => false, 'rejected' => true, 'simulation' => true]);
        });
    }
    if ($case === 'retained-assets') {
        $retainedRuntime = $root . '/releases/pr-101/' . PREVIEW_TEST_OLD . '/pbin/runtime.php';
        $retainedOriginal = file_get_contents($retainedRuntime);
        file_put_contents($retainedRuntime, '<?php throw new \\RuntimeException("Retained package PHP must never execute");');
        ob_start();
        register_shutdown_function(static function () use ($retainedRuntime, $retainedOriginal): void {
            $body = ob_get_clean(); file_put_contents($retainedRuntime, $retainedOriginal);
            check($body === 'const release = ' . json_encode(PREVIEW_TEST_OLD) . ';', 'Trusted retained asset output changed');
            check(!class_exists('Pbin\\Plugin\\Instance', false), 'Retained asset loaded package PHP');
            check($GLOBALS['test_actions'] === [], 'Retained asset registered branch hooks/migrations');
            echo json_encode(['case' => 'retained-assets', 'loaded' => false, 'simulation' => true]);
        });
    }
    $loader = dirname(__DIR__) . '/preview/loader.php';
    if ($case !== 'native-cli') {
        $source = file_get_contents($loader);
        $source = str_replace("PHP_SAPI === 'cli'", 'false /* simulated web SAPI for test only */', $source, $replacements);
        check($replacements === 1, 'Web simulation must disable exactly one CLI check');
        $loader = $root . '/control/loader.php';
        file_put_contents($loader, $source);
        copy(dirname(__DIR__) . '/preview/selector.php', $root . '/control/selector.php');
        copy(dirname(__DIR__) . '/preview/health.php', $root . '/control/health.php');
        fixtureDirectory($root . '/control/control');
        copy(dirname(__DIR__) . '/preview/control/static-assets.php', $root . '/control/control/static-assets.php');
    }
    require $loader;
    $loaded = class_exists('Pbin\\Plugin\\Instance', false);
    if ($case === 'selected' || $case === 'retained-assets') {
        $revision = $case === 'selected' ? PREVIEW_TEST_A : PREVIEW_TEST_OLD;
        check($loaded, 'Preview package was not loaded');
        check(Instance::current()->key === 'pr_101', 'Wrong selected tenant');
        check(Instance::current()->revision === $revision, 'Wrong selected release');
        check(count($GLOBALS['test_actions']['plugins_loaded'] ?? []) === ($case === 'selected' ? 1 : 0), 'Pinned assets must not migrate or downgrade the tenant schema');
        $normal = apply_filters('option_active_plugins', ['other/other.php', 'pbin/pbin.php']);
        check(in_array('other/other.php', $normal, true) && !in_array('pbin/pbin.php', $normal, true), 'Normal plugin not suppressed');
        $network = apply_filters('site_option_active_sitewide_plugins', ['other/other.php' => 1, 'pbin/pbin.php' => 1]);
        check(isset($network['other/other.php']) && !isset($network['pbin/pbin.php']), 'Network active plugin not suppressed');
        require dirname(__DIR__) . '/pbin/pbin.php';
        check(Instance::current()->key === 'pr_101', 'Normal entrypoint replaced preview');
        check(count($GLOBALS['test_actions']['init'] ?? []) === 1, 'Multiple runtime routers registered');
        $files = array_filter(get_included_files(), fn($file) => str_contains($file, '/releases/'));
        foreach ($files as $file) { check(str_contains($file, '/pr-101/' . $revision . '/'), 'More than one release executed'); }
    } else {
        check(!$loaded && !isset($GLOBALS['pbin_preview_selected']), 'Excluded request loaded a package');
        check($GLOBALS['test_actions'] === [], 'Excluded request registered plugin callbacks');
    }
    echo json_encode(['case' => $case, 'loaded' => $loaded, 'simulation' => $case !== 'native-cli']);
    exit;
}

if (str_starts_with($mode, '--asset=')) {
    $case = substr($mode, strlen('--asset='));
    $root = $argv[2];
    define('ABSPATH', $root . '/wp/');
    $plugin = $root . '/asset-fixture/' . $case . '/pbin';
    fixtureDirectory($plugin);
    $outside = $root . '/outside.json';
    file_put_contents($outside, '{"outside":"must-not-be-disclosed"}');
    $route = '/static/js/fixture.js';
    $expected = '';
    $status = 404;
    if ($case === 'missing-root') {
        $route = '/static/' . ltrim($outside, '/');
    } elseif ($case === 'symlink-root') {
        fixtureDirectory($root . '/outside-static/js');
        file_put_contents($root . '/outside-static/js/fixture.js', 'outside-root');
        symlink($root . '/outside-static', $plugin . '/static');
    } else {
        fixtureDirectory($plugin . '/static/js');
        file_put_contents($plugin . '/static/js/fixture.js', 'const next = "/static/js/next.js";');
        if ($case === 'valid') {
            $expected = 'const next = "/previews/pr-101/_releases/' . PREVIEW_TEST_A . '/static/js/next.js";';
            $status = 200;
        } elseif ($case === 'symlink-file') {
            symlink($outside, $plugin . '/static/escape.json');
            $route = '/static/escape.json';
        } elseif ($case === 'traversal') {
            $route = '/static/../../../../outside.json';
        } elseif ($case === 'encoded-traversal') {
            $route = '/static/%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.json';
        } elseif ($case === 'php-extension') {
            file_put_contents($plugin . '/static/secret.php', '<?php echo "never expose source";');
            $route = '/static/secret.php';
        } elseif ($case === 'directory') {
            $route = '/static/js/';
        } elseif ($case === 'missing-file') {
            $route = '/static/missing.json';
        }
    }
    require dirname(__DIR__) . '/pbin/runtime.php';
    Instance::select(new Instance('pr_101', '/previews/pr-101', $plugin, PREVIEW_TEST_A, true));
    $db = new PreviewFixtureDB();
    $http = new \Pbin\Plugin\PBIN_HTTP(new PBIN_Store($db));
    http_response_code(200);
    ob_start(); $http->dispatch($route); $body = ob_get_clean();
    check(http_response_code() === $status, 'Unexpected asset status for ' . $case . ': ' . http_response_code());
    check($body === $expected, 'Asset escaped scope or rewriting changed for ' . $case);
    check($db->touched === [], 'Static asset accessed the database');
    echo json_encode(['case' => $case, 'status' => http_response_code()]);
    exit;
}

if (str_starts_with($mode, '--duplicate=')) {
    $case = substr($mode, strlen('--duplicate='));
    $root = $argv[2];
    define('ABSPATH', $root . '/wp/');
    $first = $root . '/releases/pr-101/' . PREVIEW_TEST_A . '/pbin';
    $second = $case === 'same' ? $first : $root . '/releases/pr-202/' . PREVIEW_TEST_B . '/pbin';
    require $first . '/runtime.php';
    \Pbin\Plugin\bootstrap(new Instance('pr_101', '/previews/pr-101', $first, PREVIEW_TEST_A, true));
    expectedException(static function () use ($second): void { require $second . '/runtime.php'; }, 'Duplicate runtime include', LogicException::class);
    check(Instance::current()->key === 'pr_101', 'Duplicate runtime changed selected context');
    check((new ReflectionClass(Instance::class))->getFileName() === $first . '/includes/instance.php', 'Duplicate runtime replaced class implementation');
    check(count($GLOBALS['test_actions']['init'] ?? []) === 1, 'Duplicate runtime registered another router');
    check(count($GLOBALS['test_actions']['plugins_loaded'] ?? []) === 1, 'Duplicate runtime registered another migration');
    echo json_encode(['case' => $case, 'rejected' => true]);
    exit;
}

require dirname(__DIR__) . '/pbin/includes/instance.php';
require dirname(__DIR__) . '/preview/selector.php';
$root = sys_get_temp_dir() . '/pbin-preview-test-' . bin2hex(random_bytes(8));
fixtureDirectory($root . '/wp/wp-admin/includes');
fixtureDirectory($root . '/control');
file_put_contents($root . '/wp/wp-admin/includes/upgrade.php', '<?php // Mock-only WordPress upgrade include.');
$a = createPackage($root, 'pr-101', PREVIEW_TEST_A);
$old = createPackage($root, 'pr-101', PREVIEW_TEST_OLD);
$b = createPackage($root, 'pr-202', PREVIEW_TEST_B);
$registry = ['version' => 1, 'tenants' => [
    'pr-101' => ['enabled' => true, 'active' => PREVIEW_TEST_A, 'releases' => [PREVIEW_TEST_A => [], PREVIEW_TEST_OLD => []]],
    'pr-202' => ['enabled' => true, 'active' => PREVIEW_TEST_B, 'releases' => [PREVIEW_TEST_B => []]],
]];
file_put_contents($root . '/registry.json', json_encode($registry));
$failures = [];
$count = 0;
$test = function (string $name, callable $fn) use (&$failures, &$count): void {
    ++$count;
    try { $fn(); } catch (Throwable $error) { $failures[] = $name . ': ' . $error->getMessage(); }
};
try {
    foreach (['/', '/pbin', '/wp-admin', '/wp-json/x', '/previews-other/pr-101'] as $path) {
        $test('unrelated ' . $path, fn() => check(Selector::resolve($path, $registry, $root) === null, 'Unrelated path selected package'));
    }
    foreach (['/previews', '/previews/', '/previews/pr-0', '/previews/pr-01', '/previews/pr--1', '/previews/pr-10000000000',
        '/previews/pr-101oops', '/previews/PR-101', '/previews/pr-303', '/previews//pr-101', '/previews/pr-101//paste',
        '/previews/pr-101\\paste', '/previews/pr-101/%2e%2e/paste', '/previews/pr-101/%252e/paste',
        '/previews/pr-101/../pr-202', '/previews/pr-101/./paste', '/previews/pr-101/static/js/fixture.js',
        "/previews/pr-101/paste\0.js", "/previews/pr-101/paste\n"] as $path) {
        $test('malformed ' . json_encode($path), fn() => expectedException(fn() => Selector::resolve($path, $registry, $root), 'Malformed path'));
    }
    $test('valid active A and B', function () use ($root, $registry, $a, $b) {
        $one = Selector::resolve('/previews/pr-101/paste', $registry, $root);
        $two = Selector::resolve('/previews/pr-202/paste', $registry, $root);
        check($one['key'] === 'pr_101' && $one['plugin_dir'] === $a && $one['revision'] === PREVIEW_TEST_A, 'Wrong A release');
        check($two['key'] === 'pr_202' && $two['plugin_dir'] === $b && $two['revision'] === PREVIEW_TEST_B, 'Wrong B release');
        check($one['data_dir'] !== $two['data_dir'], 'Shared data directory');
    });
    $test('disabled tenant', function () use ($root, $registry) { $registry['tenants']['pr-101']['enabled'] = false; expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Disabled tenant'); });
    $test('tenant needs explicit enabled flag', function () use ($root, $registry) { unset($registry['tenants']['pr-101']['enabled']); expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Missing enabled flag'); });
    $test('disabled invalid boolean', function () use ($root, $registry) { $registry['tenants']['pr-101']['enabled'] = 'true'; expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Invalid enabled value'); });
    $test('unsupported registry', function () use ($root, $registry) { $registry['version'] = 3; expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Unsupported registry'); });
    $test('v2 enabled tenants and retained assets', function () use ($root, $registry, $a, $old) {
        $registry['version'] = 2;
        foreach ($registry['tenants'] as &$record) { $record['state_token'] = str_repeat('1', 64); }
        unset($record);
        check(Selector::resolve('/previews/pr-101/paste', $registry, $root)['plugin_dir'] === $a, 'V2 active selection');
        check(Selector::resolve('/previews/pr-101/_releases/' . PREVIEW_TEST_OLD . '/static/js/fixture.js', $registry, $root)['plugin_dir'] === $old, 'V2 retained selection');
    });
    $test('v2 tombstone rejected before active validation', function () use ($root, $registry) {
        $registry['version'] = 2;
        $registry['tenants']['pr-101'] = ['enabled' => false, 'active' => null,
            'releases' => [], 'state_token' => str_repeat('1', 64)];
        try { Selector::resolve('/previews/pr-101/paste', $registry, $root); }
        catch (RuntimeException $error) { check($error->getMessage() === 'Unknown preview', 'Tombstone did not fail at disabled check'); return; }
        throw new RuntimeException('Tombstone was selected');
    });
    $test('enabled null active denied for normal and pinned routes in v1 and v2', function () use ($root, $registry) {
        foreach ([1, 2] as $version) {
            $registry['version'] = $version;
            $registry['tenants']['pr-101']['active'] = null;
            if ($version === 2) { $registry['tenants']['pr-101']['state_token'] = str_repeat('1', 64); }
            foreach (['/paste', '/_releases/' . PREVIEW_TEST_OLD . '/static/js/fixture.js'] as $route) {
                expectedException(fn() => Selector::resolve('/previews/pr-101' . $route, $registry, $root), 'Null active release');
            }
        }
    });
    $test('v2 state token required and validated', function () use ($root, $registry) {
        $registry['version'] = 2;
        foreach ([null, PREVIEW_TEST_A, str_repeat('A', 64), '', true] as $token) {
            $registry['tenants']['pr-101']['state_token'] = $token;
            expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Invalid v2 state token');
        }
    });
    $test('malformed active SHA', function () use ($root, $registry) { $registry['tenants']['pr-101']['active'] = '../escape'; expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Invalid SHA'); });
    $test('unregistered release', function () use ($root, $registry) { unset($registry['tenants']['pr-101']['releases'][PREVIEW_TEST_A]); expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Unregistered active release'); });
    $test('pinned old assets only', function () use ($root, $registry, $old) {
        $base = '/previews/pr-101/_releases/' . PREVIEW_TEST_OLD;
        $result = Selector::resolve($base . '/static/js/fixture.js', $registry, $root);
        check($result['plugin_dir'] === $old && $result['request_base_path'] === $base, 'Old asset did not select pinned release');
        foreach (['/paste', '/complete', '/static/', '/static/../../runtime.php', '/static/../js/fixture.js', '/static/js/fixture.js/..'] as $route) {
            expectedException(fn() => Selector::resolve($base . $route, $registry, $root), 'Old release non-asset/traversal route ' . $route);
        }
        expectedException(fn() => Selector::resolve('/previews/pr-101/_releases/' . PREVIEW_TEST_B . '/static/js/fixture.js', $registry, $root), 'Other tenant release');
    });
    $test('missing package', function () use ($root, $registry, $a) { rename($a, $a . '.hidden'); try { expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Missing package'); } finally { rename($a . '.hidden', $a); } });
    $test('missing runtime', function () use ($root, $registry, $a) { rename($a . '/runtime.php', $a . '/runtime.hidden'); try { expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Missing runtime'); } finally { rename($a . '/runtime.hidden', $a . '/runtime.php'); } });
    $test('symlink package', function () use ($root, $registry, $a, $b) { rename($a, $a . '.hidden'); symlink($b, $a); try { expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Symlink package'); } finally { unlink($a); rename($a . '.hidden', $a); } });
    $test('symlink runtime', function () use ($root, $registry, $a, $b) { rename($a . '/runtime.php', $a . '/runtime.hidden'); symlink($b . '/runtime.php', $a . '/runtime.php'); try { expectedException(fn() => Selector::resolve('/previews/pr-101/paste', $registry, $root), 'Symlink runtime'); } finally { unlink($a . '/runtime.php'); rename($a . '/runtime.hidden', $a . '/runtime.php'); } });
    $test('instance validation and paths', function () use ($a, $root) {
        expectedException(fn() => Instance::current(), 'Unselected context', LogicException::class);
        foreach (['pr-101', 'pr_0', 'pr_01', 'pr_101/other', '../default'] as $key) { expectedException(fn() => new Instance($key, '/preview', $a), 'Invalid key', InvalidArgumentException::class); }
        foreach (['/trailing/', '/dot/../path', '/encoded%2fpath', 'relative', '/query?x=1', '/fragment#x'] as $path) { expectedException(fn() => new Instance('default', $path, $a), 'Invalid mount path', InvalidArgumentException::class); }
        expectedException(fn() => new Instance('pr_101', '/previews/pr-101', $a, 'invalid', true), 'Mutable revision', InvalidArgumentException::class);
        expectedException(fn() => new Instance('default', '/previews/pr-101', $a, PREVIEW_TEST_A, true), 'Preview default key', InvalidArgumentException::class);
        expectedException(fn() => new Instance('default', '', $a . '/..'), 'Noncanonical package', InvalidArgumentException::class);
        $i = new Instance('pr_101', '/previews/pr-101', $a, PREVIEW_TEST_A, true);
        check($i->path('/paste') === '/previews/pr-101/paste', 'API URL changed to release path');
        check($i->path('/static/js/fixture.js') === '/previews/pr-101/_releases/' . PREVIEW_TEST_A . '/static/js/fixture.js', 'Asset URL is not immutable');
    });
    $contexts = [];
    foreach (['default', 'pr_101', 'pr_202'] as $key) { $test('context ' . $key, function () use ($key, $root, &$contexts) { $contexts[$key] = child('--context=' . $key, $root); }); }
    $test('distinct A/B and production scopes', function () use (&$contexts) {
        check(count($contexts) === 3, 'Missing contexts');
        check($contexts['default']['prefix'] === 'pbin_' && $contexts['default']['schema'] === 'pbin_schema_version' && $contexts['default']['cache'] === 'pbin', 'Production compatibility changed');
        foreach (['prefix', 'schema', 'cache', 'path', 'asset'] as $field) { check(count(array_unique(array_column($contexts, $field))) === 3, 'Shared ' . $field); }
        check(array_intersect($contexts['pr_101']['tables'], $contexts['pr_202']['tables']) === [], 'A/B used same table');
        check(array_intersect($contexts['default']['tables'], $contexts['pr_101']['tables']) === [], 'Production/preview used same table');
    });
    foreach (['native-cli', 'unrelated', 'admin-path', 'admin', 'cron', 'ajax', 'rest-path', 'rest', 'rest-query', 'wp-cli', 'selected', 'retained-assets', 'v2-selected', 'v2-retained-assets'] as $case) {
        $test('loader ' . $case, fn() => child('--loader=' . $case, $root));
    }
    foreach (['unconfigured', 'unknown', 'malformed', 'raw-control', 'disabled', 'tombstone', 'enabled-null', 'missing-token', 'missing-enabled', 'invalid-registry', 'huge-registry', 'missing-registry', 'symlink-registry', 'missing-entry', 'duplicate'] as $case) {
        $test('rejected loader ' . $case, function () use ($case, $root) { check((child('--loader=' . $case, $root)['rejected'] ?? false) === true, 'Loader did not reject'); });
    }
    foreach (['valid', 'missing-root', 'symlink-root', 'symlink-file', 'traversal', 'encoded-traversal', 'php-extension', 'directory', 'missing-file'] as $case) {
        $test('asset ' . $case, fn() => child('--asset=' . $case, $root));
    }
    foreach (['same', 'different'] as $case) {
        $test('duplicate runtime ' . $case, fn() => child('--duplicate=' . $case, $root));
    }
} finally { removeFixture($root); }
foreach ($failures as $failure) { fwrite(STDERR, 'FAIL: ' . $failure . "\n"); }
echo ($failures ? 'FAIL' : 'PASS') . ': ' . ($count - count($failures)) . '/' . $count . " preview tenancy checks\n";
echo "Scope: selector/filesystem checks, separate PHP request contexts, mocked WP hooks/options/SQL and simulated web loader. No real MySQL or browser/HTTP integration was exercised.\n";
exit($failures ? 1 : 0);
