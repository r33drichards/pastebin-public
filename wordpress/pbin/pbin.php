<?php
namespace Pbin\Plugin;
/**
 * Plugin Name: pbin single-user pastebin
 * Description: A scoped PHP/MySQL port of pbin's paste, diff and immutable snapshot API.
 * Version: 0.2.0
 * Requires at least: 6.4
 * Requires PHP: 8.1
 * License: MIT
 */
defined('ABSPATH') || exit;
// The trusted MU loader already selected a release for this request.
if (isset($GLOBALS['pbin_preview_selected'])) { return; }
require_once __DIR__ . '/runtime.php';
$base = defined('PBIN_WP_BASE_PATH') ? PBIN_WP_BASE_PATH : parse_url(home_url('/paste'), PHP_URL_PATH);
$editorAtBase = defined('PBIN_WP_EDITOR_AT_BASE') ? (bool) PBIN_WP_EDITOR_AT_BASE : !defined('PBIN_WP_BASE_PATH');
$aliases = defined('PBIN_WP_ALIASES') ? PBIN_WP_ALIASES : [(string) parse_url(home_url('/pbin-wp-test'), PHP_URL_PATH)];
bootstrap(new Instance('default', rtrim((string) $base, '/'), __DIR__, '', false, null, null, $editorAtBase, $aliases));
register_activation_hook(__FILE__, static function () { PBIN_Store::install(); });
