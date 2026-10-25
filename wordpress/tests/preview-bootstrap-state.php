<?php
/**
 * Control-flow regression only: a fake bootstrap clears common globals, as
 * WordPress does. No live WordPress, database, or tenant isolation is claimed.
 */
$fixture = sys_get_temp_dir() . '/pbin-bootstrap-state.' . bin2hex(random_bytes(8));
$site = $fixture . '/site';
$plugin = $fixture . '/plugin';
mkdir($site . '/wp-includes', 0700, true);
mkdir($plugin, 0700, true);
$files = [];
function putBootstrapFixture(string $path, string $contents): void {
    $GLOBALS['files'][] = $path;
    if (file_put_contents($path, $contents) === false) { throw new RuntimeException('Cannot write bootstrap regression fixture'); }
}
try {
    putBootstrapFixture($site . '/wp-includes/plugin.php', <<<'STUB'
<?php
function add_filter($name, $callback) { $GLOBALS['bootstrap_filters'][$name] = $callback; }
STUB);
    putBootstrapFixture($site . '/wp-load.php', <<<'STUB'
<?php
// Ensure the fixture has not "fixed" collisions by changing WP include scope.
$bootstrap_global_scope = true;
if (!isset($GLOBALS['bootstrap_global_scope'])) { throw new RuntimeException('WordPress bootstrap left global scope'); }
$active = $GLOBALS['bootstrap_filters']['option_active_plugins'];
$network = $GLOBALS['bootstrap_filters']['site_option_active_sitewide_plugins'];
if ($active(['pbin/pbin.php', 'other/plugin.php']) !== ['other/plugin.php']
    || $network(['pbin/pbin.php' => 1, 'other/plugin.php' => 2]) !== ['other/plugin.php' => 2]) {
    throw new RuntimeException('Fixture plugin exclusion changed');
}
// The first is the actual WordPress default-filters.php cleanup. The rest guard
// other request state against generic global names used by bootstrap includes.
unset($action);
if (getenv('PBIN_BOOTSTRAP_REGRESSION_CLEANUP') === 'all') {
    unset($key, $input, $expectedDB, $fixtureRoot, $wpLoad, $normalPlugin, $mode, $plugin);
}
define('DB_NAME', getenv('PBIN_TEST_DATABASE_NAME'));
define('DB_HOST', '127.0.0.1:3306');
$GLOBALS['wpdb'] = (object) ['prefix' => 'wp_fixture_'];
function get_option($name, $default = false) { return $default; }
STUB);
    putBootstrapFixture($plugin . '/runtime.php', <<<'STUB'
<?php
namespace Pbin\Plugin;
final class Instance {
    public static $selected;
    public function __construct(public string $key, ...$unused) {}
    public static function select($instance): void { self::$selected = $instance; }
    public function storagePrefix(): string { return 'pbin_' . $this->key . '_'; }
}
final class PBIN_Store {
    public function __construct($db) {}
    public static function install(): void {
        // Stop before any SQL: reaching the write branch proves the bootstrap
        // did not erase the action, tenant, input, or expected database state.
        echo json_encode(['key' => Instance::$selected->key, 'run_id' => $GLOBALS['runId'], 'write_reached' => true]), "\n";
        exit;
    }
}
STUB);
    $environment = array_merge(getenv(), [
        'PBIN_TEST_ALLOW_DATABASE_MUTATION' => '1',
        'PBIN_WP_FIXTURE' => $fixture,
        'PBIN_WORDPRESS_LOAD' => $site . '/wp-load.php',
        'PBIN_TEST_DATABASE_NAME' => 'pbin_ci_' . str_repeat('a', 24),
        'PBIN_TEST_PLUGIN_DIR' => $plugin,
        'PBIN_TEST_NORMAL_PLUGIN' => 'pbin/pbin.php',
    ]);
    foreach (['action', 'all'] as $cleanup) {
        $environment['PBIN_BOOTSTRAP_REGRESSION_CLEANUP'] = $cleanup;
        $process = proc_open([PHP_BINARY, '-n', __DIR__ . '/preview-tenancy.php', '--wordpress-context=pr_910001', 'write', '{"run_id":"bootstrap-state"}'],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $environment);
        if (!is_resource($process)) { throw new RuntimeException('Cannot launch bootstrap regression'); }
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]); fclose($pipes[1]);
        $stderr = stream_get_contents($pipes[2]); fclose($pipes[2]);
        $status = proc_close($process);
        $expected = ['key' => 'pr_910001', 'run_id' => 'bootstrap-state', 'write_reached' => true];
        if ($status !== 0 || $stderr !== '' || json_decode($stdout, true) !== $expected) {
            throw new RuntimeException('Bootstrap request state regression: ' . $stderr . $stdout);
        }
    }
    echo "PASS: fixture request state survives global bootstrap cleanup (no database exercised)\n";
} finally {
    foreach (array_reverse($files) as $file) { unlink($file); }
    rmdir($site . '/wp-includes'); rmdir($site); rmdir($plugin); rmdir($fixture);
}
