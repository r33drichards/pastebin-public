<?php
// This is an implementation-level integration test, not the independent HTTP
// acceptance suite. Run only against the disposable run-http-acceptance fixture.
require $argv[1];
if (DB_NAME !== 'pbin_acceptance' || !str_contains(ABSPATH, '/pbin-wp-acceptance.')) {
    throw new RuntimeException('Refusing to run outside the isolated acceptance database');
}
require_once dirname(__DIR__) . '/pbin/includes/collab-store.php';

if (($argv[2] ?? '') === '--child') {
    $job = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
    echo "READY\n"; flush();
    try {
        $store = new PBIN_CollabStore();
        $result = $job['action'] === 'replace'
            ? $store->replace($job['id'], $job['text'], $job['lang'], $job['title'])
            : $store->apply($job['id'], $job['rev'], $job['seq'], $job['key'], $job['op']);
        echo json_encode(['ok' => $result], JSON_THROW_ON_ERROR) . "\n";
    } catch (Throwable $e) { echo json_encode(['error' => $e->getMessage()]) . "\n"; exit(1); }
    exit;
}

function verify(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
function fails(callable $fn, string $message): void {
    try { $fn(); } catch (Throwable $error) {
        verify($error->getMessage() === $message, 'Unexpected error: ' . $error->getMessage() . ' instead of ' . $message); return;
    }
    throw new RuntimeException('Expected ' . $message);
}
function jobsTogether(string $id, array $jobs): array {
    global $wpdb, $argv;
    // A real row-lock barrier makes the two child connections contend for the
    // same document, instead of merely hoping their PHP startup times overlap.
    $wpdb->query('START TRANSACTION');
    $wpdb->get_row($wpdb->prepare("SELECT id FROM {$wpdb->prefix}pbin_pastes WHERE id=%s FOR UPDATE", $id));
    $processes = [];
    foreach ($jobs as $job) {
        $command = [PHP_BINARY, '-n', '-d', 'extension_dir=' . ini_get('extension_dir')];
        foreach (['mysqlnd', 'mysqli', 'dom', 'mbstring', 'xml'] as $extension) { $command[] = '-d'; $command[] = 'extension=' . $extension . '.so'; }
        $command[] = __FILE__; $command[] = $argv[1]; $command[] = '--child';
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) { throw new RuntimeException('Could not start concurrency worker'); }
        fwrite($pipes[0], json_encode($job, JSON_THROW_ON_ERROR)); fclose($pipes[0]);
        $processes[] = [$process, $pipes];
    }
    foreach ($processes as [$process, $pipes]) { verify(trim(fgets($pipes[1])) === 'READY', 'Concurrency worker did not reach barrier'); }
    $wpdb->query('COMMIT');
    $results = [];
    foreach ($processes as [$process, $pipes]) {
        $output = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]);
        fclose($pipes[1]); fclose($pipes[2]);
        $status = proc_close($process);
        verify($status === 0, 'Concurrency worker failed: ' . $output . $error);
        $result = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
        verify(isset($result['ok']), 'Concurrency result missing success');
        $results[] = $result['ok'];
    }
    return $results;
}
function replay(PBIN_CollabStore $rooms, string $id, string $initial): string {
    $doc = PBIN_UTF16::fromUTF8($initial);
    foreach ($rooms->changesSince($id, 0)['changes'] as $change) { $doc = PBIN_TextOp::fromWire($change['op'])->Apply($doc); }
    return PBIN_UTF16::toUTF8($doc);
}

PBIN_CollabStore::install();
// Repeated installation must preserve schema and data without a migration error.
PBIN_CollabStore::install();
$pastes = new PBIN_Store(); $rooms = new PBIN_CollabStore();
fails(fn() => $rooms->load('not-found'), 'paste not found');
$id = $pastes->AddPaste("a\r\nb\rc", 'text', 'first');
$state = $rooms->load($id, 'a');
verify($state['text'] === "a\nb\nc" && $state['rev'] === 0 && $state['lastSeq'] === 0, 'initial normalized state');
verify($pastes->GetPaste($id)['Text'] === "a\r\nb\rc", 'opening a room does not rewrite raw text');
$op = $rooms->apply($id, 0, 1, 'a', [5, '😀']);
verify($op['rev'] === 1 && $op['text'] === "a\nb\nc😀", 'first apply result');
verify($pastes->GetPaste($id)['Text'] === $op['text'], 'paste committed synchronously');
verify($rooms->load($id, 'a')['lastSeq'] === 1, 'client sequence committed');
fails(fn() => $rooms->apply($id, 0, 1, 'a', [5, '😀']), 'duplicate operation');
fails(fn() => $rooms->apply($id, 999, 2, 'a', [7]), 'resync');
$before = $rooms->load($id, 'a');
try { $rooms->apply($id, 1, 2, 'a', [999]); throw new RuntimeException('invalid op unexpectedly succeeded'); }
catch (InvalidArgumentException $e) { /* Invalid base lengths must roll back. */ }
verify($rooms->load($id, 'a') === $before, 'invalid operation changed revision or sequence');
fails(fn() => $rooms->apply($id, 1, 2, 'a', [7, str_repeat('x', PBIN_CollabStore::MAX_DOCUMENT)]), 'document too large');
verify($rooms->load($id, 'a') === $before, 'oversized operation changed state');
$replace = $rooms->replace($id, "new\r\nvalue", 'php', 'new title');
verify($replace['rev'] === 2 && $replace['text'] === "new\nvalue", 'replace revision and normalized live text');
verify($pastes->GetPaste($id)['Text'] === "new\r\nvalue", 'HTTP raw replacement preserves CRLF');
verify($rooms->setLanguage($id, 'python') === ['rev' => 2, 'lang' => 'python', 'changed' => true], 'language update');
verify($rooms->setLanguage($id, 'python')['changed'] === false, 'same language is a no-op');
fails(fn() => $rooms->setLanguage($id, str_repeat('x', 65)), 'language too long');
$changes = $rooms->changesSince($id, 0);
verify($changes['rev'] === 2 && $changes['lang'] === 'python' && count($changes['changes']) === 2, 'ordered history plus current metadata');
verify($rooms->changesSince($id, 2)['changes'] === [], 'caught-up change feed');
verify(replay($rooms, $id, "a\nb\nc") === $replace['text'], 'history replays to canonical text');
verify((new PBIN_CollabStore())->load($id, 'a')['session'] === $state['session'], 'persistent session survives store instances');

