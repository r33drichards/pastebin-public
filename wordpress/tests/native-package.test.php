<?php
declare(strict_types=1);
require_once __DIR__ . '/../preview/control/native-package.php';
use Pbin\Preview\Control\NativePackage;

function pbin_native_remove_test_tree(string $path): void {
    if (is_link($path) || !is_dir($path)) { @unlink($path); return; }
    foreach (scandir($path) as $name) { if ($name !== '.' && $name !== '..') { pbin_native_remove_test_tree($path . '/' . $name); } }
    rmdir($path);
}
function pbin_native_copy_test_tree(string $source, string $target): void {
    mkdir($target, 0700);
    foreach (scandir($source) as $name) {
        if ($name === '.' || $name === '..') { continue; }
        if (is_dir($source . '/' . $name)) { pbin_native_copy_test_tree($source . '/' . $name, $target . '/' . $name); }
        else { copy($source . '/' . $name, $target . '/' . $name); }
    }
}
/** Test helper only: no HTTP endpoint, auth bypass, or package PHP execution. */
function pbin_run_native_package_tests(string $fixtures, string $privateScratch, bool $core = true, bool $requireNative = false): array {
    $report = ['required_native' => $requireNative, 'passed' => [], 'failed' => [], 'skipped' => []];
    $test = static function(string $name, callable $call, bool $reject = false) use (&$report): void {
        try { $call(); $report[$reject ? 'failed' : 'passed'][] = $name . ($reject ? ': accepted invalid input' : ''); }
        catch (Throwable $error) { $report[$reject ? 'passed' : 'failed'][] = $name . ($reject ? '' : ': ' . $error->getMessage()); }
    };
    $baseline = json_decode(file_get_contents($fixtures . '/valid-report.json'), true, 16, JSON_THROW_ON_ERROR);
    $revision = $baseline['revision'];
    $bytes = file_get_contents($fixtures . '/manifest.json');
    if ($core) {
        $test('canonical-manifest', static fn() => NativePackage::manifest($bytes, $revision));
        $test('canonical-retained-tree-and-zip-hash', static fn() => NativePackage::verifyExisting($fixtures . '/valid-tree', $revision, $baseline['artifact_sha256'], $baseline['manifest_sha256']));
        foreach ([
            'duplicate-key' => str_replace('"version":1', '"version":1,"version":1', $bytes),
            'whitespace' => ' ' . $bytes,
            'missing-newline' => rtrim($bytes),
            'wrong-version' => str_replace('"version":1', '"version":2', $bytes),
            'boolean-version' => str_replace('"version":1', '"version":true', $bytes),
            'extra-property' => substr($bytes, 0, -2) . ',"extra":1}' . "\n",
            'array-root' => '[]',
            'deep-json' => str_repeat('[', 40) . str_repeat(']', 40),
        ] as $name => $invalid) { $test('manifest-' . $name, static fn() => NativePackage::manifest($invalid, $revision), true); }
        foreach (['negative' => -1, 'boolean' => true, 'float' => 1.5, 'wasm32-overflow' => 2147483648, 'file-limit' => NativePackage::MAX_FILE + 1] as $name => $size) {
            $data = json_decode($bytes); $data->files->{'pbin/runtime.php'}->size = $size;
            $test('manifest-size-' . $name, static fn() => NativePackage::manifest(json_encode($data, JSON_UNESCAPED_SLASHES) . "\n", $revision), true);
        }
        $data = json_decode($bytes);
        for ($i = 0; $i < 1000; $i++) {
            $path = 'pbin/' . implode('/', array_fill(0, 17, 'd' . $i)) . '/x';
            $data->files->{$path} = (object) ['sha256' => str_repeat('0', 64), 'size' => 0];
        }
        $test('manifest-unique-directory-budget', static fn() => NativePackage::manifest(json_encode($data, JSON_UNESCAPED_SLASHES) . "\n", $revision), true);
        foreach (['payload', 'extra', 'extra-directory', 'symlink-file', 'symlink-directory', 'hardlink'] as $kind) {
            $tree = $privateScratch . '/core-' . $kind; pbin_native_copy_test_tree($fixtures . '/valid-tree', $tree);
            if ($kind === 'payload') { file_put_contents($tree . '/pbin/runtime.php', 'changed'); }
            elseif ($kind === 'extra') { file_put_contents($tree . '/pbin/extra.txt', 'extra'); }
            elseif ($kind === 'extra-directory') { mkdir($tree . '/pbin/extra-directory'); }
            elseif ($kind === 'symlink-file') { unlink($tree . '/pbin/runtime.php'); symlink($fixtures . '/valid-tree/pbin/runtime.php', $tree . '/pbin/runtime.php'); }
            elseif ($kind === 'symlink-directory') { pbin_native_remove_test_tree($tree . '/pbin/static'); symlink($fixtures . '/valid-tree/pbin/static', $tree . '/pbin/static'); }
            else { link($tree . '/pbin/runtime.php', $privateScratch . '/hardlink-alias'); }
            $test('retained-' . $kind, static fn() => NativePackage::verifyExisting($tree, $revision, $baseline['artifact_sha256'], $baseline['manifest_sha256']), true);
            pbin_native_remove_test_tree($tree);
            if (file_exists($privateScratch . '/hardlink-alias')) { unlink($privateScratch . '/hardlink-alias'); }
        }
        $test('retained-wrong-artifact-hash', static fn() => NativePackage::verifyExisting($fixtures . '/valid-tree', $revision, str_repeat('0', 64), $baseline['manifest_sha256']), true);
        $test('retained-wrong-manifest-hash', static fn() => NativePackage::verifyExisting($fixtures . '/valid-tree', $revision, $baseline['artifact_sha256'], str_repeat('0', 64)), true);
        $test('retained-wrong-revision', static fn() => NativePackage::verifyExisting($fixtures . '/valid-tree', str_repeat('f', 40), $baseline['artifact_sha256'], $baseline['manifest_sha256']), true);
        $test('wasm32-signed-attribute-bytes', static function(): void { if (pack('V', -2119958528) !== hex2bin('0000a481')) { throw new RuntimeException('Signed attribute mismatch'); } });
    }
    if (!class_exists(ZipArchive::class) || !method_exists(ZipArchive::class, 'getStreamIndex')
        || !method_exists(ZipArchive::class, 'getExternalAttributesIndex')) {
        $report['skipped'][] = 'Native ZIP extraction fixtures: ZipArchive unavailable';
        if ($requireNative) { $report['failed'][] = 'Required native ZIP capability is unavailable; extraction gate did not run'; }
        return $report;
    }
    $index = json_decode(file_get_contents($fixtures . '/index.json'), true, 32, JSON_THROW_ON_ERROR);
    foreach ($index as $fixture) {
        $destination = $privateScratch . '/zip-' . $fixture['name'];
        $test('zip-' . $fixture['name'], static function() use ($fixture, $fixtures, $destination, $baseline): void {
            $result = NativePackage::extract($fixtures . '/' . $fixture['file'], $fixture['artifact_sha256'], $fixture['revision'], $destination);
            if ($fixture['valid']) {
                $verified = NativePackage::verifyExisting($destination, $fixture['revision'], $fixture['artifact_sha256'], $result['manifest_sha256']);
                if ($verified !== $result || $result['manifest_sha256'] !== $baseline['manifest_sha256']) { throw new RuntimeException('Extract/retained report mismatch'); }
            }
        }, !$fixture['valid']);
        if (!$fixture['valid'] && file_exists($destination)) { $report['failed'][] = $fixture['name'] . ': rejected extraction left output'; }
        if (file_exists($destination)) { pbin_native_remove_test_tree($destination); }
    }
    $source = $fixtures . '/valid.zip';
    $held = $privateScratch . '/already-exists'; mkdir($held);
    $test('zip-existing-destination', static fn() => NativePackage::extract($source, $baseline['artifact_sha256'], $revision, $held), true);
    rmdir($held);
    symlink($source, $privateScratch . '/linked.zip');
    $test('zip-symlink-source', static fn() => NativePackage::extract($privateScratch . '/linked.zip', $baseline['artifact_sha256'], $revision, $privateScratch . '/symlink-out'), true);
    unlink($privateScratch . '/linked.zip');
    symlink($privateScratch, $privateScratch . '/linked-parent');
    $test('zip-symlink-destination-parent', static fn() => NativePackage::extract($source, $baseline['artifact_sha256'], $revision, $privateScratch . '/linked-parent/out'), true);
    unlink($privateScratch . '/linked-parent');
    return $report;
}
if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $requireNative = getenv('PBIN_REQUIRE_NATIVE_ZIP') === '1';
    $fixtureArgument = null;
    foreach (array_slice($argv, 1) as $argument) {
        if ($argument === '--require-native') { $requireNative = true; }
        elseif (str_starts_with($argument, '--') || $fixtureArgument !== null) { fwrite(STDERR, "Usage: php native-package.test.php [--require-native] [fixtures-directory]\n"); exit(2); }
        else { $fixtureArgument = $argument; }
    }
    $fixtures = realpath($fixtureArgument ?? __DIR__ . '/native-package-fixtures');
    if ($fixtures === false) { fwrite(STDERR, "Fixtures directory is unavailable\n"); exit(2); }
    $scratch = sys_get_temp_dir() . '/pbin-native-test-' . bin2hex(random_bytes(8)); mkdir($scratch, 0700);
    try { $report = pbin_run_native_package_tests($fixtures, $scratch, true, $requireNative); echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"; }
    finally { pbin_native_remove_test_tree($scratch); }
    exit($report['failed'] === [] ? 0 : 1);
}
