<?php
/** Synthetic SQL recorder, NOT a MySQL emulator or integration result. */
class PreviewQuotaFixtureDB {
    public string $prefix = 'wp_fixture_';
    public string $last_error = '';
    public array $rows = [];
    public array $touched = [];
    public array $queries = [];
    public bool $quotaExists = false;
    public array $quotaRows = [];
    public array $engines = [];
    public int $connection = 71;
    public bool $autocommit = true;
    public ?string $fail = null;
    public ?string $disconnect = null;
    public bool $truncateNext = false;
    private array $prepared = [];
    private ?array $saved = null;
    private bool $quiet = false;
    public function get_charset_collate(): string { return 'DEFAULT CHARACTER SET utf8mb4'; }
    public function esc_like(string $value): string { return $value; }
    public function suppress_errors(bool $value): bool { $old = $this->quiet; $this->quiet = $value; return $old; }
    public function prepare(string $query, ...$values): string {
        $result = $query;
        foreach ($values as $value) {
            $result = preg_replace_callback('/%[sdf]/', fn($match) => $match[0] === '%s' ? "'" . str_replace("'", "''", (string) $value) . "'" : (string) $value, $result, 1);
        }
        $this->prepared[$result] = [$query, $values];
        return $result;
    }
    private function begin(string $query): array {
        $this->last_error = '';
        $this->queries[] = $query;
        [$template, $args] = $this->prepared[$query] ?? [$query, []];
        if ($this->disconnect !== null && $this->matches($template, $this->disconnect)) {
            $this->disconnect = null;
            if ($this->saved !== null) { [$this->rows, $this->quotaRows] = $this->saved; $this->saved = null; }
            ++$this->connection;
        }
        if ($this->fail !== null && $this->matches($template, $this->fail)) { $this->fail = null; $this->last_error = 'synthetic failure'; }
        return [$template, $args];
    }
    private function matches(string $query, string $pattern): bool {
        return preg_match('/^(?:INSERT|UPDATE|DELETE|COMMIT|ROLLBACK|START)/', $pattern) ? str_starts_with($query, $pattern) : str_contains($query, $pattern);
    }
    private function table(string $query): string {
        if (!preg_match('/(?:FROM|INTO|UPDATE|TABLE) `?(\w+)`?/', $query, $match)) { throw new RuntimeException('Unrecognized synthetic SQL table: ' . $query); }
        $this->touched[] = $match[1];
        return $match[1];
    }
    public function get_var(string $query): string {
        if (!preg_match("/^SHOW TABLES LIKE '([^']+)'$/", $query, $match)) { throw new RuntimeException('Unexpected migration query'); }
        $this->touched[] = $match[1]; return $match[1];
    }
    public function insert(string $table, array $row): int { $this->touched[] = $table; $this->rows[$table][$row['id']] = $row; return 1; }
    public function update(string $table, array $row, array $where): int { $this->touched[] = $table; $this->rows[$table][$where['id']] = array_replace($this->rows[$table][$where['id']], $row); return 1; }
    public function get_row(string $query, $format): ?array { return $this->get_results($query, $format)[0] ?? null; }
    public function get_results(string $query, $format): array {
        [$template, $args] = $this->begin($query);
        if ($this->last_error !== '') { return []; }
        if (str_starts_with($template, 'SELECT CONNECTION_ID()')) { return [['connection_id' => $this->connection, 'autocommit' => $this->autocommit ? 1 : 0]]; }
        if (str_contains($template, 'information_schema.TABLES')) {
            $table = $args[0]; $this->touched[] = $table;
            if (str_ends_with($table, 'quota') && !$this->quotaExists) { return []; }
            return [['ENGINE' => $this->engines[$table] ?? 'InnoDB']];
        }
        if (str_starts_with($template, 'SHOW COLUMNS')) {
            return [
                ['Field' => 'singleton_id', 'Type' => 'tinyint unsigned', 'Key' => 'PRI', 'Null' => 'NO', 'Extra' => '', 'Default' => null],
                ['Field' => 'schema_version', 'Type' => 'smallint unsigned', 'Key' => '', 'Null' => 'NO', 'Extra' => '', 'Default' => null],
            ];
        }
        $table = $this->table($template);
        if (str_starts_with($template, 'SELECT singleton_id')) {
            if (!$this->quotaExists) { $this->last_error = 'missing quota'; return []; }
            return array_map(fn($row) => $row + ['connection_id' => $this->connection], $this->quotaRows);
        }
        if (str_starts_with($template, 'SELECT 1 ')) { return []; }
        $records = $this->rows[$table] ?? [];
        if (str_contains($template, 'COUNT(*) AS documents')) {
            preg_match_all('/OCTET_LENGTH\((\w+)\)/', $template, $fields);
            $bytes = 0;
            foreach ($records as $row) { foreach ($fields[1] as $field) { $bytes += strlen($row[$field]); } }
            return [['documents' => count($records), 'bytes' => $bytes]];
        }
        if (str_contains($template, 'COUNT(*) AS buckets')) { return [['buckets' => count($records)]]; }
        if (str_contains($template, 'CONNECTION_ID() = %s') && (string) end($args) !== (string) $this->connection) { return []; }
        if (str_contains($template, 'WHERE paste_id')) { return array_values(array_filter($records, fn($row) => $row['paste_id'] === $args[0])); }
        if (str_contains($template, 'WHERE bucket')) { return isset($records[$args[0]]) ? [$records[$args[0]]] : []; }
        if (str_contains($template, 'WHERE id')) { return isset($records[$args[0]]) ? [$records[$args[0]]] : []; }
        throw new RuntimeException('Unrecognized synthetic read: ' . $template);
    }
    public function query(string $query) {
        [$template, $args] = $this->begin($query);
        if ($this->last_error !== '') { return false; }
        if ($template === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') { if ($this->saved !== null) { $this->last_error = 'nested transaction'; return false; } return 0; }
        if ($template === 'START TRANSACTION') { $this->saved = [$this->rows, $this->quotaRows]; return 0; }
        if ($template === 'COMMIT') { $this->saved = null; return 0; }
        if ($template === 'ROLLBACK') { if ($this->saved !== null) { [$this->rows, $this->quotaRows] = $this->saved; } $this->saved = null; return 0; }
        $table = $this->table($template);
        if (str_starts_with($template, 'CREATE TABLE')) { $this->quotaExists = true; return 0; }
        if (str_contains($template, 'CONNECTION_ID() = %s') && (string) end($args) !== (string) $this->connection) { return 0; }
        if (str_contains($template, '(singleton_id, schema_version) SELECT 1,1')) { $this->quotaRows = [['singleton_id' => 1, 'schema_version' => 1]]; return 1; }
        if (str_starts_with($template, 'DELETE')) {
            $before = count($this->rows[$table] ?? []);
            $this->rows[$table] = array_filter($this->rows[$table] ?? [], fn($row) => $row['available_at'] >= $args[0]);
            return $before - count($this->rows[$table]);
        }
        if (str_contains($template, '(bucket,available_at) SELECT')) { $this->rows[$table][$args[0]] = ['bucket' => $args[0], 'available_at' => 0]; return 1; }
        if (str_starts_with($template, 'INSERT INTO')) {
            preg_match('/\(([^)]+)\) SELECT/', $template, $match);
            $row = array_combine(explode(',', $match[1]), array_slice($args, 0, -1));
            if (isset($this->rows[$table][$row['id']])) { $this->last_error = 'duplicate id'; return false; }
            if ($this->truncateNext) { $this->truncateNext = false; $row['text'] = ''; }
            $this->rows[$table][$row['id']] = $row; return 1;
        }
        if (str_starts_with($template, 'UPDATE') && str_contains($template, 'SET text')) {
            $id = $args[3]; $before = $this->rows[$table][$id];
            $this->rows[$table][$id] = array_replace($before, ['text' => $args[0], 'language' => $args[1], 'title' => $args[2]]);
            if ($this->truncateNext) { $this->truncateNext = false; $this->rows[$table][$id]['text'] = ''; }
            return $before === $this->rows[$table][$id] ? 0 : 1;
        }
        if (str_starts_with($template, 'UPDATE') && str_contains($template, 'available_at =')) {
            if ($this->rows[$table][$args[1]]['available_at'] > $args[2]) { return 0; }
            $this->rows[$table][$args[1]]['available_at'] = $args[0]; return 1;
        }
        // Original production limiter uses the unmodified compact SQL form.
        if (str_contains($template, 'INSERT IGNORE') || str_contains($template, 'SET available_at=')) { return 1; }
        throw new RuntimeException('Unrecognized synthetic mutation: ' . $template);
    }
}