$largeID = $pastes->AddPaste('small', 'text', '');
$largeText = str_repeat('x', PBIN_CollabStore::MAX_DOCUMENT + 1);
$largeResult = $rooms->replace($largeID, $largeText, 'text', 'large HTTP replacement');
verify($largeResult['rev'] === 1 && $largeResult['text'] === $largeText, 'HTTP replacement must not inherit the editor limit');
verify($pastes->GetPaste($largeID)['Text'] === $largeText && $rooms->load($largeID)['text'] === $largeText, 'large HTTP replacement remains coherent and durable');
fails(fn() => $rooms->apply($largeID, 1, 1, 'large-client', [strlen($largeText)]), 'document too large');
verify($rooms->load($largeID, 'large-client')['lastSeq'] === 0, 'rejected live operation did not advance dedup state');
$rooms->apply($largeID, 1, 1, 'large-client', [-strlen($largeText), 'small again']);
verify($pastes->GetPaste($largeID)['Text'] === 'small again', 'live edit can shrink a large raw document below the cap');
unset($largeText, $largeResult);

$unicodeID = $pastes->AddPaste('😀', 'text', '');
$rooms->load($unicodeID);
$rooms->apply($unicodeID, 0, 1, 'unicode', [-1, 1]);
$units = $wpdb->get_var($wpdb->prepare("SELECT doc_utf16 FROM {$wpdb->prefix}pbin_rooms WHERE paste_id=%s", $unicodeID));
verify(bin2hex($units) === '00de', 'database preserves a lone UTF-16 surrogate unit');
verify($rooms->load($unicodeID)['text'] === "\u{FFFD}", 'network boundary replaces lone surrogate');
$rooms->apply($unicodeID, 1, 2, 'unicode', [-1, '🦊']);
verify($pastes->GetPaste($unicodeID)['Text'] === '🦊', 'later Unicode operation uses persisted code-unit document');

$short = new PBIN_CollabStore(null, 4);
$historyID = $pastes->AddPaste('', 'text', '');
for ($rev = 0; $rev < 10; ++$rev) { $short->apply($historyID, $rev, $rev + 1, 'history', $rev ? [$rev, 'x'] : ['x']); }
$trimmed = $short->load($historyID, 'history');
verify($trimmed['rev'] === 10 && $trimmed['histBase'] === 6 && $trimmed['lastSeq'] === 10, 'history compacts to half capacity');
fails(fn() => $short->changesSince($historyID, 5), 'resync');
verify(count($short->changesSince($historyID, 6)['changes']) === 4, 'history boundary stays usable');
fails(fn() => $short->apply($historyID, 0, 11, 'history', ['stale']), 'resync');
verify($short->load($historyID, 'history') === $trimmed, 'stale operation did not mutate state');

for ($round = 0; $round < 10; ++$round) {
    $race = $pastes->AddPaste('', 'text', ''); $rooms->load($race);
    $results = jobsTogether($race, [
        ['action' => 'apply', 'id' => $race, 'rev' => 0, 'seq' => 1, 'key' => 'A', 'op' => ['A']],
        ['action' => 'apply', 'id' => $race, 'rev' => 0, 'seq' => 1, 'key' => 'B', 'op' => ['B']],
    ]);
    $revisions = array_column($results, 'rev'); sort($revisions);
    $state = $rooms->load($race);
    verify($revisions === [1, 2] && in_array($state['text'], ['AB', 'BA'], true), 'concurrent clients lost an edit or revision');
    verify($state['text'] === $pastes->GetPaste($race)['Text'] && replay($rooms, $race, '') === $state['text'], 'concurrent history/paste diverged');
    verify($rooms->load($race, 'A')['lastSeq'] === 1 && $rooms->load($race, 'B')['lastSeq'] === 1, 'concurrent sequence records');

    $race = $pastes->AddPaste('abc', 'text', ''); $rooms->load($race);
    jobsTogether($race, [
        ['action' => 'apply', 'id' => $race, 'rev' => 0, 'seq' => 1, 'key' => 'editor', 'op' => [3, '!']],
        ['action' => 'replace', 'id' => $race, 'text' => 'fresh', 'lang' => 'php', 'title' => 'HTTP title'],
    ]);
    $state = $rooms->load($race);
    verify($state['rev'] === 2 && in_array($state['text'], ['fresh', 'fresh!'], true), 'replace/edit race lost ordering');
    verify($state['text'] === $pastes->GetPaste($race)['Text'] && replay($rooms, $race, 'abc') === $state['text'], 'replace/edit canonical state diverged');
    verify($state['lang'] === 'php' && $state['title'] === 'HTTP title', 'replace metadata was overwritten by stale editor state');
}
echo "PASS: real MariaDB room transactions, durable revisions/sequences, rollback, Unicode, history bounds and 20 two-process races\n";
