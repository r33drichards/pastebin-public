<?php
/** Subprocess-only fake bootstraps. No WordPress installation or DB is loaded. */
require dirname(__DIR__) . '/importer.php';
require dirname(__DIR__) . '/bootstrap.php';
use Pbin\Migration\BootstrapGuard;
use Pbin\Migration\ExportFile;

function verify(bool $condition, string $message): void { if (!$condition) { throw new RuntimeException($message); } }
function process(array $command): array {
    $child = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    verify(is_resource($child), 'Cannot launch fake bootstrap process'); fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]); $stderr = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
    return [proc_close($child), $stdout, $stderr];
}
$directory = sys_get_temp_dir() . '/pbin-bootstrap-' . bin2hex(random_bytes(12));
verify(mkdir($directory, 0700), 'Cannot create private synthetic fixture');
$load = $directory . '/wp-load.php';
$input = __DIR__ . '/synthetic.json';
$command = [PHP_BINARY, dirname(__DIR__) . '/import.php', '--export=' . $input,
    '--export-sha256=' . hash_file('sha256', $input), '--wordpress-load=' . $load,
    '--database=synthetic', '--table-prefix=wp_pbin_'];
$fixed = ExportFile::json(['status' => 'refused', 'reason' => BootstrapGuard::FAILURE]);
$marker = 'SYNTHETIC_BOOTSTRAP_DIAGNOSTIC_NOT_REAL_DATA';
$cases = [
    'echo' => 'echo ' . var_export($marker, true) . ';',
    'print' => 'print ' . var_export($marker, true) . ';',
    'warning' => 'trigger_error(' . var_export($marker, true) . ', E_USER_WARNING);',
    'throw' => 'throw new RuntimeException(' . var_export($marker, true) . ');',
    'error' => 'undefined_synthetic_bootstrap_function();',
    'exit-zero' => 'exit(0);',
    'exit-error' => 'exit(12);',
    'die-output' => 'die(' . var_export($marker, true) . ');',
    'nested-buffer' => 'ob_start(); echo ' . var_export($marker, true) . ';',
    'attempt-buffer-removal' => 'ob_end_flush(); echo ' . var_export($marker, true) . ';',
    'shutdown-output' => 'register_shutdown_function(function () { echo ' . var_export($marker, true) . '; }); exit(0);',
];
try {
    foreach ($cases as $name => $php) {
        verify(file_put_contents($load, '<?php ' . $php) !== false, 'Cannot write synthetic bootstrap'); chmod($load, 0600);
        [$status, $stdout, $stderr] = process($command);
        verify($status !== 0 && $stdout === '' && $stderr === $fixed, 'Bootstrap output/exception/exit not safely refused: ' . $name);
    }
    file_put_contents($load, '<?php echo ' . var_export($marker, true) . ';');
    [$status, $stdout, $stderr] = process(array_merge($command, ['--apply', '--expect-plan-sha256=' . str_repeat('a', 64), '--offline-writes-confirmed']));
    verify($status !== 0 && $stdout === '' && $stderr === $fixed, 'Full apply flags did not reach guarded bootstrap');
    // Guard preserves global include semantics and explicit receipt writes.
    $runner = $directory . '/success.php';
    file_put_contents($load, '<?php $pbinSyntheticGlobal = "global-preserved";');
    file_put_contents($runner, '<?php require ' . var_export(dirname(__DIR__) . '/importer.php', true)
        . '; require ' . var_export(dirname(__DIR__) . '/bootstrap.php', true)
        . '; $guard = \Pbin\Migration\BootstrapGuard::start(); require ' . var_export($load, true)
        . '; $guard->complete(); fwrite(STDOUT, $pbinSyntheticGlobal);');
    chmod($runner, 0600);
    [$status, $stdout, $stderr] = process([PHP_BINARY, $runner]);
    verify($status === 0 && $stdout === 'global-preserved' && $stderr === '', 'Success path/global bootstrap scope changed');
    file_put_contents($load, '<?php $pbinSyntheticGlobal = "global-preserved"; set_error_handler(function () { $GLOBALS["pbinSyntheticHandled"] = true; return true; });');
    $successfulRunner = file_get_contents($runner);
    file_put_contents($runner, str_replace('fwrite(STDOUT, $pbinSyntheticGlobal);',
        'trigger_error("Synthetic post-bootstrap warning", E_USER_WARNING); fwrite(STDOUT, !empty($GLOBALS["pbinSyntheticHandled"]) ? $pbinSyntheticGlobal : "handler-missing");', $successfulRunner));
    [$status, $stdout, $stderr] = process([PHP_BINARY, $runner]);
    verify($status === 0 && $stdout === 'global-preserved' && $stderr === '', 'Guard removed a later trusted handler or misreported a post-bootstrap warning');
    // Explicitly exercise/document the boundary, not a false sandbox claim.
    file_put_contents($load, '<?php fwrite(STDERR, ' . var_export($marker, true) . '); exit(0);');
    [$status, $stdout, $stderr] = process($command);
    verify($status !== 0 && $stdout === '' && $stderr === $marker . $fixed, 'Direct-stream limitation changed; review private-log guidance');
    file_put_contents($load, '<?php fwrite(STDOUT, ' . var_export($marker, true) . '); exit(0);');
    [$status, $stdout, $stderr] = process($command);
    verify($status !== 0 && $stdout === $marker && $stderr === $fixed, 'Direct stdout limitation changed; review private-log guidance');
} finally {
    foreach ([$load, $directory . '/success.php'] as $path) { if (is_file($path)) { unlink($path); } }
    rmdir($directory);
}
echo "PASS: synthetic bootstrap echo/print/warnings/throw/exit refusal, fixed generic signal, global scope and private-stream boundary (not a PHP sandbox)\n";
