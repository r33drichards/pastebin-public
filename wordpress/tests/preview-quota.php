<?php
/** Synthetic unit gate; no live WordPress, MySQL, concurrency or network. */
use Pbin\Plugin\Instance;
use Pbin\Plugin\PBIN_Store;
use Pbin\Plugin\PreviewQuota;
use Pbin\Plugin\PreviewQuotaExceeded;
use Pbin\Plugin\PreviewQuotaCommitUncertain;
define('ABSPATH', __DIR__ . '/');
define('ARRAY_A', 'ARRAY_A');
require dirname(__DIR__) . '/pbin/includes/instance.php';
require dirname(__DIR__) . '/pbin/includes/store.php';
require __DIR__ . '/preview-quota-fixture.php';
Instance::select(new Instance('pr_920001', '/previews/pr-920001', realpath(dirname(__DIR__) . '/pbin'), str_repeat('a', 40), true));
function wp_generate_uuid4(): string { static $id = 0; return sprintf('00000000-0000-4000-8000-%012d', ++$id); }
function wp_salt(string $scope): string { return 'synthetic-fixture-only'; }
function quotaCheck(bool $value, string $message): void { if (!$value) { throw new RuntimeException($message); } }
function quotaReject(callable $action, string $type = RuntimeException::class): void {
    try { $action(); } catch (Throwable $error) { quotaCheck($error instanceof $type, 'Wrong rejection type: ' . get_class($error) . ': ' . $error->getMessage()); return; }
    throw new RuntimeException('Expected rejection');
}
function freshQuota(): array {
    $db = new PreviewQuotaFixtureDB();
    $prefix = $db->prefix . Instance::current()->storagePrefix();
    $quota = new PreviewQuota($db, $prefix);
    $quota->install();
    return [$db, new PBIN_Store($db), $quota, $prefix];
}
$tests = 0;
function testQuota(string $name, callable $test): void { global $tests; $test(); ++$tests; echo 'PASS: ', $name, "\n"; }
testQuota('UTF-8 byte accounting across every text-bearing document field', function (): void {
    [$db, $store, $quota, $prefix] = freshQuota();
    $paste = $store->AddPaste('😀', 'λ', 'é'); // 8 bytes.
    $store->AddDiff('界', 'é'); // 5 bytes.
    $store->AddSnapshot($paste, '界', '😀', 'λ', 'é'); // 11 bytes.
    $store->AddPaste(str_repeat('x', PreviewQuota::MAX_BYTES - 24), '', '');
    quotaReject(fn() => $store->AddDiff('', 'x'), PreviewQuotaExceeded::class);
    quotaCheck(count($db->rows[$prefix . 'pastes']) === 2 && count($db->rows[$prefix . 'diffs']) === 1 && count($db->rows[$prefix . 'snapshots']) === 1, 'Rejected insert leaked');
    quotaCheck($store->GetPaste($paste)['Text'] === '😀', 'Existing UTF-8 document lost');
});
testQuota('At-cap no-op, shrinking and subsequent reuse preserve data', function (): void {
    [$db, $store, $quota, $prefix] = freshQuota();
    $full = str_repeat('x', PreviewQuota::MAX_BYTES);
    $id = $store->AddPaste($full, '', '');
    $store->UpdatePaste($id, $full, '', '');
    quotaReject(fn() => $store->AddSnapshot($id, 'n', '', '', ''), PreviewQuotaExceeded::class);
    $store->UpdatePaste($id, '😀', '', '');
    $other = $store->AddDiff(str_repeat('x', PreviewQuota::MAX_BYTES - 4), '');
    quotaCheck($store->GetPaste($id)['Text'] === '😀' && strlen($store->GetDiff($other)['OldText']) === PreviewQuota::MAX_BYTES - 4, 'Shrink did not release capacity');
});
testQuota('Record cap includes empty pastes, diffs and immutable snapshots', function (): void {
    [$db, $store, $quota, $prefix] = freshQuota();
    $id = $store->AddPaste('', '', '');
    for ($i = 1; $i < PreviewQuota::MAX_DOCUMENTS - 1; ++$i) { $store->AddDiff('', ''); }
    $snapshot = $store->AddSnapshot($id, 'n', '', '', '');
    quotaReject(fn() => $store->AddPaste('', '', ''), PreviewQuotaExceeded::class);
    quotaReject(fn() => $store->AddDiff('', ''), PreviewQuotaExceeded::class);
    quotaReject(fn() => $store->AddSnapshot($id, 'n', '', '', ''), PreviewQuotaExceeded::class);
    $store->UpdatePaste($id, 'still editable', '', '');
    quotaCheck($store->GetSnapshot($snapshot['ID'])['Text'] === '', 'Snapshot changed');
});
testQuota('Oversized and invalid UTF-8 input rejected before mutation', function (): void {
    [$db, $store, $quota, $prefix] = freshQuota();
    $id = $store->AddPaste('retained', '', '');
    $huge = str_repeat('x', PreviewQuota::MAX_BYTES + 1);
    $before = $db->rows;
    foreach ([fn() => $store->AddPaste($huge, '', ''), fn() => $store->AddPaste('', $huge, ''), fn() => $store->AddDiff('', $huge), fn() => $store->AddSnapshot($id, $huge, '', '', ''), fn() => $store->UpdatePaste($id, '', '', $huge), fn() => $store->AddPaste("\xff", '', '')] as $action) {
        quotaReject($action, PreviewQuotaExceeded::class);
        quotaCheck($db->rows === $before, 'Oversized input mutated data');
    }
});
testQuota('Failed inserts, updates, snapshots and charset truncation roll back', function (): void {
    [$db, $store, $quota, $prefix] = freshQuota();
    $id = $store->AddPaste('original', '', '');
    $before = $db->rows;
    foreach ([['INSERT INTO', fn() => $store->AddDiff('a', 'b')], ['UPDATE', fn() => $store->UpdatePaste($id, 'changed', '', '')], ['INSERT INTO', fn() => $store->AddSnapshot($id, 'n', 'snapshot', '', '')]] as [$fail, $action]) {
        $db->fail = $fail; quotaReject($action); quotaCheck($db->rows === $before, 'Failure leaked a mutation');
    }
    $db->truncateNext = true; quotaReject(fn() => $store->AddPaste('😀', '', ''));
    quotaCheck($db->rows === $before, 'Truncated insert committed');
    $db->truncateNext = true; quotaReject(fn() => $store->UpdatePaste($id, '😀', '', ''));
    quotaCheck($db->rows === $before, 'Truncated update committed');
    quotaReject(fn() => $store->AddSnapshot('missing', 'n', '', '', ''), OutOfBoundsException::class);
    quotaCheck($db->rows === $before, 'Orphan snapshot created');
});
testQuota('Reconnect/replay fences every document mutation', function (): void {
    [$db, $store, $quota, $prefix] = freshQuota();
    $id = $store->AddPaste('original', '', '');
    $before = $db->rows;
    foreach ([['INSERT INTO', fn() => $store->AddPaste('lost', '', '')], ['UPDATE', fn() => $store->UpdatePaste($id, 'lost', '', '')], ['INSERT INTO', fn() => $store->AddSnapshot($id, 'n', 'lost', '', '')], ['COUNT(*) AS documents', fn() => $store->AddDiff('lost', '')]] as [$disconnect, $action]) {
        $db->disconnect = $disconnect; quotaReject($action); quotaCheck($db->rows === $before, 'Replayed mutation escaped transaction');
    }
    $db->disconnect = 'COMMIT'; quotaReject(fn() => $store->AddDiff('uncertain', ''), PreviewQuotaCommitUncertain::class);
});
testQuota('Missing, corrupt or non-InnoDB quota fails closed without repair', function (): void {
    foreach (['missing', 'empty', 'duplicate', 'version', 'engine'] as $case) {
        [$db, $store, $quota, $prefix] = freshQuota();
        if ($case === 'missing') { $db->quotaExists = false; }
        if ($case === 'empty') { $db->quotaRows = []; }
        if ($case === 'duplicate') { $db->quotaRows[] = $db->quotaRows[0]; }
        if ($case === 'version') { $db->quotaRows[0]['schema_version'] = 9; }
        if ($case === 'engine') { $db->engines[$prefix . 'pastes'] = 'MyISAM'; }
        $queries = count($db->queries);
        quotaReject(fn() => $store->AddPaste('blocked', '', ''));
        foreach (array_slice($db->queries, $queries) as $query) { quotaCheck(!str_starts_with($query, 'CREATE ') && !str_starts_with($query, 'INSERT '), 'Write path repaired quota'); }
    }
});
testQuota('Migration rejects existing over-budget rows and preserves every document', function (): void {
    $db = new PreviewQuotaFixtureDB(); $prefix = $db->prefix . Instance::current()->storagePrefix();
    $db->rows[$prefix . 'pastes']['legacy'] = ['id' => 'legacy', 'text' => str_repeat('x', PreviewQuota::MAX_BYTES + 1), 'language' => '', 'title' => ''];
    $before = $db->rows;
    quotaReject(fn() => (new PreviewQuota($db, $prefix))->install(), PreviewQuotaExceeded::class);
    quotaCheck($db->rows === $before && $db->quotaRows === [], 'Failed migration lost data or committed initialization');
    quotaReject(fn() => (new PreviewQuota($db, $prefix))->install()); // Partial state is not silently repaired.
});
testQuota('Limiter cap, existing clients and expired-metadata reclamation', function (): void {
    [$db, $store, $quota, $prefix] = freshQuota();
    $id = $store->AddPaste('retained', '', '');
    for ($i = 0; $i < PreviewQuota::MAX_BUCKETS; ++$i) { quotaCheck($quota->allowRequest(hash('sha256', (string) $i), 10000, 1), 'Bucket denied before cap'); }
    quotaCheck(!$quota->allowRequest(hash('sha256', 'new'), 10001, 1), 'Bucket cap bypassed');
    quotaCheck(!$quota->allowRequest(hash('sha256', '0'), 10000, 1), 'Rate limit bypassed');
    quotaCheck($quota->allowRequest(hash('sha256', '0'), 10002, 1), 'Existing client blocked by full table');
    quotaCheck($quota->allowRequest(hash('sha256', 'new'), 20000, 1), 'Expired bucket space not reclaimed');
    quotaCheck(count($db->rows[$prefix . 'limits']) === 1 && $store->GetPaste($id)['Text'] === 'retained', 'Reclamation affected documents');
    $before = $db->rows;
    $db->disconnect = 'INSERT INTO'; quotaReject(fn() => $quota->allowRequest(hash('sha256', 'lost'), 30000, 1));
    quotaCheck($db->rows === $before, 'Limiter reconnect escaped transaction');
});
testQuota('Caller-owned transactions and non-autocommit sessions are rejected', function (): void {
    [$db, $store] = freshQuota();
    $db->query('START TRANSACTION');
    quotaReject(fn() => $store->AddPaste('no', '', ''));
    quotaCheck(end($db->queries) === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'Caller-owned transaction was committed/rolled back');
    $db->query('ROLLBACK'); $db->autocommit = false;
    quotaReject(fn() => $store->AddPaste('no', '', ''));
});
echo "PASS: $tests synthetic preview quota cases; real SQL and concurrent admission require the hosted fixture\n";
