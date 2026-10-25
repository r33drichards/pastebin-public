<?php
use Pbin\Plugin\Instance;
use Pbin\Plugin\PBIN_Store;
use Pbin\Plugin\PBIN_Completion;
// Portable helper regression tests. Run with the target PHP interpreter to
// verify its integer width; native PHP64 results do not certify wasm32.
define('ABSPATH', __DIR__ . '/');
define('ARRAY_A', 'ARRAY_A');
require dirname(__DIR__) . '/pbin/includes/instance.php';
Instance::select(new Instance('default', '', dirname(__DIR__) . '/pbin'));
require dirname(__DIR__) . '/pbin/includes/store.php';
require dirname(__DIR__) . '/pbin/includes/completion.php';

function platformCheck(bool $condition, string $message): void {
    if (!$condition) { throw new RuntimeException($message); }
}
function wp_generate_uuid4(): string { return 'a88fbdd9-38a8-482b-8b86-75d35db7cc39'; }

final class PlatformFixtureDB {
    public string $prefix = 'test_';
    public string $last_error = '';
    public array $row = [];
    public array $inserted = [];
    public function prepare(string $query, ...$args): string { return $query; }
    public function get_row(string $query, $format): array { return $this->row; }
    public function insert(string $table, array $row): int { $this->inserted[$table] = $row; return 1; }
}
$db = new PlatformFixtureDB();
$store = new PBIN_Store($db);
$db->row = ['id' => wp_generate_uuid4(), 'paste_id' => wp_generate_uuid4(), 'text' => '😀', 'language' => 'text', 'title' => '', 'name' => 'date fixture'];
$dates = [
    '2038-01-19T03:14:07Z' => '2038-01-19T03:14:07Z',
    '2038-01-19T03:14:08.123456789Z' => '2038-01-19T03:14:08Z',
    '2100-02-28T19:14:08.123456789Z' => '2100-02-28T19:14:08Z',
    '9999-12-31T23:59:59.999999999Z' => '9999-12-31T23:59:59Z',
    '1900-01-01T00:00:00Z' => '1900-01-01T00:00:00Z',
    '0000-01-01T00:00:00Z' => '0000-01-01T00:00:00Z',
    '2038-01-19T04:14:08.123456789+01:00' => '2038-01-19T03:14:08Z',
    '2038-01-19T03:14:08,123Z' => '2038-01-19T03:14:08Z',
    'invalid stored value' => 'invalid stored value',
    'tomorrow' => 'tomorrow',
    '2038-02-30T00:00:00Z' => '2038-02-30T00:00:00Z',
    '2038-01-19T24:00:00Z' => '2038-01-19T24:00:00Z',
    '' => '',
];
$oldTimezone = date_default_timezone_get();
try {
    date_default_timezone_set('Pacific/Honolulu');
    foreach ($dates as $raw => $expected) {
        $db->row['created_at'] = $raw;
        $snapshot = $store->GetSnapshot($db->row['id']);
        platformCheck($snapshot['CreatedAt'] === $expected, 'Snapshot date: ' . $raw);
        platformCheck($snapshot['SK'] === $raw, 'Stored date must remain unchanged');
    }
    $before = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $store->AddPaste('body', 'text');
    $store->AddDiff('before', 'after');
    $after = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    foreach ($db->inserted as $row) {
        platformCheck(preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/D', $row['created_at']) === 1, 'New dates use UTC RFC3339');
        $date = new DateTimeImmutable($row['created_at']);
        platformCheck($date >= $before->modify('-1 second') && $date <= $after, 'New dates do not use the PHP default timezone');
    }
} finally { date_default_timezone_set($oldTimezone); }

$timeout = new ReflectionMethod(PBIN_Completion::class, 'timeout');
$previous = getenv('COMPLETION_TIMEOUT_SECONDS');
try {
    foreach ([
        '' => 25, '0' => 25, '-10' => 25, 'invalid' => 25, '5s' => 25,
        '1.5' => 25, '1e3' => 25, ' 7' => 25, "7\n" => 25,
        '1' => 1, '+17' => 17, '00031' => 31, '+00031' => 31,
        '2147483647' => 2147483647,
        '2147483648' => PHP_INT_SIZE === 4 ? 25 : 2147483648,
        (string) PHP_INT_MAX => PHP_INT_MAX,
        (string) PHP_INT_MAX . '0' => 25,
        str_repeat('9', 100) => 25,
    ] as $value => $expected) {
        putenv('COMPLETION_TIMEOUT_SECONDS=' . $value);
        platformCheck($timeout->invoke(null) === $expected, 'Completion timeout: ' . $value);
    }
} finally {
    putenv($previous === false ? 'COMPLETION_TIMEOUT_SECONDS' : 'COMPLETION_TIMEOUT_SECONDS=' . $previous);
}
echo 'PASS: portable date and configuration checks; PHP ', PHP_VERSION, ', PHP_INT_SIZE=', PHP_INT_SIZE, "\n";
