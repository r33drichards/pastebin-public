<?php
namespace Pbin\Assets;

/** Trusted immutable file serving, independent of staging/production registries.
 * Never includes package PHP. The caller authorizes the release and supplies
 * canonical package, immutable asset mount and application URL mapping. */
final class StaticAssets {
    public const MAX_BYTES = 16 * 1024 * 1024;
    public static function serve(string $pluginDir, string $assetPath, callable $url): void {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        if (!in_array($method, ['GET', 'HEAD'], true)) {
            http_response_code(405); header('Allow: GET, HEAD'); header('Content-Type: text/plain; charset=utf-8'); header('Cache-Control: no-store'); return;
        }
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Cross-Origin-Embedder-Policy: require-corp');
        header('X-Content-Type-Options: nosniff');
        $decoded = rawurldecode($assetPath);
        if ($decoded === '' || str_contains($decoded, '\\') || preg_match('~(?:^|/)\.{1,2}(?:/|$)|[\x00-\x20\x7f]~', $decoded)) { self::missing(); return; }
        $expectedRoot = $pluginDir . '/static';
        $root = realpath($expectedRoot);
        $file = $root === false ? false : realpath($root . '/' . $decoded);
        if (realpath($pluginDir) !== $pluginDir || !$root || $root !== $expectedRoot || is_link($expectedRoot)
            || !$file || $file !== $root . '/' . $decoded || !str_starts_with($file, $root . DIRECTORY_SEPARATOR) || !is_file($file)) {
            self::missing(); return;
        }
        for ($part = $file; $part !== $root; $part = dirname($part)) {
            if (is_link($part)) { self::missing(); return; }
        }
        $stat = @lstat($file);
        if ($stat === false || $stat['nlink'] !== 1 || $stat['size'] > self::MAX_BYTES) { self::missing(); return; }
        $ext = pathinfo($file, PATHINFO_EXTENSION);
        $mime = ['js' => 'application/javascript', 'mjs' => 'application/javascript', 'css' => 'text/css',
            'svg' => 'image/svg+xml', 'wasm' => 'application/wasm', 'json' => 'application/json'];
        if (!isset($mime[$ext])) { self::missing(); return; }
        http_response_code(200);
        header('Content-Type: ' . $mime[$ext]);
        header('Cross-Origin-Resource-Policy: same-origin');
        header('Cache-Control: public, max-age=31536000, immutable');
        if ($method === 'HEAD') { return; }
        $text = @file_get_contents($file, false, null, 0, self::MAX_BYTES + 1);
        if ($text === false || strlen($text) > self::MAX_BYTES) { self::missing(); return; }
        if (in_array($ext, ['js', 'mjs', 'css'], true)) {
            $text = preg_replace_callback('~([\x22\x27\x60])/(static/|collab(?=[?\x22\x27\x60])|complete(?=[?\x22\x27\x60])|diff(?=[?\x22\x27\x60])|html(?=[?\x22\x27\x60]))~', static fn($m) => $m[1] . $url('/' . $m[2]), $text);
            if (basename($file) === 'command-palette.js') { $text = str_replace("handler: goTo('/')", "handler: goTo('" . $url('/') . "')", $text); }
            echo $text;
        } else { echo $text; }
    }
    private static function missing(): void {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
    }
}
