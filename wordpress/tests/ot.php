<?php
define('ABSPATH', __DIR__ . '/');
require dirname(__DIR__) . '/pbin/includes/ot.php';

function expect(bool $condition, string $label): void {
    if (!$condition) { throw new RuntimeException($label); }
}
function rejected(callable $fn, string $label): void {
    try { $fn(); } catch (Throwable $e) { return; }
    throw new RuntimeException('Expected rejection: ' . $label);
}
function utf16(string $text): string { return PBIN_UTF16::fromUTF8($text); }

foreach (["", "ASCII\0\r\n", "λé", "😀🦊", "a\u{0301}", "👩‍💻", "\u{10000}\u{10FFFF}"] as $text) {
    expect(PBIN_UTF16::toUTF8(utf16($text)) === $text, 'Unicode round trip');
}
expect(PBIN_UTF16::length(utf16('A😀B')) === 4, 'supplementary code point takes two code units');
expect(PBIN_UTF16::toUTF8(pack('vvv', 0xD800, 65, 0xDC00)) === "\u{FFFD}A\u{FFFD}", 'unpaired surrogates replace at UTF-8 boundary');
expect(PBIN_UTF16::toUTF8(utf16("\xED\xA0\x80")) === str_repeat("\u{FFFD}", 3), 'invalid UTF-8 replaces once per invalid byte');
expect(PBIN_UTF16::toUTF8(utf16("\xF0\x80\x80\x80")) === str_repeat("\u{FFFD}", 4), 'overlong UTF-8 rejection');
if (function_exists('mb_substitute_character')) {
    $previous = mb_substitute_character(); mb_substitute_character('none');
    expect(PBIN_UTF16::toUTF8(pack('v', 0xD800)) === "\u{FFFD}", 'native conversion does not inherit global substitution mode');
    expect(mb_substitute_character() === 'none', 'native conversion restores global substitution mode');
    mb_substitute_character($previous);
}
rejected(fn() => PBIN_UTF16::length('x'), 'odd UTF-16 bytes');

$op = PBIN_TextOp::fromJSON('[3,"hi 😀",-2,1]');
expect($op->baseLength() === 6 && $op->targetLength() === 9, 'Go round-trip vector lengths');
expect($op->MarshalJSON() === '[3,"hi 😀",-2,1]', 'Go round-trip wire vector');
expect($op->ApplyString('abcdef') === 'abchi 😀f', 'concrete mixed apply');
expect((new PBIN_TextOp())->Delete(2)->InsertString('x')->InsertString('y')->Delete(1)->wire() === ['xy', -3], 'canonical insert-before-delete coalescing');
expect((new PBIN_TextOp())->Retain(1)->Retain(2)->wire() === [3], 'adjacent retains merge');
expect((new PBIN_TextOp())->Retain(0)->Delete(-1)->InsertString('')->IsNoop(), 'builder no-op components');
expect(PBIN_TextOp::fromJSON('null')->IsNoop(), 'Go null operation is empty');
expect(PBIN_TextOp::fromJSON('[1.0,-2e0]')->wire() === [1, -2], 'integral JSON numbers');
expect(PBIN_TextOp::fromJSON('["\\ud83d\\ude00"]')->wire() === ['😀'], 'JSON surrogate pair');
expect(PBIN_TextOp::fromJSON('["\\ud800"]')->wire() === ["\u{FFFD}"], 'Go-compatible unpaired JSON high surrogate');
expect(PBIN_TextOp::fromJSON('["\\udfff"]')->wire() === ["\u{FFFD}"], 'Go-compatible unpaired JSON low surrogate');
expect(PBIN_TextOp::fromJSON('["\\\\ud800"]')->wire() === ['\\ud800'], 'escaped backslash is not a Unicode escape');
expect(PBIN_TextOp::fromJSON("[\"\xED\xA0\x80\"]")->wire() === [str_repeat("\u{FFFD}", 3)], 'Go-compatible invalid raw JSON UTF-8');
foreach (['[0]', '[1.5]', '[""]', '[true]', '[null]', '[[1]]', '{}', '{"0":1}', '1', '"x"', '[1e100]', '[1,]'] as $bad) {
    rejected(fn() => PBIN_TextOp::fromJSON($bad), 'invalid wire ' . $bad);
}
rejected(fn() => PBIN_TextOp::fromWire([NAN]), 'NaN');
rejected(fn() => PBIN_TextOp::fromWire([INF]), 'infinity');
rejected(fn() => PBIN_TextOp::fromWire([PHP_INT_MIN]), 'minimum signed integer');
rejected(fn() => PBIN_TextOp::fromWire([PHP_INT_MAX, 1]), 'length overflow');
rejected(fn() => PBIN_TextOp::fromWire([1])->Apply(utf16('ab')), 'incomplete document walk');
rejected(fn() => PBIN_TextOp::TransformOps(PBIN_TextOp::fromWire([1]), PBIN_TextOp::fromWire([2])), 'different bases');

