<?php
/** Test-only account/config setup; never loaded by the plugin or a public route. */
function controllerFixtureCheck(bool $ok): void { if (!$ok) { throw new RuntimeException('Invalid disposable controller fixture'); } }
try {
    controllerFixtureCheck(getenv('PBIN_CONTROLLER_GATE') === '1' && getenv('PBIN_TEST_ALLOW_DATABASE_MUTATION') === '1' && getenv('GITHUB_ACTIONS') === 'true');
    $pbinControllerWork = getenv('PBIN_WP_FIXTURE') ?: '';
    $pbinControllerDb = getenv('PBIN_TEST_DB_NAME') ?: '';
    $pbinControllerLoad = getenv('PBIN_WORDPRESS_LOAD') ?: '';
    controllerFixtureCheck(is_dir($pbinControllerWork) && realpath($pbinControllerWork) === $pbinControllerWork && str_contains($pbinControllerWork, '/pbin-wp-ci.'));
    controllerFixtureCheck(preg_match('/\Apbin_ci_[a-f0-9]{24}\z/', $pbinControllerDb) === 1);
    controllerFixtureCheck($pbinControllerLoad === $pbinControllerWork . '/site/wp-load.php' && realpath($pbinControllerLoad) === $pbinControllerLoad);
    controllerFixtureCheck(in_array(getenv('PBIN_TEST_DB_HOST'), ['127.0.0.1', 'localhost'], true));
    $pbinControllerMode = $argv[1] ?? '';
    controllerFixtureCheck(in_array($pbinControllerMode, ['prepare', 'deny-capability', 'restore-capability', 'check-default'], true));
    $pbinControllerSecrets = $pbinControllerWork . '/controller-secrets.json';
    if ($pbinControllerMode === 'prepare') {
        controllerFixtureCheck(!file_exists($pbinControllerSecrets));
        $pbinControllerRoot = $pbinControllerWork . '/controller-private';
        controllerFixtureCheck(mkdir($pbinControllerRoot, 0700));
        $pbinControllerMarker = bin2hex(random_bytes(32));
        $pbinControllerConfigPath = $pbinControllerWork . '/site/wp-config.php';
        $pbinControllerConfig = file_get_contents($pbinControllerConfigPath);
        controllerFixtureCheck(is_string($pbinControllerConfig) && !str_contains($pbinControllerConfig, 'PBIN_PREVIEW_ROOT'));
        foreach (['WP_HOME' => 'https://controller-fixture.invalid', 'WP_SITEURL' => 'https://controller-fixture.invalid', 'WP_DEBUG' => false, 'WP_DEBUG_LOG' => false] as $name => $value) {
            $pbinControllerConfig = preg_replace('/^define\(\'' . $name . '\', .*\);$/m', 'define(' . var_export($name, true) . ', ' . var_export($value, true) . ');', $pbinControllerConfig, -1, $count);
            controllerFixtureCheck($count === 1);
        }
        $extra = "\n// Private disposable loopback HTTPS fixture ONLY.\n";
        foreach (['WP_ENVIRONMENT_TYPE' => 'staging', 'PBIN_PREVIEW_STAGING' => true, 'PBIN_PREVIEW_STAGING_ORIGIN' => 'https://controller-fixture.invalid', 'PBIN_PREVIEW_CONTROLLER_ENABLED' => true, 'PBIN_PREVIEW_REGISTRY_BACKEND' => 'mysql', 'PBIN_PREVIEW_ROOT' => $pbinControllerRoot] as $name => $value) {
            $extra .= 'define(' . var_export($name, true) . ', ' . var_export($value, true) . ");\n";
        }
        // Only this loopback proxy can mark an HTTP backend request as HTTPS.
        // The marker is private, regenerated per fixture and never logged.
        $extra .= "if ((\$_SERVER['REMOTE_ADDR'] ?? '') === '127.0.0.1' && hash_equals(" . var_export($pbinControllerMarker, true) . ", \$_SERVER['HTTP_X_PBIN_FIXTURE_TLS'] ?? '')) { \$_SERVER['HTTPS'] = 'on'; }\n";
        $pbinControllerConfig = str_replace("\$table_prefix = 'wp_';", $extra . "\$table_prefix = 'wp_';", $pbinControllerConfig, $count);
        controllerFixtureCheck($count === 1 && file_put_contents($pbinControllerConfigPath, $pbinControllerConfig) !== false);
        chmod($pbinControllerConfigPath, 0600);
        $pbinControllerMu = $pbinControllerWork . '/site/wp-content/mu-plugins';
        if (!is_dir($pbinControllerMu)) { controllerFixtureCheck(mkdir($pbinControllerMu, 0700)); }
        $pbinControllerTarget = $pbinControllerMu . '/pbin-preview';
        controllerFixtureCheck(mkdir($pbinControllerTarget, 0700) && mkdir($pbinControllerTarget . '/control', 0700));
        $pbinControllerSource = dirname(__DIR__) . '/preview';
        foreach (['controller.php', 'loader.php', 'selector.php', 'health.php', 'mysql-registry.php'] as $file) { controllerFixtureCheck(copy($pbinControllerSource . '/' . $file, $pbinControllerTarget . '/' . $file)); }
        foreach (['controller.php', 'maintenance.php', 'native-package.php', 'quota-recipe.php', 'rest.php', 'static-assets.php', 'storage.php'] as $file) { controllerFixtureCheck(copy($pbinControllerSource . '/control/' . $file, $pbinControllerTarget . '/control/' . $file)); }
        controllerFixtureCheck(file_put_contents($pbinControllerMu . '/pbin-preview.php', "<?php\n\$GLOBALS['wpdb']->suppress_errors(true); // Fixture-only: never log SQL/credential material.\nrequire __DIR__ . '/pbin-preview/controller.php';\nrequire __DIR__ . '/pbin-preview/loader.php';\n") !== false);
    }
    require $pbinControllerLoad;
    controllerFixtureCheck(DB_NAME === $pbinControllerDb && preg_match('/\A(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\z/', DB_HOST) === 1);
    $GLOBALS['wpdb']->suppress_errors(true);
    if ($pbinControllerMode !== 'prepare') {
        controllerFixtureCheck(is_file($pbinControllerSecrets) && !is_link($pbinControllerSecrets));
        $pbinControllerPrivate = json_decode(file_get_contents($pbinControllerSecrets), true, 16, JSON_THROW_ON_ERROR);
        $pbinControllerUser = get_user_by('id', $pbinControllerPrivate['deployer_id']);
        controllerFixtureCheck($pbinControllerUser instanceof WP_User);
        if ($pbinControllerMode === 'deny-capability') { $pbinControllerUser->remove_cap('pbin_manage_previews'); }
        elseif ($pbinControllerMode === 'restore-capability') { $pbinControllerUser->add_cap('pbin_manage_previews'); }
        else {
            controllerFixtureCheck(get_option('pbin_controller_default_marker') === 'default-unchanged');
            controllerFixtureCheck(get_option('pbin_schema_version') === $pbinControllerPrivate['default_schema']);
            $prefix = $GLOBALS['wpdb']->prefix;
            foreach ($pbinControllerPrivate['default_tables'] as $table => $expected) {
                controllerFixtureCheck(preg_match('/\A[a-zA-Z0-9_]+\z/', $table) === 1);
                controllerFixtureCheck((string) $GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM `$table`") === $expected);
            }
        }
        echo "PASS: disposable controller fixture control operation\n"; exit;
    }
    // Deterministic pretty REST routing in this new disposable site only.
    $GLOBALS['wp_rewrite']->set_permalink_structure('/%postname%/');
    flush_rewrite_rules(false); // Soft DB rules only; never write server/.htaccess settings.
    (new Pbin\Preview\Control\Storage(PBIN_PREVIEW_ROOT, [rtrim(ABSPATH, '/'), WP_CONTENT_DIR]))->initialize();
    (new Pbin\Preview\MysqlRegistry($GLOBALS['wpdb']))->installSchema();
    $suffix = bin2hex(random_bytes(8));
    $createUser = static function (string $name, string $role) use ($suffix): WP_User {
        $id = wp_create_user($name . $suffix, bin2hex(random_bytes(24)), $name . $suffix . '@example.invalid');
        controllerFixtureCheck(!is_wp_error($id)); $user = get_user_by('id', $id); controllerFixtureCheck($user instanceof WP_User); $user->set_role($role); return $user;
    };
    $deployer = $createUser('pbin_deploy_', 'subscriber'); $deployer->add_cap('pbin_manage_previews');
    $other = $createUser('pbin_other_', 'subscriber'); $other->add_cap('pbin_manage_previews');
    $admin = $createUser('pbin_admin_', 'administrator');
    $app = WP_Application_Passwords::create_new_application_password($deployer->ID, ['name' => 'Disposable CI controller']);
    $otherApp = WP_Application_Passwords::create_new_application_password($other->ID, ['name' => 'Disposable CI denied principal']);
    controllerFixtureCheck(!is_wp_error($app) && !is_wp_error($otherApp));
    $cookie = wp_generate_auth_cookie($admin->ID, time() + 3600, 'logged_in');
    $_COOKIE[LOGGED_IN_COOKIE] = $cookie; wp_set_current_user($admin->ID); $nonce = wp_create_nonce('wp_rest');
    update_option('pbin_controller_default_marker', 'default-unchanged', false);
    $defaultTables = [];
    foreach (['pastes', 'diffs', 'snapshots'] as $table) {
        $name = $GLOBALS['wpdb']->prefix . 'pbin_' . $table;
        $value = $GLOBALS['wpdb']->get_var("SELECT COUNT(*) FROM `$name`"); controllerFixtureCheck($GLOBALS['wpdb']->last_error === ''); $defaultTables[$name] = (string) $value;
    }
    $secrets = ['deployer_id' => $deployer->ID, 'username' => $deployer->user_login, 'password' => $app[0],
        'other_username' => $other->user_login, 'other_password' => $otherApp[0], 'cookie_name' => LOGGED_IN_COOKIE, 'cookie' => $cookie, 'nonce' => $nonce,
        'proxy_marker' => $pbinControllerMarker, 'default_schema' => get_option('pbin_schema_version'), 'default_tables' => $defaultTables];
    $handle = fopen($pbinControllerSecrets, 'xb'); controllerFixtureCheck(is_resource($handle)); controllerFixtureCheck(chmod($pbinControllerSecrets, 0600));
    controllerFixtureCheck(fwrite($handle, json_encode($secrets, JSON_THROW_ON_ERROR)) !== false); fclose($handle);
    $pbinControllerConfig = file_get_contents($pbinControllerConfigPath);
    $pbinControllerConfig = str_replace("\$table_prefix = 'wp_';", 'define(\'PBIN_PREVIEW_AUTOMATION_USER_ID\', ' . var_export((string) $deployer->ID, true) . ");\n\$table_prefix = 'wp_';", $pbinControllerConfig, $count);
    controllerFixtureCheck($count === 1 && file_put_contents($pbinControllerConfigPath, $pbinControllerConfig) !== false);
    echo "PASS: isolated MySQL controller and throwaway authentication fixtures prepared\n";
} catch (Throwable $error) {
    // Do not print exceptions/queries/config, password values or cookie material.
    fwrite(STDERR, "Disposable controller preparation failed\n"); exit(1);
}
