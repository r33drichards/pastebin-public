<?php
/** Socket-free trusted file-serving contract, not HTTP/browser evidence. */
require dirname(__DIR__) . '/preview/control/static-assets.php';
use Pbin\Assets\StaticAssets;
ob_start();
function assetCheck(bool $value, string $message): void { if (!$value) { throw new RuntimeException($message); } }
function assetRemove(string $path): void {
    if (is_link($path) || is_file($path)) { unlink($path); return; }
    foreach (scandir($path) ?: [] as $name) { if ($name !== '.' && $name !== '..') { assetRemove($path . '/' . $name); } } rmdir($path);
}
function renderAsset(string $plugin, string $path, string $method = 'GET', bool $production = false): array {
    $_SERVER['REQUEST_METHOD'] = $method; http_response_code(200); ob_start();
    StaticAssets::serve($plugin, $path, static fn($route) => str_starts_with($route, '/static/')
        ? ($production ? '/paste' : '/previews/pr-1') . '/_releases/' . str_repeat('a', 40) . $route
        : ($production && $route === '/' ? '/paste' : ($production ? '/paste' : '/previews/pr-1') . $route));
    return [http_response_code(), ob_get_clean()];
}
$work = sys_get_temp_dir() . '/pbin-static-test-' . bin2hex(random_bytes(8));
mkdir($work, 0700); $plugin = $work . '/pbin'; mkdir($plugin, 0700); mkdir($plugin . '/static', 0700); mkdir($plugin . '/static/js', 0700);
try {
    file_put_contents($plugin . '/runtime.php', '<?php throw new RuntimeException("Do not execute runtime");');
    $source = 'const one = "/static/js/next.js"; const two = "/complete"; const three = "/diff"; handler: goTo(\'/\')';
    file_put_contents($plugin . '/static/js/command-palette.js', $source);
    [$status, $body] = renderAsset($plugin, 'js/command-palette.js');
    assetCheck($status === 200 && str_contains($body, '/previews/pr-1/_releases/' . str_repeat('a', 40) . '/static/js/next.js') && str_contains($body, '/previews/pr-1/complete') && str_contains($body, "goTo('/previews/pr-1/')"), 'Preview rewriting failed');
    [$status, $body] = renderAsset($plugin, 'js/command-palette.js', 'GET', true);
    assetCheck($status === 200 && str_contains($body, '/paste/_releases/' . str_repeat('a', 40)) && str_contains($body, "goTo('/paste')"), 'Production mapping contract failed');
    assetCheck(renderAsset($plugin, 'js/command-palette.js', 'HEAD') === [200, ''], 'HEAD returned a body');
    assetCheck(renderAsset($plugin, 'js/command-palette.js', 'POST') === [405, ''], 'Non-read asset method accepted');
    file_put_contents($plugin . '/static/js/literal.js', '<?php file_put_contents("' . $work . '/executed", "no"); ?>');
    assetCheck(renderAsset($plugin, 'js/literal.js')[1] === file_get_contents($plugin . '/static/js/literal.js') && !file_exists($work . '/executed'), 'PHP in static bytes executed');
    file_put_contents($plugin . '/static/worker.wasm', "\0asm\x01\0\0\0");
    assetCheck(renderAsset($plugin, 'worker.wasm') === [200, "\0asm\x01\0\0\0"], 'Binary bytes changed');
    file_put_contents($plugin . '/static/secret.php', '<?php echo "never";');
    foreach (['../runtime.php', '%2e%2e/runtime.php', 'secret.php', 'js', 'missing.js', '/js/command-palette.js', 'js//command-palette.js', "js/command-palette.js\0"] as $path) { assetCheck(renderAsset($plugin, $path) === [404, ''], 'Unsafe/missing path accepted'); }
    symlink($plugin . '/static/js/command-palette.js', $plugin . '/static/inside.js');
    symlink($plugin . '/runtime.php', $plugin . '/static/outside.js');
    foreach (['inside.js', 'outside.js'] as $path) { assetCheck(renderAsset($plugin, $path) === [404, ''], 'Symlink accepted'); }
    link($plugin . '/static/worker.wasm', $plugin . '/static/hardlink.wasm');
    assetCheck(renderAsset($plugin, 'hardlink.wasm') === [404, ''], 'Hardlink accepted');
    $handle = fopen($plugin . '/static/large.js', 'xb'); ftruncate($handle, StaticAssets::MAX_BYTES + 1); fclose($handle);
    assetCheck(renderAsset($plugin, 'large.js') === [404, ''], 'Oversized asset accepted');
    rename($plugin . '/static', $work . '/outside-static'); symlink($work . '/outside-static', $plugin . '/static');
    assetCheck(renderAsset($plugin, 'js/command-palette.js') === [404, ''], 'Symlink static root accepted');
    assetCheck(!class_exists('Pbin\\Plugin\\Instance', false), 'Package runtime was loaded');
} finally { assetRemove($work); }
ob_end_clean();
echo "PASS: trusted static bytes, preview/production URL mapping, GET/HEAD, bounded files and no package PHP execution (socket-free)\n";