function convergence(string $doc, array $aWire, array $bWire, string $expected): void {
    $a = PBIN_TextOp::fromWire($aWire); $b = PBIN_TextOp::fromWire($bWire);
    [$ap, $bp] = PBIN_TextOp::TransformOps($a, $b);
    expect(PBIN_UTF16::toUTF8($bp->Apply($a->Apply(utf16($doc)))) === $expected, 'concrete a then b convergence');
    expect(PBIN_UTF16::toUTF8($ap->Apply($b->Apply(utf16($doc)))) === $expected, 'concrete b then a convergence');
}
convergence('cat', ['A', 3], ['B', 3], 'ABcat');
convergence('abcdef', [1, -3, 2], [2, -3, 1], 'af');
convergence('abcd', [1, 'X', -2, 1], [1, 'Y', -2, 1], 'aXYd');
convergence('A😀B', [1, '🦊', -2, 1], [3, '!', 1], 'A🦊!B');
// The in-memory document must retain surrogate halves until the output boundary.
$half = PBIN_TextOp::fromWire([-1, 1])->Apply(utf16('😀'));
expect(bin2hex($half) === '00de', 'deleting one code unit preserves the low surrogate');
expect(PBIN_UTF16::toUTF8($half) === "\u{FFFD}", 'surrogate replacement occurs only at output');
$joined = (new PBIN_TextOp())->Insert(pack('v', 0xD83D))->Insert(pack('v', 0xDE00));
expect($joined->wire() === ['😀'], 'adjacent inserted surrogate halves rejoin');
$cursorOp = PBIN_TextOp::fromWire([1, '😀', -2, 1]);
expect(array_map([$cursorOp, 'TransformIndex'], range(0, 4)) === [0, 3, 3, 3, 4], 'cursor mapping around insert/delete');

mt_srand(20261023);
function randomText(int $min = 0, int $max = 16): string {
    $alphabet = ['a', 'b', "\n", ' ', 'é', 'λ', '😀', '🦊', "\u{0301}", "\0"];
    $text = '';
    for ($n = mt_rand($min, $max); $n > 0; --$n) { $text .= $alphabet[mt_rand(0, count($alphabet) - 1)]; }
    return $text;
}
function randomOperation(int $length): PBIN_TextOp {
    $op = new PBIN_TextOp(); $cursor = 0;
    while ($cursor < $length) {
        $n = mt_rand(1, $length - $cursor);
        switch (mt_rand(0, 2)) {
            case 0: $op->Retain($n); $cursor += $n; break;
            case 1: $op->Delete($n); $cursor += $n; break;
            case 2: $op->InsertString(randomText(1, 6)); break;
        }
    }
    if (mt_rand(0, 1)) { $op->InsertString(randomText(1, 6)); }
    return $op;
}
$corpus = isset($argv[1]) ? fopen($argv[1], 'w') : null;
$iterations = 10000;
for ($iteration = 0; $iteration < $iterations; ++$iteration) {
    $text = randomText(); $doc = utf16($text); $length = PBIN_UTF16::length($doc);
    $a = randomOperation($length); $b = randomOperation($length);
    $aBefore = $a->wire(); $bBefore = $b->wire();
    [$ap, $bp] = PBIN_TextOp::TransformOps($a, $b);
    $da = $a->Apply($doc); $db = $b->Apply($doc);
    $left = $bp->Apply($da); $right = $ap->Apply($db);
    expect($left === $right, "binary UTF-16 convergence iteration $iteration");
    expect($a->wire() === $aBefore && $b->wire() === $bBefore, 'transform does not mutate its inputs');
    expect(PBIN_UTF16::length($da) === $a->targetLength() && PBIN_UTF16::length($db) === $b->targetLength(), 'target lengths');
    expect($ap->baseLength() === $b->targetLength() && $bp->baseLength() === $a->targetLength(), 'transformed base lengths');
    expect(PBIN_TextOp::fromJSON($a->MarshalJSON())->wire() === $aBefore, 'canonical JSON stability');
    $indices = [];
    for ($i = 0; $i <= $length; ++$i) {
        $mapped = $a->TransformIndex($i);
        expect($mapped >= 0 && $mapped <= $a->targetLength(), 'cursor stays in target document');
        if ($indices) { expect($mapped >= $indices[count($indices) - 1], 'cursor mapping is monotone'); }
        $indices[] = $mapped;
    }
    if ($corpus) {
        fwrite($corpus, json_encode([
            'input' => ['doc' => $text, 'a' => $aBefore, 'b' => $bBefore],
            'expected' => ['a' => $aBefore, 'b' => $bBefore, 'ap' => $ap->wire(), 'bp' => $bp->wire(), 'da' => bin2hex($da), 'db' => bin2hex($db), 'result' => bin2hex($left), 'indices' => $indices],
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) . "\n");
    }
}
if ($corpus) { fclose($corpus); }
echo "PASS: concrete concurrency/Unicode/validation tests and $iterations deterministic UTF-16 convergence cases\n";
