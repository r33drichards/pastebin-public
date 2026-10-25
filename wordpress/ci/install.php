<?php
// Installs a disposable fixture, never an existing WordPress site.
$site = getenv('PBIN_WP_TEST_SITE') ?: '';
if (!str_contains($site, '/pbin-wp-ci.') || !is_dir($site) || is_file($site . '/wp-config.php')) {
    throw new RuntimeException('Refusing a non-disposable or already configured site');
}
$config = [
    'DB_NAME' => getenv('PBIN_TEST_DB_NAME'),
    'DB_USER' => getenv('PBIN_TEST_DB_USER') ?: 'root',
    'DB_PASSWORD' => getenv('PBIN_TEST_DB_PASSWORD') ?: '',
    'DB_HOST' => (getenv('PBIN_TEST_DB_HOST') ?: '127.0.0.1') . ':' . (getenv('PBIN_TEST_DB_PORT') ?: '3306'),
    'DB_CHARSET' => 'utf8mb4', 'DB_COLLATE' => '',
    'WP_HOME' => getenv('PBIN_ACCEPTANCE_URL'), 'WP_SITEURL' => getenv('PBIN_ACCEPTANCE_URL'),
    'WP_DEBUG' => true, 'WP_DEBUG_DISPLAY' => false, 'WP_DEBUG_LOG' => dirname($site) . '/wp-debug.log',
    'WP_AUTO_UPDATE_CORE' => false, 'AUTOMATIC_UPDATER_DISABLED' => true,
    'WP_HTTP_BLOCK_EXTERNAL' => true, 'DISABLE_WP_CRON' => true,
    'PBIN_WP_BASE_PATH' => getenv('PBIN_TEST_BASE_PATH') ?: '',
];
$editorAtBase = getenv('PBIN_TEST_EDITOR_AT_BASE');
if ($editorAtBase !== false && $editorAtBase !== '') {
    if (!in_array($editorAtBase, ['0', '1'], true)) { throw new InvalidArgumentException('PBIN_TEST_EDITOR_AT_BASE must be 0 or 1'); }
    $config['PBIN_WP_EDITOR_AT_BASE'] = $editorAtBase === '1';
}
// Optional trusted test setup may install the preview control plane before boot.
if (getenv('PBIN_TEST_PREVIEW_ROOT')) { $config['PBIN_PREVIEW_ROOT'] = getenv('PBIN_TEST_PREVIEW_ROOT'); }
$contents = "<?php\n// Disposable fixture, not a production configuration.\n";
foreach ($config as $key => $value) { $contents .= 'define(' . var_export($key, true) . ', ' . var_export($value, true) . ");\n"; }
$contents .= "\$table_prefix = 'wp_';\nif (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }\nrequire ABSPATH . 'wp-settings.php';\n";
if (file_put_contents($site . '/wp-config.php', $contents) === false) { throw new RuntimeException('Cannot write test configuration'); }
define('WP_INSTALLING', true);
function wp_mail($to, $subject, $message, $headers = '', $attachments = []) { return true; }
require $site . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$result = wp_install('pbin CI', 'pbin-test-admin', 'nobody@example.invalid', false, '', bin2hex(random_bytes(24)));
if (is_wp_error($result)) { throw new RuntimeException($result->get_error_message()); }
$result = activate_plugin('pbin/pbin.php');
if (is_wp_error($result)) { throw new RuntimeException($result->get_error_message()); }
if (!is_plugin_active('pbin/pbin.php')) { throw new RuntimeException('Plugin activation did not persist'); }
echo "PASS: real WordPress installed and packaged pbin activated\n";
