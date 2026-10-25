<?php
use Pbin\Plugin\Instance;
use Pbin\Plugin\PBIN_Completion;
use function Pbin\Plugin\pbin_path;
use function Pbin\Plugin\pbin_json;
use function Pbin\Plugin\pbin_html;
// Focused implementation tests. The independent acceptance/ suite remains the
// black-box parity gate; these tests do not replace a WordPress/MySQL run.
define('ABSPATH', __DIR__ . '/');
define('PBIN_PLUGIN_DIR', dirname(__DIR__) . '/pbin');
define('PBIN_WP_BASE_PATH', '/site/pbin');
require PBIN_PLUGIN_DIR . '/includes/instance.php';
Instance::select(new Instance('default', PBIN_WP_BASE_PATH, PBIN_PLUGIN_DIR));
require PBIN_PLUGIN_DIR . '/includes/http.php';
require PBIN_PLUGIN_DIR . '/includes/completion.php';

function check(bool $ok, string $message): void {
    if (!$ok) { throw new RuntimeException($message); }
}
check(pbin_path('/paste') === '/site/pbin/paste', 'scoped path');
check(!str_contains(pbin_json('</script><script>alert(1)</script>'), '<'), 'JSON cannot terminate a script');
check(pbin_html('<"&') === '&lt;&quot;&amp;', 'HTML escaping');
check(PBIN_Completion::stripTokens('hello<|fim_pad|>ignore') === 'hello', 'completion special tokens');
$prompt = PBIN_Completion::prompt(str_repeat('😀', 2000), str_repeat('λ', 2000));
check(preg_match('//u', $prompt) === 1, 'FIM truncation preserves UTF-8');
check(strlen($prompt) <= 4096 + 1536 + strlen('<|fim_prefix|><|fim_suffix|><|fim_middle|>'), 'FIM byte limits');

$data = [
    'ID' => 'a88fbdd9-38a8-482b-8b86-75d35db7cc39', 'PasteID' => 'a88fbdd9-38a8-482b-8b86-75d35db7cc39',
    'Text' => "</script><script>globalThis.attacked=true</script>\n'\\\"😀",
    'Language' => 'javascript', 'Title' => '<unsafe title " &>', 'Name' => '<unsafe name " &>',
    'CreatedAt' => '2026-10-23T00:00:00Z', 'OldText' => '</script><script>alert(1)</script>', 'NewText' => 'next 😀',
];
$data['Snapshots'] = [$data];
$rendered = [];
foreach (['paste', 'diff', 'diff-share', 'snapshot', 'snapshots'] as $name) {
    ob_start(); require PBIN_PLUGIN_DIR . '/templates/' . $name . '.php'; $html = ob_get_clean();
    check(!str_contains($html, '{{'), "$name contains an unported template token");
    check(!str_contains($html, '<unsafe'), "$name contains unescaped HTML");
    check(!str_contains($html, '</script><script>globalThis'), "$name contains executable text");
    check(str_contains($html, 'href="/site/pbin/"'), "$name lost scoped navigation");
    check(!preg_match('~(?:src|href)="/(?:static|paste|diff|snapshot|snapshots|html)~', $html), "$name leaks a root route");
    $rendered[$name] = $html;
}
check(str_contains($rendered['paste'], "'*', '/', '%'"), 'URL scoping modified language operators');
if (isset($argv[1])) { file_put_contents($argv[1], json_encode($rendered)); }
echo "PASS: FIM boundaries, HTML/JS escaping, template conversion and scoped navigation\n";
