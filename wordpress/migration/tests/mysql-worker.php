<?php
/** Synthetic subprocess only: guarded fixture, no arbitrary paths/SQL/identities. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
function workerCheck(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
$fixture = getenv('PBIN_WP_FIXTURE') ?: '';
$load = getenv('PBIN_WORDPRESS_LOAD') ?: '';
$database = getenv('PBIN_TEST_DB_NAME') ?: '';
workerCheck(getenv('PBIN_TEST_ALLOW_DATABASE_MUTATION') === '1', 'Disposable mutation flag required');
workerCheck(is_dir($fixture) && realpath($fixture) === $fixture && str_contains($fixture, '/pbin-wp-ci.'), 'Expected canonical disposable fixture');
workerCheck($load === $fixture . '/site/wp-load.php' && realpath($load) === $load, 'Expected fixture WordPress core');
workerCheck(preg_match('/\Apbin_ci_[a-f0-9]{24}\z/', $database) === 1, 'Expected random disposable database');
$mode = $argv[1] ?? '';
workerCheck(in_array($mode, ['killed', 'race-winner', 'race-loser', 'reconnect'], true), 'Unknown worker mode');
define('SHORTINIT', true); require $load;
workerCheck(defined('DB_NAME') && DB_NAME === $database, 'Wrong database');
workerCheck(defined('DB_HOST') && preg_match('/\A(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\z/', DB_HOST) === 1, 'Local MySQL only');
require dirname(__DIR__) . '/importer.php';
use Pbin\Migration\WpdbDestination;
use Pbin\Migration\MigrationException;
$wpdb->suppress_errors(true);
workerCheck($wpdb->query('SET SESSION innodb_lock_wait_timeout = 10') !== false, 'Cannot bound lock wait');
$prefix = $wpdb->prefix . 'pbin_';
$identity = hash('sha256', "pbin-target-v1\0" . DB_HOST . "\0" . DB_NAME . "\0" . $prefix);
$target = new WpdbDestination($wpdb, $prefix, $identity, $database);
$row = ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-10-25T00:00:00Z', 'text', "synthetic $mode 😀\0", ''];
if (str_starts_with($mode, 'race-')) { $row[0] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; }
if ($mode === 'reconnect') { $row[0] = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; }
function emitWorker(array $message): void { fwrite(STDOUT, json_encode($message, JSON_THROW_ON_ERROR) . "\n"); fflush(STDOUT); }
function workerCommand(): string {
    $read = [STDIN]; $write = $except = [];
    workerCheck(stream_select($read, $write, $except, 20) === 1, 'Parent command timeout');
    $line = fgets(STDIN, 64); workerCheck(is_string($line), 'Parent closed command stream');
    return trim($line);
}
$target->begin();
$connection = (string) $wpdb->get_var('SELECT CONNECTION_ID()');
workerCheck(preg_match('/\A[1-9][0-9]*\z/', $connection) === 1, 'Missing connection identity');
if ($mode === 'race-loser') {
    emitWorker(['state' => 'inserting', 'connection' => $connection]);
    try { $target->insert('pastes', $row); }
    catch (MigrationException $error) {
        $duplicate = str_contains($wpdb->last_error, 'Duplicate entry');
        $target->rollback(); workerCheck($duplicate, 'Loser failed for a reason other than duplicate-key collision');
        emitWorker(['state' => 'conflict-refused']); exit(0);
    }
    $target->rollback(); throw new RuntimeException('Racing loser unexpectedly inserted');
}
$target->insert('pastes', $row);
emitWorker(['state' => 'held', 'connection' => $connection]);
$command = workerCommand();
if ($mode === 'race-winner' && $command === 'commit') {
    $target->commit(); emitWorker(['state' => 'committed']); exit(0);
}
if ($mode === 'reconnect' && $command === 'attempt') {
    $row[0] = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    try { $target->insert('pastes', $row); }
    catch (MigrationException $error) {
        $now = (string) $wpdb->get_var('SELECT CONNECTION_ID()');
        $target->rollback();
        workerCheck($now !== $connection && preg_match('/\A[1-9][0-9]*\z/', $now) === 1, 'Expected an actual replacement MySQL connection');
        emitWorker(['state' => 'reconnect-refused']); exit(0);
    }
    $target->rollback(); throw new RuntimeException('Reconnected insert unexpectedly succeeded');
}
$target->rollback(); throw new RuntimeException('Unexpected worker command');
