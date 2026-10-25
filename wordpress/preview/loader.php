<?php
/** Trusted MU-plugin. Install this control plane once, never from a PR artifact. */
namespace Pbin\Preview;
defined('ABSPATH') || exit;

// Background and administration requests must not execute branch PHP.
if (PHP_SAPI === 'cli' || (defined('WP_CLI') && WP_CLI)
    || (defined('WP_ADMIN') && WP_ADMIN)
    || (defined('DOING_CRON') && DOING_CRON)
    || (defined('DOING_AJAX') && DOING_AJAX)
    || (defined('REST_REQUEST') && REST_REQUEST)
    || isset($_GET['rest_route'])) { return; }
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (!is_string($path) || ($path !== '/previews' && !str_starts_with($path, '/previews/'))) { return; }
try {
    if (preg_match('/[\x00-\x20\x7f]/', $_SERVER['REQUEST_URI'] ?? '')) { throw new \RuntimeException('Malformed preview request'); }
    if (isset($GLOBALS['pbin_preview_selected'])) { throw new \RuntimeException('A preview package was already selected'); }
    if (!defined('PBIN_PREVIEW_ROOT')) { throw new \RuntimeException('Preview storage is not configured'); }
    if (!defined('PBIN_PREVIEW_REGISTRY_BACKEND')) { throw new \RuntimeException('Preview registry backend must be explicitly configured'); }
    $root = realpath(PBIN_PREVIEW_ROOT);
    if (!$root) { throw new \RuntimeException('Preview storage unavailable'); }
    if (PBIN_PREVIEW_REGISTRY_BACKEND === 'mysql') {
        require_once __DIR__ . '/mysql-registry.php';
        require_once __DIR__ . '/control/controller.php';
        $configuration = Control\Configuration::wordpress(false);
        $configuration->storage->ready();
        $registry = (new MysqlRegistry($GLOBALS['wpdb']))->snapshot();
    } elseif (PBIN_PREVIEW_REGISTRY_BACKEND === 'file') {
        // Explicit fixture/compatibility mode only; never a MySQL failure fallback.
        if (!is_file($root . '/registry.json') || is_link($root . '/registry.json')) { throw new \RuntimeException('Preview registry unavailable'); }
        if (filesize($root . '/registry.json') > 1048576) { throw new \RuntimeException('Preview registry is too large'); }
        $registry = json_decode(file_get_contents($root . '/registry.json'), true, 32, JSON_THROW_ON_ERROR);
    } else { throw new \RuntimeException('Unknown preview registry backend'); }
    require_once __DIR__ . '/selector.php';
    $context = Selector::resolve($path, $registry, $root);
    if ($context === null) { return; }
    require_once __DIR__ . '/health.php';
    Health::install(Health::headers($path, $context, parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_QUERY) ?? ''));
    $GLOBALS['pbin_preview_selected'] = $context['revision'];
    // Normal/network activation must not load a second copy later in wp-settings.
    $normalPlugin = defined('PBIN_PREVIEW_NORMAL_PLUGIN') ? PBIN_PREVIEW_NORMAL_PLUGIN : 'pbin/pbin.php';
    add_filter('option_active_plugins', static fn($plugins) => array_values(array_diff((array) $plugins, [$normalPlugin])));
    add_filter('site_option_active_sitewide_plugins', static function ($plugins) use ($normalPlugin) {
        unset($plugins[$normalPlugin]); return $plugins;
    });
    // All release paths were validated before any branch PHP is included.
    require $context['plugin_dir'] . '/runtime.php';
    \Pbin\Plugin\bootstrap(new \Pbin\Plugin\Instance(
        $context['key'], $context['base_path'], $context['plugin_dir'],
        $context['revision'], true, $context['request_base_path'], $context['data_dir']
    ));
} catch (\Throwable $error) {
    error_log('pbin preview unavailable: ' . $error->getMessage());
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo "Preview unavailable.\n";
    exit;
}
