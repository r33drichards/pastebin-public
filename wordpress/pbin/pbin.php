<?php
/**
 * Plugin Name: pbin single-user pastebin
 * Description: A scoped PHP/MySQL port of pbin's paste, diff and immutable snapshot API.
 * Version: 0.1.0
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * License: MIT
 */
defined('ABSPATH') || exit;

define('PBIN_PLUGIN_DIR', __DIR__);
require_once __DIR__ . '/includes/store.php';
require_once __DIR__ . '/includes/http.php';

register_activation_hook(__FILE__, static function () { PBIN_Store::install(); });
add_action('plugins_loaded', static function () {
    if (get_option('pbin_schema_version') !== PBIN_Store::SCHEMA_VERSION) {
        PBIN_Store::install();
    }

});
// Deliberately scoped, without a global rewrite or theme dependency. No flush is
// necessary, and disabling the plugin immediately restores ordinary WP routes.
add_action('init', static function () {
    // Do not hijack WP-CLI, maintenance scripts, or a PHP realtime process.
    if (PHP_SAPI === 'cli' || (defined('WP_CLI') && WP_CLI)) { return; }
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $base = pbin_base_path();
    if ($path !== $base && !str_starts_with($path, $base . '/')) {
        return;
    }
    $route = substr($path, strlen($base));
    (new PBIN_HTTP(new PBIN_Store()))->dispatch($route === '' ? '/' : $route);
    exit;
}, 0);
