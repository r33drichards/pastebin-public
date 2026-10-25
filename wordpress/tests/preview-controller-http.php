<?php
/** Offline process tests of early adapter and MySQL loader selection, using WP/wpdb doubles. */
function check(bool $value, string $message): void { if (!$value) { throw new RuntimeException($message); } }
function removeTest(string $path): void {
    if (is_file($path) || is_link($path)) { unlink($path); return; }
    chmod($path, 0700); foreach (scandir($path) ?: [] as $name) { if ($name !== '.' && $name !== '..') { removeTest($path . '/' . $name); } } rmdir($path);
}
$mode = $argv[1] ?? '';
if ($mode === '') {
    $cases = ['anonymous' => 403, 'missing-nonce' => 403, 'bad-nonce' => 403, 'app-error' => 403,
        'wrong-principal' => 403, 'wrong-capability' => 403, 'wrong-method' => 405, 'unknown-route' => 404,
        'query-route' => 403, 'cookie-get' => 200, 'app-get' => 200, 'disabled-setup' => 200,
        'loader-mysql' => 200, 'loader-mysql-unavailable' => 404, 'loader-bad-health-nonce' => 404];
    foreach ($cases as $case => $expected) {
        $process = proc_open([PHP_BINARY, __FILE__, $case], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        check(is_resource($process), 'Cannot launch offline child'); fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]); $errors = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
        check(proc_close($process) === 0 && $errors === '', 'Offline child failed: ' . $case . ': ' . $errors);
        $result = json_decode($output, true, 8, JSON_THROW_ON_ERROR);
        check($result['status'] === $expected, 'Unexpected status for ' . $case . ': ' . $output);
        if (str_starts_with($case, 'loader-')) {
            check($result['executed'] === ($case === 'loader-mysql'), 'Wrong branch execution for ' . $case);
        } elseif ($expected !== 200) {
            check($result['db_reads'] === 0, 'Rejected request reached database before authorization/validation');
        }
        echo "PASS: offline adapter/loader $case\n";
    }
    echo "PASS: 15 offline adapter/loader cases; not actual WordPress authentication or hosted SQL\n";
    exit;
}
$work = sys_get_temp_dir() . '/pbin-http-double-' . bin2hex(random_bytes(8)); mkdir($work, 0700);
foreach (['site', 'private', 'private/.uploads', 'private/releases', 'private/data'] as $path) { mkdir($work . '/' . $path, 0700); }
$control = dirname(__DIR__) . '/preview';
define('ABSPATH', $work . '/site/');
define('PBIN_PREVIEW_ROOT', $work . '/private');
define('PBIN_PREVIEW_STAGING', true);
define('PBIN_PREVIEW_STAGING_ORIGIN', 'https://fixture.invalid');
define('PBIN_PREVIEW_REGISTRY_BACKEND', 'mysql');
define('PBIN_PREVIEW_CONTROLLER_ENABLED', true);
define('PBIN_PREVIEW_AUTOMATION_USER_ID', '77');
function wp_get_environment_type(): string { return 'staging'; }
function home_url(): string { return 'https://fixture.invalid'; }
function is_ssl(): bool { return true; }
function wp_unslash($value) { return $value; }
function status_header(int $status): void { http_response_code($status); }
$GLOBALS['hooks'] = [];
function add_action(...$args): void { $GLOBALS['hooks'][$args[0]][] = $args; }
function add_filter(...$args): void {}
class WP_User { public function exists(): bool { return $GLOBALS['logged']; } }
class WP_Error {}
function is_wp_error($value): bool { return $value instanceof WP_Error; }
function wp_get_current_user() { return $GLOBALS['current_user'] ??= new WP_User(); }
function is_user_logged_in(): bool { return $GLOBALS['logged']; }
function get_current_user_id(): int { return $GLOBALS['user_id']; }
function current_user_can(string $cap): bool { return in_array($cap, $GLOBALS['caps'], true); }
function rest_get_authenticated_app_password() { return $GLOBALS['app']; }
function rest_cookie_check_errors($error) {
    if ($GLOBALS['nonce'] === 'missing') { $GLOBALS['logged'] = false; return true; }
    return $GLOBALS['nonce'] === 'valid' ? true : new WP_Error();
}
function rest_get_server() {
    return new class {
        public function check_authentication() {
            if ($GLOBALS['auth_error']) { return new WP_Error(); }
            return $GLOBALS['app'] !== null ? true : rest_cookie_check_errors(null);
        }
        public function get_headers($server): array { return []; }
    };
}
class ReadWpdb {
    public string $base_prefix = 'wp_';
    public string $last_error = '';
    public function suppress_errors($value): bool { return false; }
    public function query($sql) { throw new RuntimeException('Read/loader attempted migration or mutation'); }
    public function prepare($sql, ...$values): string { return $sql; }
    public function get_results($sql, $format): array {
        ++$GLOBALS['db_reads'];
        if ($GLOBALS['db_unavailable']) { $this->last_error = 'unavailable'; return []; }
        if (str_starts_with($sql, 'SELECT ENGINE')) { return [['ENGINE' => 'InnoDB', 'TABLE_COLLATION' => 'utf8mb4_bin']]; }
        if (str_starts_with($sql, 'SHOW COLUMNS')) {
            $rows = [];
            foreach (['singleton_id' => ['tinyint unsigned', 'PRI'], 'schema_version' => ['smallint unsigned', ''], 'state_json' => ['mediumtext', '']] as $name => $shape) {
                $rows[] = ['Field' => $name, 'Type' => $shape[0], 'Null' => 'NO', 'Key' => $shape[1], 'Default' => null, 'Extra' => ''];
            }
            return $rows;
        }
        $state = $GLOBALS['registry_json'];
        return [['singleton_id' => '1', 'schema_version' => '2', 'state_json' => $state, 'state_bytes' => (string) strlen($state), 'connection_id' => '1']];
    }
}
$GLOBALS['db_reads'] = 0; $GLOBALS['db_unavailable'] = false; $GLOBALS['wpdb'] = new ReadWpdb();
$GLOBALS['registry_json'] = '{"version":2,"tenants":{}}';
$GLOBALS['logged'] = true; $GLOBALS['current_user'] = new WP_User(); $GLOBALS['wp_rest_auth_cookie'] = true;
$GLOBALS['app'] = null; $GLOBALS['nonce'] = 'valid'; $GLOBALS['auth_error'] = false; $GLOBALS['user_id'] = 77; $GLOBALS['caps'] = ['manage_options'];
$GLOBALS['executed'] = false;
ini_set('error_log', $work . '/expected-errors.log');
ob_start();
register_shutdown_function(static function () use ($work): void {
    $body = ob_get_clean(); $status = http_response_code() ?: 200;
    $result = ['status' => $status, 'db_reads' => $GLOBALS['db_reads'], 'executed' => $GLOBALS['executed'], 'body' => $body];
    removeTest($work); echo json_encode($result, JSON_THROW_ON_ERROR);
});
if (str_starts_with($mode, 'loader-')) {
    $sha = str_repeat('a', 40); $token = str_repeat('b', 64); $digest = str_repeat('c', 64);
    $root = $work . '/private/releases/pr-1/' . $sha; mkdir($work . '/private/releases/pr-1', 0700); mkdir($root, 0700); mkdir($root . '/pbin', 0700);
    file_put_contents($root . '/pbin/runtime.php', '<?php namespace Pbin\\Plugin; class Instance { public function __construct(...$args) {} } function bootstrap($instance) { $GLOBALS["executed"] = true; echo "BRANCH"; }');
    $GLOBALS['registry_json'] = json_encode(['version' => 2, 'tenants' => ['pr-1' => ['state_token' => $token, 'enabled' => true, 'active' => $sha, 'releases' => [$sha => ['artifact_sha256' => $digest, 'manifest_sha256' => $digest]]]]], JSON_UNESCAPED_SLASHES);
    file_put_contents($work . '/private/registry.json', $GLOBALS['registry_json']); // Must NEVER be a MySQL error fallback.
    $GLOBALS['db_unavailable'] = $mode === 'loader-mysql-unavailable';
    $_SERVER['REQUEST_URI'] = $mode === 'loader-bad-health-nonce' ? '/previews/pr-1/health?pbin-health-nonce=bad' : '/previews/pr-1/paste';
    mkdir($work . '/control', 0700); mkdir($work . '/control/control', 0700);
    foreach (['mysql-registry.php', 'selector.php', 'health.php'] as $file) { copy($control . '/' . $file, $work . '/control/' . $file); }
    foreach (['controller.php', 'storage.php'] as $file) { copy($control . '/control/' . $file, $work . '/control/control/' . $file); }
    $source = str_replace("PHP_SAPI === 'cli'", 'false /* Offline web-SAPI simulation only */', file_get_contents($control . '/loader.php'), $replaced);
    check($replaced === 1, 'Must bypass exactly one CLI check in test copy');
    file_put_contents($work . '/control/loader.php', $source); require $work . '/control/loader.php'; exit;
}
require $control . '/controller.php';
if ($mode === 'disabled-setup') {
    check(!isset($GLOBALS['hooks']['admin_post_pbin_preview_install_schema']), 'Setup enabled by default');
    check(count($GLOBALS['hooks']['parse_request'] ?? []) === 1 && $GLOBALS['hooks']['parse_request'][0][2] === 0, 'Early bounded adapter not registered before core');
    echo 'SETUP_DISABLED'; exit;
}
$route = '/pbin-previews/v1/tenants/pr-1'; $_SERVER['REQUEST_METHOD'] = 'GET';
if (in_array($mode, ['missing-nonce', 'bad-nonce'], true)) { $GLOBALS['nonce'] = $mode === 'missing-nonce' ? 'missing' : 'bad'; $route .= '/releases/' . str_repeat('a', 40); $_SERVER['REQUEST_METHOD'] = 'POST'; }
if ($mode === 'anonymous' || $mode === 'query-route') { $GLOBALS['logged'] = false; }
if ($mode === 'app-get' || $mode === 'app-error' || $mode === 'wrong-principal' || $mode === 'wrong-capability') {
    $GLOBALS['app'] = 'app-uuid'; $GLOBALS['wp_rest_auth_cookie'] = false; $GLOBALS['caps'] = ['pbin_manage_previews'];
}
if ($mode === 'app-error') { $GLOBALS['auth_error'] = true; }
if ($mode === 'wrong-principal') { $GLOBALS['user_id'] = 78; }
if ($mode === 'wrong-capability') { $GLOBALS['caps'] = ['manage_options']; }
if ($mode === 'wrong-method') { $_SERVER['REQUEST_METHOD'] = 'DELETE'; }
if ($mode === 'unknown-route') { $route .= '/not-a-route'; }
if ($mode === 'query-route') { $_GET['rest_route'] = $route; $_SERVER['REQUEST_URI'] = '/?rest_route=' . rawurlencode($route); }
$wp = (object) ['query_vars' => ['rest_route' => $route]];
Pbin\Preview\Control\Endpoint::maybeServe($wp);
throw new RuntimeException('Exact controller route was not handled');
