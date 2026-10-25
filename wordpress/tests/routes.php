<?php
require dirname(__DIR__) . '/pbin/includes/mount.php';
use Pbin\Routing\Mount;
$checks = 0;
function equal($actual, $expected, string $message): void {
    global $checks; ++$checks;
    if ($actual !== $expected) { throw new RuntimeException($message . ': ' . var_export($actual, true)); }
}
$mount = new Mount('/paste', true, ['/pbin-wp-test']);
equal($mount->path('/paste'), '/paste', 'editor canonical URL');
equal($mount->path('/'), '/paste', 'new paste URL');
equal($mount->path('/snapshot'), '/paste/snapshot', 'snapshot URL');
equal($mount->path('/static/js/code-runner.js'), '/paste/static/js/code-runner.js', 'runner asset URL');
foreach (['/paste', '/paste/'] as $path) {
    equal($mount->route($path, 'GET', false), '/', 'fresh paste creates a room');
    equal($mount->route($path, 'GET', true), '/paste', 'existing paste renders');
    equal($mount->route($path, 'POST', false), '/paste', 'POST creates paste');
    equal($mount->route($path, 'PUT', true), '/paste', 'PUT updates paste');
    equal($mount->route($path, 'HEAD', false), '/', 'HEAD never creates or self-redirects');
}
equal($mount->route('/pbin-wp-test/paste', 'GET', true), '/paste', 'legacy editor alias');
equal($mount->route('/pbin-wp-test/snapshot', 'GET', true), '/snapshot', 'legacy snapshot alias');
equal($mount->route('/pbin-wp-test', 'GET', false), '/', 'legacy new paste');
foreach (['/', '/pastel', '/pasteboard', '/wp-admin', '/pbin-wp-test-other'] as $path) {
    equal($mount->route($path, 'GET', false), null, 'unrelated WP route preserved');
}
$legacy = new Mount('/custom');
equal($legacy->path('/paste'), '/custom/paste', 'configured old-style mount retained');
equal($legacy->route('/custom', 'GET', true), '/', 'old mount index semantics');
$root = new Mount('');
equal($root->route('/paste', 'POST', false), '/paste', 'root acceptance mount');
$subdir = new Mount('/site/paste', true, ['/site/pbin-wp-test']);
equal($subdir->path('/paste'), '/site/paste', 'WP subdirectory');
foreach (['/paste/', 'http://example.org', '/paste//other', '/../paste'] as $bad) {
    try { new Mount($bad); throw new RuntimeException('Invalid mount accepted'); }
    catch (InvalidArgumentException $expected) { ++$checks; }
}
echo "PASS: $checks canonical and legacy mount checks (pure routing, not HTTP/MySQL)\n";
