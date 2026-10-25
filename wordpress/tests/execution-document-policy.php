<?php
// Ordinary response-policy tests only. No arbitrary code, credentials or
// network requests are executed; auth state is a synthetic boolean stub.
$mode = $argv[1] ?? '';
if (!in_array($mode, ['guest', 'authenticated', 'unavailable'], true)) { throw new RuntimeException('mode required'); }
if ($mode !== 'unavailable') {
    function is_user_logged_in(): bool { return $GLOBALS['mode'] === 'authenticated'; }
}
define('ABSPATH', __DIR__ . '/');
require dirname(__DIR__) . '/pbin/includes/instance.php';
require dirname(__DIR__) . '/pbin/includes/http.php';
\Pbin\Plugin\Instance::select(new \Pbin\Plugin\Instance('default', '/paste', dirname(__DIR__) . '/pbin'));
$http = (new ReflectionClass(\Pbin\Plugin\PBIN_HTTP::class))->newInstanceWithoutConstructor();
$template = new ReflectionMethod($http, 'template');
$data = ['ID' => 'fixture', 'PasteID' => 'fixture', 'Text' => 'print(42)', 'Language' => 'python', 'Snapshots' => []];
foreach (['paste', 'snapshot', 'snapshots', 'diff', 'diff-share'] as $name) {
    http_response_code(200);
    ob_start(); $template->invoke($http, $name, $data); $body = ob_get_clean();
    if ($mode === 'guest') {
        if (http_response_code() !== 200 || !str_contains($body, '<!DOCTYPE html>')) { throw new RuntimeException("guest $name failed"); }
        if ($name === 'paste' && !str_contains($body, 'code-runner.js')) { throw new RuntimeException('guest runner removed'); }
    } else {
        if (http_response_code() !== ($mode === 'authenticated' ? 403 : 503)) { throw new RuntimeException("denial $name status"); }
        if (str_contains($body, '<script') || str_contains($body, 'print(42)') || !str_contains($body, 'unavailable')) { throw new RuntimeException("denial $name leaked document"); }
    }
}
// The guard also applies to future/unknown templates before filesystem access.
if ($mode !== 'guest') {
    ob_start(); $template->invoke($http, 'future-runner-template', []); $body = ob_get_clean();
    if (!str_contains($body, 'unavailable')) { throw new RuntimeException('future template bypass'); }
}
echo "PASS: $mode execution-document response policy (not origin isolation)\n";
