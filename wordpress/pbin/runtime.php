<?php
namespace Pbin\Plugin;
defined('ABSPATH') || exit;
if (isset($GLOBALS['pbin_runtime_loaded'])) { throw new \LogicException('Only one pbin runtime may load per request'); }
$GLOBALS['pbin_runtime_loaded'] = __FILE__;
require_once __DIR__ . '/includes/instance.php';
require_once __DIR__ . '/includes/store.php';
require_once __DIR__ . '/includes/http.php';

if (!function_exists(__NAMESPACE__ . '\\bootstrap')) {
function bootstrap(Instance $instance): void {
    Instance::select($instance);
    // Retained revision URLs are assets-only. They must never migrate shared
    // tenant tables or move the schema marker backwards after a promotion.
    $assetRequest = $instance->preview && $instance->requestBasePath !== null && $instance->requestBasePath !== $instance->basePath;
    if (!$assetRequest) {
    add_action('plugins_loaded', static function () {
        $instance = Instance::current();
        if (get_option($instance->optionKey('schema_version')) !== PBIN_Store::schemaVersion()) { PBIN_Store::install(); }
    });
    }
    add_action('init', static function () {
        if (PHP_SAPI === 'cli' || (defined('WP_CLI') && WP_CLI)) { return; }
        $instance = Instance::current();
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
        if (!is_string($path)) { return; }
        $route = $instance->routeForPath($path, $_SERVER['REQUEST_METHOD'] ?? 'GET', isset($_GET['id']) && is_scalar($_GET['id']) && (string) $_GET['id'] !== '');
        if ($route === null) { return; }
        if ($instance->preview) {
            header('X-Pbin-Instance: ' . $instance->key);
            header('X-Pbin-Revision: ' . $instance->revision);
            header('X-Robots-Tag: noindex, nofollow, noarchive');
            header('Cache-Control: no-store'); // Immutable asset responses override this.
        }
        (new PBIN_HTTP(new PBIN_Store()))->dispatch($route);
        exit;
    }, 0);
}
}
