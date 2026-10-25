<?php
/** Included only by mysql.php after its exact disposable fixture validation. */
if (PHP_SAPI !== 'cli' || !isset($target, $wpdb, $database, $prefix, $after)) { throw new RuntimeException('Validated MySQL fixture required'); }
$children = [];
function startFaultWorker(string $mode): array {
    $process = proc_open([PHP_BINARY, __DIR__ . '/mysql-worker.php', $mode], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    verify(is_resource($process), 'Cannot start fault worker');
    stream_set_blocking($pipes[1], false); stream_set_blocking($pipes[2], false);
    return ['process' => $process, 'pipes' => $pipes];
}
function faultMessage(array $child, string $expected): array {
    $deadline = microtime(true) + 15; $buffer = '';
    while (microtime(true) < $deadline) {
        $read = [$child['pipes'][1]]; $write = $except = [];
        $ready = stream_select($read, $write, $except, 0, 100000);
        verify($ready !== false, 'Worker select failed');
        if ($ready) {
            $part = fgets($child['pipes'][1], 4096);
            if ($part !== false) { $buffer .= $part; }
            verify(strlen($buffer) <= 4096, 'Worker message exceeds bound');
            if (str_ends_with($buffer, "\n")) {
                $message = json_decode($buffer, true, 8, JSON_THROW_ON_ERROR);
                verify(($message['state'] ?? '') === $expected, 'Unexpected worker state'); return $message;
            }
        }
        if (!proc_get_status($child['process'])['running'] && feof($child['pipes'][1])) { break; }
    }
    throw new RuntimeException('Worker message timeout or early exit (synthetic diagnostics withheld)');
}
function faultCommand(array $child, string $command): void {
    verify(fwrite($child['pipes'][0], $command . "\n") === strlen($command) + 1, 'Cannot command worker'); fflush($child['pipes'][0]);
}
function finishFaultWorker(array &$child, bool $killed = false): void {
    $deadline = microtime(true) + 5;
    do { $status = proc_get_status($child['process']); if (!$status['running']) { break; } usleep(20000); } while (microtime(true) < $deadline);
    verify(!$status['running'], 'Worker failed to exit within bound');
    if ($killed) { verify($status['signaled'] && $status['termsig'] === 9, 'Worker was not terminated with SIGKILL'); }
    else { verify($status['exitcode'] === 0, 'Fault worker failed'); }
    $stderr = stream_get_contents($child['pipes'][2]); verify($stderr === '', 'Worker emitted unexpected diagnostics');
    foreach ($child['pipes'] as $pipe) { fclose($pipe); } proc_close($child['process']); $child = [];
}
function faultConnection(string $connection): array {
    global $wpdb, $database;
    verify(preg_match('/\A[1-9][0-9]*\z/', $connection) === 1, 'Unsafe connection identifier');
    $rows = $wpdb->get_results($wpdb->prepare('SELECT ID, DB, HOST FROM information_schema.PROCESSLIST WHERE ID = %s', $connection), ARRAY_A);
    verify(is_array($rows) && count($rows) === 1 && $wpdb->last_error === '', 'Worker connection not found');
    // DB_HOST is loopback in both processes. A containerized MySQL server may
    // report the Docker bridge as HOST, so do not mistake that for a remote DB.
    verify($rows[0]['DB'] === $database && $connection !== (string) $wpdb->get_var('SELECT CONNECTION_ID()'), 'Worker connection is outside disposable fixture or is the observer');
    return $rows[0];
}
try {
    // Death after a real insert, not a PHP exception/rollback double.
    $children['killed'] = startFaultWorker('killed'); $held = faultMessage($children['killed'], 'held'); faultConnection($held['connection']);
    verify(proc_terminate($children['killed']['process'], 9), 'Cannot SIGKILL synthetic worker'); finishFaultWorker($children['killed'], true);
    verify($target->read('pastes', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false) === null, 'Killed transaction became visible');
    verify($wpdb->query('SET SESSION innodb_lock_wait_timeout = 5') !== false, 'Cannot bound observer lock wait');
    $target->begin();
    try { $target->insert('pastes', ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-10-25T00:00:00Z', 'text', 'lock release proof', '']); }
    finally { $target->rollback(); }
    verify(fingerprints() === $after, 'Killed-client test changed persistent fixture data');

    $children['winner'] = startFaultWorker('race-winner'); $winner = faultMessage($children['winner'], 'held'); faultConnection($winner['connection']);
    $children['loser'] = startFaultWorker('race-loser'); $loser = faultMessage($children['loser'], 'inserting'); faultConnection($loser['connection']);
    // Require observed overlap in InnoDB, not just two sequential processes.
    $waiting = false; $deadline = microtime(true) + 5;
    do {
        $state = $wpdb->get_var($wpdb->prepare('SELECT trx_state FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = %s', $loser['connection']));
        verify($wpdb->last_error === '', 'Cannot inspect disposable lock wait');
        if ($state === 'LOCK WAIT') { $waiting = true; break; } usleep(50000);
    } while (microtime(true) < $deadline);
    verify($waiting, 'Concurrent writer never entered an observed InnoDB lock wait');
    faultCommand($children['winner'], 'commit'); faultMessage($children['winner'], 'committed'); finishFaultWorker($children['winner']);
    faultMessage($children['loser'], 'conflict-refused'); finishFaultWorker($children['loser']);
    $race = $target->read('pastes', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', false);
    verify($race !== null && $race[3] === "synthetic race-winner 😀\0", 'Racing loser overwrote winning row');
    // Delete only our exact known synthetic winner, inside the guarded fixture.
    verify($wpdb->query($wpdb->prepare("DELETE FROM `{$prefix}pastes` WHERE id = %s", 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')) === 1, 'Cannot clean synthetic race winner');
    verify(fingerprints() === $after, 'Race affected unrelated fixture data');

    $children['reconnect'] = startFaultWorker('reconnect'); $held = faultMessage($children['reconnect'], 'held'); faultConnection($held['connection']);
    verify($wpdb->query('KILL CONNECTION ' . $held['connection']) !== false, 'Cannot interrupt exact synthetic worker connection');
    faultCommand($children['reconnect'], 'attempt'); faultMessage($children['reconnect'], 'reconnect-refused'); finishFaultWorker($children['reconnect']);
    verify($target->read('pastes', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', false) === null, 'Disconnected transaction persisted');
    verify($target->read('pastes', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', false) === null, 'Reconnect replay autocommitted');
    verify(fingerprints() === $after, 'Reconnection fault affected persistent fixture data');
    echo "PASS: real MySQL killed-client rollback/lock release, observed concurrent insertion conflict, and reconnect-replay fencing (not COMMIT-response-loss)\n";
} finally {
    foreach ($children as &$child) {
        if ($child === []) { continue; }
        if (proc_get_status($child['process'])['running']) { proc_terminate($child['process'], 9); }
        foreach ($child['pipes'] as $pipe) { if (is_resource($pipe)) { fclose($pipe); } }
        proc_close($child['process']);
    }
}
