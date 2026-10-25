<?php
/** A single synthetic row, shared by the real protocol-fault writer/observer. */
function commitFaultExport(): \Pbin\Migration\ExportFile {
    $fields = ['ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-10-25T00:00:00Z', 'text', "synthetic committed despite lost reply 😀\0", ''];
    $record = ['kind' => 'pastes', 'fields' => $fields, 'sha256' => \Pbin\Migration\ExportFile::rowHash('pastes', $fields)];
    $data = ['format' => \Pbin\Migration\ExportFile::FORMAT, 'source_sha256' => hash('sha256', 'synthetic commit-response-loss fixture'),
        'counts' => ['pastes' => 1, 'diffs' => 0, 'snapshots' => 0],
        'content_sha256' => hash('sha256', "pbin-content-v1\n" . $record['sha256'] . "\n"), 'records' => [$record]];
    $raw = \Pbin\Migration\ExportFile::json($data);
    return \Pbin\Migration\ExportFile::parse($raw, hash('sha256', $raw));
}
