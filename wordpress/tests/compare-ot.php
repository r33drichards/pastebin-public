<?php
$corpus = fopen($argv[1], 'r'); $reference = fopen($argv[2], 'r'); $count = 0;
while (($line = fgets($corpus)) !== false) {
    $expected = json_decode($line, true, 512, JSON_THROW_ON_ERROR)['expected'];
    $actualLine = fgets($reference);
    if ($actualLine === false) { throw new RuntimeException('Go reference ended early'); }
    $actual = json_decode($actualLine, true, 512, JSON_THROW_ON_ERROR);
    ksort($expected); ksort($actual);
    if ($expected !== $actual) { throw new RuntimeException('PHP/Go OT mismatch in vector ' . $count); }
    ++$count;
}
if (fgets($reference) !== false) { throw new RuntimeException('Go reference produced extra rows'); }
echo "PASS: $count differential cases match unmodified Go OT wire, apply, transform and cursor results\n";
