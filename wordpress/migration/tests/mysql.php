<?php
/** Hosted-only integration: refuses anything except the existing disposable fixture. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
function verify(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
$fixture = getenv('PBIN_WP_FIXTURE') ?: '';
$load = getenv('PBIN_WORDPRESS_LOAD') ?: '';
$database = getenv('PBIN_TEST_DB_NAME') ?: '';
$plugin = getenv('PBIN_TEST_PLUGIN_DIR') ?: '';
verify(getenv('PBIN_TEST_ALLOW_DATABASE_MUTATION') === '1', 'Explicit disposable mutation flag required');
verify(is_dir($fixture) && realpath($fixture) === $fixture && str_contains($fixture, '/pbin-wp-ci.'), 'Expected canonical disposable fixture');
verify($load === $fixture . '/site/wp-load.php' && realpath($load) === $load, 'Expected fixture WordPress core');
verify(preg_match('/\Apbin_ci_[a-f0-9]{24}\z/', $database) === 1, 'Expected random disposable database');
verify(is_dir($plugin) && realpath($plugin) === $plugin && is_file($plugin . '/includes/store.php'), 'Expected exact tested plugin directory');
define('SHORTINIT', true); require $load;
verify(defined('DB_NAME') && DB_NAME === $database, 'Wrong database');
verify(defined('DB_HOST') && preg_match('/\A(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\z/', DB_HOST) === 1, 'Local MySQL only');
require dirname(__DIR__) . '/importer.php';
use Pbin\Migration\ExportFile;
use Pbin\Migration\Destination;
use Pbin\Migration\Importer;
use Pbin\Migration\WpdbDestination;
use Pbin\Migration\MigrationException;

function refusal(callable $action): void {
    try { $action(); } catch (MigrationException $error) { return; } throw new RuntimeException('Expected migration refusal');
}
function fingerprints(array $exclude = []): array {
    global $wpdb; $result = [];
    $tables = $wpdb->get_col('SHOW TABLES'); verify(is_array($tables) && $wpdb->last_error === '', 'Cannot enumerate fixture');
    foreach ($tables as $table) {
        verify(preg_match('/\A[a-zA-Z0-9_]+\z/', $table) === 1, 'Unsafe fixture identifier');
        if (in_array($table, $exclude, true)) { continue; }
        $rows = $wpdb->get_results("SELECT * FROM `$table`", ARRAY_A); verify(is_array($rows) && $wpdb->last_error === '', 'Cannot read fixture');
        $encoded = array_map(fn($row) => json_encode($row, JSON_THROW_ON_ERROR), $rows); sort($encoded, SORT_STRING);
        $result[$table] = hash('sha256', json_encode($encoded, JSON_THROW_ON_ERROR));
    }
    ksort($result); return $result;
}
final class InterruptedDestination implements Destination {
    public int $inserts = 0;
    public function __construct(private Destination $inner) {}
    public function identity(): string { return $this->inner->identity(); }
    public function schema(): void { $this->inner->schema(); }
    public function counts(): array { return $this->inner->counts(); }
    public function read(string $kind, string $id, bool $lock): ?array { return $this->inner->read($kind, $id, $lock); }
    public function checkInsert(string $kind, array $fields): void { $this->inner->checkInsert($kind, $fields); }
    public function begin(): void { $this->inner->begin(); }
    public function insert(string $kind, array $fields): void { if (++$this->inserts === 3) { throw new MigrationException('Synthetic interrupted import'); } $this->inner->insert($kind, $fields); }
    public function commit(): void { $this->inner->commit(); }
    public function rollback(): void { $this->inner->rollback(); }
}
$path = __DIR__ . '/synthetic.json'; $hash = hash_file('sha256', $path); $export = ExportFile::read($path, $hash);
$prefix = $wpdb->prefix . 'pbin_';
$targetHash = hash('sha256', "pbin-target-v1\0" . DB_HOST . "\0" . DB_NAME . "\0" . $prefix);
$target = new WpdbDestination($wpdb, $prefix, $targetHash, $database);
$importer = new Importer($target); $before = fingerprints(); $plan = $importer->reconcile($export);
verify($plan['rows']['insert'] === 5 && $plan['rows']['conflict'] === 0, 'Fixture must have no preexisting synthetic IDs');
verify(fingerprints() === $before, 'Read-only dry run changed fixture');
$interrupted = new InterruptedDestination($target);
refusal(fn() => (new Importer($interrupted))->apply($export, $plan['plan_sha256'], true));
verify($interrupted->inserts === 3, 'Interrupted-import test failed before its intended third insert');
verify(fingerprints() === $before, 'Mid-transaction failure left partial data');
refusal(fn() => $importer->apply($export, str_repeat('0', 64), true)); verify(fingerprints() === $before, 'Bad plan changed data');
$unrelated = fingerprints(array_map(fn($kind) => $prefix . $kind, array_keys(ExportFile::COLUMNS)));
$receipt = $importer->apply($export, $plan['plan_sha256'], true);
verify($receipt['inserted_counts'] === $export->data['counts'], 'Wrong insertion counts');
foreach ($export->data['records'] as $row) { verify($target->read($row['kind'], $row['fields'][0], false) === $row['fields'], 'Real MySQL changed IDs, Unicode, precision or relationships'); }
verify(fingerprints(array_map(fn($kind) => $prefix . $kind, array_keys(ExportFile::COLUMNS))) === $unrelated, 'Ordinary WordPress or other tenant tables changed');
$after = fingerprints();
// Exercise every ASCII control, SQL-looking text and supplementary Unicode in
// the real mixed-charset table, then roll back this extra synthetic record.
$transport = $export->data['records'][0]['fields'];
$transport[0] = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
$transport[3] = implode('', array_map('chr', range(0, 127))) . "é e\u{0301} 日本語 😀 '); DROP TABLE imaginary; -- %s";
$target->begin();
try {
    $target->insert('pastes', $transport);
    verify($target->read('pastes', $transport[0], true) === $transport, 'Real SQL transport changed controls, quoting or UTF-8');
} finally { $target->rollback(); }
verify(fingerprints() === $after, 'Transport regression left persistent data');
$rerun = $importer->reconcile($export); verify($rerun['rows']['identical'] === 5 && $rerun['rows']['insert'] === 0, 'Real rerun is not idempotent');
$importer->apply($export, $rerun['plan_sha256'], true); verify(fingerprints() === $after, 'No-op rerun rewrote data');
$changed = $export->data; $changed['records'][0]['fields'][3] .= 'synthetic conflict';
$changed['records'][0]['sha256'] = ExportFile::rowHash('pastes', $changed['records'][0]['fields']);
$changed['content_sha256'] = hash('sha256', "pbin-content-v1\n" . implode('', array_map(fn($row) => $row['sha256'] . "\n", $changed['records'])));
$raw = ExportFile::json($changed); $conflicting = ExportFile::parse($raw, hash('sha256', $raw)); $conflictPlan = $importer->reconcile($conflicting);
verify($conflictPlan['rows']['conflict'] === 1, 'Real conflict missed'); refusal(fn() => $importer->apply($conflicting, $conflictPlan['plan_sha256'], true));
verify(fingerprints() === $after, 'Collision overwrote existing content');

// Verify imported rows through the actual supported PHP storage API as well.
require $plugin . '/includes/instance.php';
\Pbin\Plugin\Instance::select(new \Pbin\Plugin\Instance('default', '/paste', $plugin));
require $plugin . '/includes/store.php';
$store = new \Pbin\Plugin\PBIN_Store($wpdb);
$first = $export->data['records'][0]['fields'];
verify($store->GetPaste($first[0])['Text'] === $first[3] && $store->GetPaste($first[0])['SK'] === $first[1], 'Public store paste round-trip failed');
$snapshots = $store->ListSnapshots($first[0]);
verify(array_column($snapshots, 'PK') === ['55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444'], 'Snapshot history tie ordering changed');
verify($store->GetSnapshot($snapshots[1]['PK'])['SK'] === '2038-01-19T03:14:08.123456789Z', 'Snapshot timestamp lost precision');
$diff = $export->data['records'][2]['fields']; verify($store->GetDiff($diff[0])['NewText'] === $diff[3], 'Diff round-trip failed');

// Exercise the real public CLI in a fresh SHORTINIT process, not just a unit API.
$command = [PHP_BINARY, dirname(__DIR__) . '/import.php', '--export=' . $path, '--export-sha256=' . $hash, '--wordpress-load=' . $load, '--database=' . $database, '--table-prefix=' . $prefix];
$process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
verify(is_resource($process), 'Cannot launch importer CLI'); fclose($pipes[0]);
$stdout = stream_get_contents($pipes[1]); $stderr = stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]);
verify(proc_close($process) === 0 && $stderr === '', 'CLI dry run failed (inspect private synthetic fixture logs)');
$cli = json_decode($stdout, true, 16, JSON_THROW_ON_ERROR); verify($cli['mode'] === 'dry-run' && $cli['rows']['identical'] === 5, 'CLI receipt incorrect');
verify(fingerprints() === $after, 'CLI dry run mutated data');
echo "PASS: real MySQL legacy import, exact Unicode/nanoseconds/IDs, snapshot history, interrupted rollback, conflict refusal, idempotence, CLI dry run and untouched WordPress data\n";

require __DIR__ . '/mysql-faults.php';
