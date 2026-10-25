<?php
/** Trusted staging-only MU control plane. Install separately, never in a PR ZIP. */
namespace Pbin\Preview;
defined('ABSPATH') || exit;
require_once __DIR__ . '/mysql-registry.php';
require_once __DIR__ . '/control/native-package.php';
require_once __DIR__ . '/control/rest.php';

// No credential/principal/capability is created, and the default is disabled.
if (defined('PBIN_PREVIEW_CONTROLLER_ENABLED') && PBIN_PREVIEW_CONTROLLER_ENABLED === true) {
    add_action('parse_request', [Control\Endpoint::class, 'maybeServe'], 0);
}
// Administrative setup is a distinct, additionally disabled-by-default action.
// It does not run during reads, loader selection, activation or ordinary boot.
if (defined('PBIN_PREVIEW_SETUP_ENABLED') && PBIN_PREVIEW_SETUP_ENABLED === true) {
    add_action('admin_post_pbin_preview_install_schema', static function (): void {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !is_ssl() || !current_user_can('manage_options')) { wp_die('Not authorized', '', ['response' => 403]); }
        check_admin_referer('pbin_preview_install_schema');
        try {
            $config = Control\Configuration::wordpress();
            $config->storage->initialize();
            (new MysqlRegistry($GLOBALS['wpdb']))->installSchema();
        } catch (\Throwable $error) { wp_die('Preview setup failed; inspect the trusted configuration before retrying.', '', ['response' => 503]); }
        wp_die('Preview schema and private directories verified.', '', ['response' => 200]);
    });
}
