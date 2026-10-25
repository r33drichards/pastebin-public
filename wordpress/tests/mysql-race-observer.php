<?php
namespace Pbin\Preview\Tests;
/** Test-only live lock observer and fail-safe diagnostics. No credentials or SQL dumps. */
final class RaceObserver {
    private static function id(string $id): void {
        if (!preg_match('/\A[1-9][0-9]*\z/', $id)) { throw new \RuntimeException('Invalid fixture connection identifier'); }
    }
    public static function query(object $db, array $connections, string $blocker, string $table): string {
        self::id($blocker);
        if (count($connections) !== 2 || count(array_unique($connections)) !== 2) { throw new \RuntimeException('Two distinct fixture writers required'); }
        foreach ($connections as $id) { self::id($id); }
        if (in_array($blocker, $connections, true)) { throw new \RuntimeException('Blocker must be independent'); }
        // INNODB_TRX uses a 100ms-last-read cache in MySQL 8.4.4; polling it
        // every 20ms can indefinitely refresh the SAME stale zero-waiter view.
        // Performance Schema exposes the live lock dependency, not that cache.
        return $db->prepare("SELECT DISTINCT waiting.PROCESSLIST_ID AS connection_id
            FROM performance_schema.data_lock_waits AS waits
            JOIN performance_schema.threads AS waiting ON waiting.THREAD_ID = waits.REQUESTING_THREAD_ID
            JOIN performance_schema.threads AS blocking ON blocking.THREAD_ID = waits.BLOCKING_THREAD_ID
            JOIN performance_schema.data_locks AS requested ON requested.ENGINE = waits.ENGINE AND requested.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID
            WHERE waits.ENGINE = 'INNODB' AND waiting.PROCESSLIST_ID IN (" . implode(',', $connections) . ")
              AND blocking.PROCESSLIST_ID = " . $blocker . "
              AND requested.OBJECT_SCHEMA = DATABASE() AND requested.OBJECT_NAME = %s
              AND requested.LOCK_TYPE = 'RECORD' AND requested.LOCK_STATUS = 'WAITING'", $table);
    }
    public static function allWaiting(array $rows, array $connections): bool {
        $actual = array_map(static fn($row) => (string) ($row['connection_id'] ?? ''), $rows);
        sort($actual, SORT_STRING); sort($connections, SORT_STRING);
        return count($connections) === 2 && count(array_unique($connections)) === 2 && $actual === $connections;
    }
    public static function category(string $message): string {
        foreach (['Failed opening required' => 'missing_dependency', 'Call to undefined function' => 'missing_function', 'Class ' => 'class_error',
            'Allowed memory size' => 'memory_limit', 'syntax error' => 'syntax_error', 'schema' => 'schema', 'singleton' => 'singleton',
            'database read' => 'database_read', 'database operation' => 'database_write', 'connection' => 'connection',
            'transaction' => 'transaction', 'bound exceeded' => 'admission'] as $needle => $label) {
            if (str_contains($message, $needle)) { return $label; }
        }
        return 'unclassified';
    }
    public static function error(\Throwable $error): array {
        return ['class' => get_class($error), 'file' => basename($error->getFile()), 'line' => $error->getLine(), 'category' => self::category($error->getMessage())];
    }
    /** Whitelist protocol fields; never replay raw worker output/error messages. */
    public static function output(string $raw): array {
        $lines = explode("\n", substr($raw, 0, 8192)); $safe = [];
        foreach (array_slice($lines, 0, 8) as $line) {
            if ($line === '') { continue; }
            if (preg_match('/\AREADY:[1-9][0-9]*\z/', $line)) { $safe[] = 'ready'; continue; }
            $record = json_decode(str_starts_with($line, 'WORKER_ERROR ') ? substr($line, 13) : $line, true);
            if (!is_array($record)) { $safe[] = ['unparsed_bytes' => strlen($line), 'category' => self::category($line)]; continue; }
            $summary = [];
            $classes = ['Error', 'TypeError', 'ValueError', 'RuntimeException', 'JsonException', 'PHPFatal',
                'Pbin\\Preview\\RegistryException', 'Pbin\\Preview\\RegistryConflict', 'Pbin\\Preview\\RegistryCommitUncertain'];
            $categories = ['missing_dependency', 'missing_function', 'class_error', 'memory_limit', 'syntax_error', 'schema',
                'singleton', 'database_read', 'database_write', 'connection', 'transaction', 'admission', 'unclassified'];
            $allowed = ['outcome' => ['committed', 'conflict', 'quota', 'refused'], 'type' => $classes, 'class' => $classes,
                'reason' => $categories, 'category' => $categories,
                'file' => ['mysql-preview-registry-integration.php', 'mysql-registry.php', 'mysql-race-observer.php',
                    'class-wpdb.php', 'wp-db.php', 'wp-settings.php', 'fixture.php']];
            foreach ($allowed as $key => $values) {
                if (isset($record[$key]) && in_array($record[$key], $values, true)) { $summary[$key] = $record[$key]; }
            }
            if (isset($record['line']) && is_int($record['line'])) { $summary['line'] = $record['line']; }
            $safe[] = $summary ?: ['unrecognized_fields' => true];
        }
        return ['bytes' => strlen($raw), 'summary' => $safe];
    }
}
