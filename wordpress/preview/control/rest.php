<?php
namespace Pbin\Preview\Control;
require_once __DIR__ . '/controller.php';

/** Early exact-route adapter: core WP REST auth, without core's unbounded body copy. */
final class Endpoint {
    public const PREFIX = '/pbin-previews/v1/';
    public static function route(string $route, string $method): array {
        if (!preg_match('~\A/pbin-previews/v1/tenants/(pr-[1-9][0-9]{0,9})(?:/(retire|rollback)|/releases/([a-f0-9]{40}))?\z~', $route, $match)) {
            throw new ControlException('Unknown preview management route', 404);
        }
        $action = ($match[2] ?? '') !== '' ? $match[2] : (($match[3] ?? '') !== '' ? 'install' : 'get');
        if ($method !== ($action === 'get' ? 'GET' : 'POST')) { throw new ControlException('Unsupported method', 405); }
        return ['tenant' => $match[1], 'action' => $action, 'revision' => $match[3] ?? null];
    }

    /** Must run before opening or reading php://input. Never authenticates itself. */
    public static function authorize(Configuration $config): void {
        if (!is_ssl()) { throw new ControlException('HTTPS is required', 403); }
        if (!defined('REST_REQUEST')) { define('REST_REQUEST', true); }
        if (REST_REQUEST !== true) { throw new ControlException('REST authentication unavailable', 503); }
        // Match WP_REST_Server::serve_request's application-password re-evaluation.
        global $current_user, $wp_rest_auth_cookie;
        if ($current_user instanceof \WP_User && !$current_user->exists()) { $current_user = null; }
        wp_get_current_user();
        $auth = rest_get_server()->check_authentication();
        if (is_wp_error($auth) || !is_user_logged_in()) { throw new ControlException('Preview authorization required', 403); }
        $app = rest_get_authenticated_app_password();
        if (is_string($app) && $app !== '') {
            if ($config->automationUser !== null && (string) get_current_user_id() === $config->automationUser && current_user_can('pbin_manage_previews')) { return; }
        } elseif ($wp_rest_auth_cookie === true) {
            // Require core's nonce check even if another authentication filter
            // returned early. Missing nonce must clear cookie authentication.
            $cookie = rest_cookie_check_errors(null);
            if (!is_wp_error($cookie) && is_user_logged_in() && current_user_can('manage_options')) { return; }
        }
        throw new ControlException('Preview management capability required', 403);
    }

    private static function length(array $headers, int $maximum): ?int {
        if (!isset($headers['content-length'])) { return null; }
        $length = $headers['content-length'];
        if (!is_string($length) || !preg_match('/\A(?:0|[1-9][0-9]{0,8})\z/', $length) || (int) $length > $maximum) { throw new ControlException('Request body exceeds limit', 413); }
        return (int) $length;
    }

    public static function dispatch(Controller $controller, array $route, array $headers, $stream): array {
        $action = $route['action']; $tenant = $route['tenant'];
        if ($action === 'get') { return $controller->get($tenant); }
        if (isset($headers['content-encoding']) && $headers['content-encoding'] !== 'identity') { throw new ControlException('Encoded bodies are not accepted', 415); }
        if ($action === 'install') {
            if (($headers['content-type'] ?? '') !== 'application/zip') { throw new ControlException('Expected application/zip', 415); }
            $digest = $headers['x-pbin-artifact-sha256'] ?? '';
            $token = $headers['x-pbin-expected-token'] ?? '';
            if (!is_string($digest) || !preg_match('/\A[a-f0-9]{64}\z/', $digest) || !is_string($token) || ($token !== 'none' && !preg_match('/\A[a-f0-9]{64}\z/', $token))) { throw new ControlException('Invalid artifact or expected-token header'); }
            return $controller->install($tenant, $route['revision'], $digest, $token === 'none' ? null : $token, $stream, self::length($headers, NativePackage::MAX_ARCHIVE_BYTES));
        }
        if (!in_array($headers['content-type'] ?? '', ['application/json', 'application/json; charset=utf-8'], true)) { throw new ControlException('Expected application/json', 415); }
        $length = self::length($headers, 4096);
        $body = stream_get_contents($stream, 4097);
        if (!is_string($body) || strlen($body) > 4096 || ($length !== null && strlen($body) !== $length)) { throw new ControlException('Invalid or oversized JSON body', 413); }
        try { $object = json_decode($body, false, 4, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { throw new ControlException('Invalid JSON request'); }
        if (!($object instanceof \stdClass) || json_encode($object, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) !== preg_replace('/[ \t\r\n]/', '', $body)) { throw new ControlException('Noncanonical or duplicate JSON fields'); }
        $values = (array) $object; $keys = array_keys($values); sort($keys);
        $expected = $action === 'retire' ? ['expected_token'] : ['expected_token', 'revision'];
        if ($keys !== $expected || (!is_null($values['expected_token']) && (!is_string($values['expected_token']) || !preg_match('/\A[a-f0-9]{64}\z/', $values['expected_token'])))) { throw new ControlException('Invalid mutation fields'); }
        if ($action === 'retire') { return $controller->retire($tenant, $values['expected_token']); }
        if (!is_string($values['expected_token']) || !is_string($values['revision']) || !preg_match('/\A[a-f0-9]{40}\z/', $values['revision'])) { throw new ControlException('Rollback requires retained revision and token'); }
        return $controller->rollback($tenant, $values['expected_token'], $values['revision']);
    }

    public static function maybeServe($wp): void {
        $path = $wp->query_vars['rest_route'] ?? null;
        if (!is_string($path) || !str_starts_with($path, self::PREFIX)) { return; }
        // Handles pretty /wp-json and ?rest_route= forms before rest_api_loaded.
        // No JSONP, CORS expansion, method override or arbitrary routes are added.
        $status = 200;
        try {
            if (isset($_GET['_method']) || isset($_GET['_jsonp']) || isset($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'])) { throw new ControlException('Method override and JSONP are not supported'); }
            $route = self::route($path, $_SERVER['REQUEST_METHOD'] ?? '');
            $config = Configuration::wordpress();
            self::authorize($config);
            $controller = new Controller(new \Pbin\Preview\MysqlRegistry($GLOBALS['wpdb']), $config->storage);
            $headers = [];
            foreach (rest_get_server()->get_headers(wp_unslash($_SERVER)) as $key => $value) { $headers[strtolower(str_replace('_', '-', $key))] = $value; }
            $stream = fopen('php://input', 'rb');
            if ($stream === false) { throw new ControlException('Request input unavailable', 503); }
            try { $result = self::dispatch($controller, $route, $headers, $stream); }
            finally { fclose($stream); }
        } catch (\Pbin\Preview\RegistryConflict $error) { $status = 409; $result = ['code' => 'pbin_preview_conflict']; }
        catch (\Pbin\Preview\RegistryCommitUncertain $error) { $status = 503; $result = ['code' => 'pbin_preview_outcome_uncertain']; }
        catch (ControlException $error) { $status = $error->status; $result = ['code' => 'pbin_preview_request_rejected']; }
        catch (PackageException $error) { $status = 400; $result = ['code' => 'pbin_preview_package_rejected']; }
        catch (\Throwable $error) { $status = 503; $result = ['code' => 'pbin_preview_unavailable']; }
        status_header($status);
        header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff');
        echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
        exit;
    }
}
