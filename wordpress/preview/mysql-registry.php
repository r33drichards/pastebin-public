<?php
/**
 * Trusted control-plane storage only. Never load this from a PR archive.
 * No routes, hooks, credentials, file installation or WordPress tenant migration.
 * installSchema() MUST be called only by an authorized administrator/CI migration;
 * reads and CAS never create or repair the table. See mysql-registry.md.
 */
namespace Pbin\Preview;

class RegistryException extends \RuntimeException {}
class RegistryConflict extends RegistryException {}
class RegistryCommitUncertain extends RegistryException {}

final class MysqlRegistry {
    private const VERSION = 2;
    private const MAX_BYTES = 1048576;
    public const MAX_DATA_TENANTS = 2;
    private object $db;
    private string $table;
    private array $limits;

    public function __construct(object $wpdb, array $limits = []) {
        foreach (['query', 'get_results', 'prepare', 'suppress_errors'] as $method) {
            if (!is_callable([$wpdb, $method])) { throw new RegistryException('A working wpdb connection is required'); }
        }
        $prefix = $wpdb->base_prefix ?? null;
        if (!is_string($prefix) || !preg_match('/\A[a-zA-Z0-9_]{1,43}\z/', $prefix)) {
            throw new RegistryException('Invalid trusted WordPress base prefix');
        }
        $this->db = $wpdb;
        $this->table = $prefix . 'pbin_preview_registry';
        $this->limits = ['max_tenants' => 1024, 'max_enabled' => 2, 'max_releases' => 3];
        foreach ($limits as $key => $value) {
            if (!array_key_exists($key, $this->limits) || !is_int($value) || $value < 1 || $value > $this->limits[$key]) {
                throw new RegistryException('Limits must be positive integers no greater than the hard bounds');
            }
            $this->limits[$key] = $value;
        }
    }

    /** Explicit administrative migration. Existing tables are validated, never repaired. */
    public function installSchema(): void {
        $this->quiet(function (): void {
            $this->idleSession(); // Refuse DDL inside a caller-owned transaction.
            if ($this->tableInfo() !== []) { $this->schema(); $this->load(false); return; }
            // Deliberately no IF NOT EXISTS or INSERT IGNORE: competing/partial
            // migrations fail closed instead of adopting or resetting unknown state.
            $this->query("CREATE TABLE `{$this->table}` (singleton_id tinyint unsigned NOT NULL, schema_version smallint unsigned NOT NULL, state_json mediumtext NOT NULL, PRIMARY KEY (singleton_id)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
            $this->query($this->sql("INSERT INTO `{$this->table}` (singleton_id, schema_version, state_json) VALUES (1, 2, %s)", $this->encode(['version' => 2, 'tenants' => []])));
            $this->schema();
            $this->load(false);
        });
    }

    /** Returns the authoritative v2 snapshot, not a registry.json mirror. */
    public function snapshot(): array {
        return $this->quiet(function (): array { $this->schema(); return $this->load(false); });
    }

    public function tenant(string $tenant): ?array {
        $this->tenantName($tenant);
        return $this->snapshot()['tenants'][$tenant] ?? null;
    }

    /** Provisioning/startup preflight, never a migration or adoption. All preview
     * tables in this database must belong to an existing retained reservation.
     * Out-of-band privileged DDL is not a supported alternate provisioner. */
    public function assertDataInventory(): void {
        $this->quiet(function (): void {
            $this->schema();
            $state = $this->load(false);
            $prefix = $this->db->prefix ?? $this->db->base_prefix;
            if (!is_string($prefix) || !preg_match('/\A[a-zA-Z0-9_]{1,43}\z/', $prefix)) { throw new RegistryException('Invalid data inventory prefix'); }
            $tables = $this->rows("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOCATE('pbin_pr_', TABLE_NAME) > 0");
            foreach ($tables as $table) {
                $name = $table['TABLE_NAME'] ?? null;
                if (!is_string($name) || !preg_match('/\A' . preg_quote($prefix, '/') . 'pbin_pr_([1-9][0-9]{0,9})_(?:pastes|diffs|snapshots|limits|quota)\z/', $name, $match)
                    || empty($state['tenants']['pr-' . $match[1]]['releases'])) {
                    throw new RegistryException('Unregistered or unsupported preview data tables; explicit inventory resolution required');
                }
            }
        });
    }

    /**
     * $desired has exactly enabled, active, releases; token is generated here.
     * Caller must already have validated provenance and completed immutable file
     * publication/storage admission. This method does not prove either of them.
     */
    public function compareAndSwap(string $tenant, ?string $expectedToken, array $desired): array {
        return $this->mutate($tenant, $expectedToken, $desired);
    }

    /** Retains releases/data; an absent tenant becomes a non-empty-token tombstone. */
    public function retire(string $tenant, ?string $expectedToken): array {
        return $this->mutate($tenant, $expectedToken, null);
    }

    private function mutate(string $tenant, ?string $expectedToken, ?array $desired): array {
        $this->tenantName($tenant);
        if ($expectedToken !== null) { $this->hex($expectedToken, 64); }
        return $this->quiet(function () use ($tenant, $expectedToken, $desired): array {
            $this->schema();
            $connection = $this->idleSession();
            $started = false;
            $committing = false;
            try {
                $this->query('START TRANSACTION');
                $started = true;
                $state = $this->load(true, $connection);
                $this->schema(); // Recheck under the table metadata lock, excluding concurrent DDL.
                $old = $state['tenants'][$tenant] ?? null;
                // CAS precedes even exact no-op detection. Null means absence only.
                if (($old['state_token'] ?? null) !== $expectedToken) {
                    throw new RegistryConflict('Tenant state changed; re-read before deciding whether to retry');
                }
                if ($desired === null) {
                    $desired = $old === null ? ['enabled' => false, 'active' => null, 'releases' => []]
                        : ['enabled' => false, 'active' => $old['active'], 'releases' => $old['releases']];
                }
                $this->keys($desired, ['enabled', 'active', 'releases']);
                $candidate = $this->record(['state_token' => $old['state_token'] ?? str_repeat('0', 64)] + $desired);
                foreach ($old['releases'] ?? [] as $sha => $release) {
                    if (($candidate['releases'][$sha] ?? null) !== $release) {
                        throw new RegistryException('Retained immutable releases cannot be removed or changed');
                    }
                }
                if ($old !== $candidate) {
                    do { $candidate['state_token'] = bin2hex(random_bytes(32)); }
                    while ($old !== null && $candidate['state_token'] === $old['state_token']);
                    $state['tenants'][$tenant] = $candidate;
                    $encoded = $this->encode($state);
                    // wpdb may reconnect/replay a query. A new connection must
                    // never mutate outside the transaction that held this lock.
                    $changed = $this->query($this->sql("UPDATE `{$this->table}` SET state_json = %s WHERE singleton_id = 1 AND schema_version = 2 AND CONNECTION_ID() = %s", $encoded, $connection));
                    if ($changed !== 1) { throw new RegistryException('Registry update lost its transaction or singleton'); }
                }
                $committing = true;
                $this->query('COMMIT');
                $started = false;
                if ($this->connection() !== $connection) {
                    throw new RegistryCommitUncertain('Commit connection changed; re-read authoritative state before retrying');
                }
                return $candidate;
            } catch (\Throwable $error) {
                if ($started) { try { $this->query('ROLLBACK'); } catch (\Throwable $ignored) {} }
                if ($committing && !($error instanceof RegistryCommitUncertain)) {
                    throw new RegistryCommitUncertain('Commit outcome is unknown; re-read authoritative state before retrying', 0, $error);
                }
                throw $error;
            }
        });
    }

    private function quiet(callable $action) {
        $previous = $this->db->suppress_errors(true);
        try { return $action(); }
        finally { $this->db->suppress_errors($previous); }
    }

    private function sql(string $sql, ...$args): string {
        $prepared = $this->db->prepare($sql, ...$args);
        if (!is_string($prepared) || $prepared === '') { throw new RegistryException('Cannot prepare registry query'); }
        return $prepared;
    }

    private function query(string $sql): int {
        $result = $this->db->query($sql);
        if ($result === false || ($this->db->last_error ?? '') !== '') { throw new RegistryException('Registry database operation failed'); }
        return (int) $result;
    }

    private function rows(string $sql): array {
        $rows = $this->db->get_results($sql, 'ARRAY_A');
        if (!is_array($rows) || ($this->db->last_error ?? '') !== '') { throw new RegistryException('Registry database read failed'); }
        return $rows;
    }

    private function connection(): string {
        $rows = $this->rows('SELECT CONNECTION_ID() AS connection_id, @@session.autocommit AS autocommit');
        if (count($rows) !== 1 || !preg_match('/\A[1-9][0-9]*\z/', (string) ($rows[0]['connection_id'] ?? '')) || (string) ($rows[0]['autocommit'] ?? '') !== '1') {
            throw new RegistryException('Registry requires a dedicated autocommit connection');
        }
        return (string) $rows[0]['connection_id'];
    }

    private function idleSession(): string {
        $connection = $this->connection();
        // MySQL rejects SET TRANSACTION within an already active transaction.
        // Do not START TRANSACTION over one: that would implicitly commit it.
        $this->query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        return $connection;
    }

    private function tableInfo(): array {
        return $this->rows($this->sql('SELECT ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s', $this->table));
    }

    private function schema(): void {
        $info = $this->tableInfo();
        if (count($info) !== 1 || ($info[0]['ENGINE'] ?? null) !== 'InnoDB' || ($info[0]['TABLE_COLLATION'] ?? null) !== 'utf8mb4_bin') {
            throw new RegistryException('Missing or unsupported InnoDB registry table; run the explicit trusted migration');
        }
        $columns = $this->rows("SHOW COLUMNS FROM `{$this->table}`");
        $expected = ['singleton_id' => ['tinyint unsigned', 'PRI'], 'schema_version' => ['smallint unsigned', ''], 'state_json' => ['mediumtext', '']];
        if (count($columns) !== count($expected)) { throw new RegistryException('Unsupported registry table schema'); }
        foreach ($columns as $column) {
            $shape = $expected[$column['Field'] ?? ''] ?? null;
            if ($shape === null || ($column['Type'] ?? null) !== $shape[0] || ($column['Key'] ?? null) !== $shape[1]
                || ($column['Null'] ?? null) !== 'NO' || ($column['Extra'] ?? null) !== '' || ($column['Default'] ?? null) !== null) {
                throw new RegistryException('Unsupported registry table schema');
            }
            unset($expected[$column['Field']]);
        }
    }

    private function load(bool $locked, ?string $connection = null): array {
        $rows = $this->rows("SELECT singleton_id, schema_version, OCTET_LENGTH(state_json) AS state_bytes, CASE WHEN OCTET_LENGTH(state_json) <= 1048576 THEN state_json ELSE NULL END AS state_json, CONNECTION_ID() AS connection_id FROM `{$this->table}` LIMIT 2" . ($locked ? ' FOR UPDATE' : ''));
        if (count($rows) !== 1 || (string) ($rows[0]['singleton_id'] ?? '') !== '1' || (string) ($rows[0]['schema_version'] ?? '') !== '2'
            || ($connection !== null && (string) ($rows[0]['connection_id'] ?? '') !== $connection)) {
            throw new RegistryException('Missing, unsupported or unlocked registry singleton');
        }
        $json = $rows[0]['state_json'] ?? null;
        if (!is_string($json) || strlen($json) > self::MAX_BYTES || (string) strlen($json) !== (string) ($rows[0]['state_bytes'] ?? '')) {
            throw new RegistryException('Registry exceeds size limit or is corrupt');
        }
        try { $decoded = json_decode($json, false, 16, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { throw new RegistryException('Corrupt registry JSON', 0, $error); }
        if (!($decoded instanceof \stdClass) || !isset($decoded->tenants) || !($decoded->tenants instanceof \stdClass)) {
            throw new RegistryException('Invalid registry object');
        }
        $state = (array) $decoded;
        $state['tenants'] = [];
        foreach ((array) $decoded->tenants as $tenant => $record) {
            if (!($record instanceof \stdClass) || !isset($record->releases) || !($record->releases instanceof \stdClass)) {
                throw new RegistryException('Invalid tenant object');
            }
            $entry = (array) $record;
            $entry['releases'] = [];
            foreach ((array) $record->releases as $sha => $release) {
                if (!($release instanceof \stdClass)) { throw new RegistryException('Invalid release object'); }
                $entry['releases'][$sha] = (array) $release;
            }
            $state['tenants'][$tenant] = $entry;
        }
        // Only our canonical bytes are valid: catches duplicate JSON keys too.
        if ($this->encode($state) !== $json) { throw new RegistryException('Non-canonical or corrupt registry JSON'); }
        return $state;
    }

    private function encode(array $state): string {
        $this->keys($state, ['version', 'tenants']);
        if ($state['version'] !== self::VERSION || !is_array($state['tenants']) || count($state['tenants']) > $this->limits['max_tenants']) {
            throw new RegistryException('Unsupported registry version or tenant bound');
        }
        $tenants = [];
        $enabled = 0;
        $dataTenants = 0;
        foreach ($state['tenants'] as $tenant => $record) {
            $this->tenantName($tenant);
            if (!is_array($record)) { throw new RegistryException('Invalid tenant record'); }
            $entry = $this->record($record);
            $enabled += $entry['enabled'] ? 1 : 0;
            $dataTenants += $entry['releases'] !== [] ? 1 : 0;
            $entry['releases'] = (object) $entry['releases'];
            $tenants[$tenant] = $entry;
        }
        if ($dataTenants > self::MAX_DATA_TENANTS) { throw new RegistryException('Retained data tenant bound exceeded'); }
        if ($enabled > $this->limits['max_enabled']) { throw new RegistryException('Enabled tenant bound exceeded'); }
        ksort($tenants, SORT_STRING);
        $json = json_encode(['version' => self::VERSION, 'tenants' => (object) $tenants], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        if (strlen($json) > self::MAX_BYTES) { throw new RegistryException('Registry exceeds size limit'); }
        return $json;
    }

    private function record(array $record): array {
        $this->keys($record, ['state_token', 'enabled', 'active', 'releases']);
        $this->hex($record['state_token'], 64);
        if (!is_bool($record['enabled']) || !is_array($record['releases']) || count($record['releases']) > $this->limits['max_releases']) {
            throw new RegistryException('Invalid tenant state or release bound');
        }
        $releases = [];
        foreach ($record['releases'] as $sha => $release) {
            $this->hex($sha, 40);
            if (!is_array($release)) { throw new RegistryException('Invalid release metadata'); }
            $this->keys($release, ['artifact_sha256', 'manifest_sha256']);
            $this->hex($release['artifact_sha256'], 64);
            $this->hex($release['manifest_sha256'], 64);
            $releases[$sha] = ['artifact_sha256' => $release['artifact_sha256'], 'manifest_sha256' => $release['manifest_sha256']];
        }
        if ($record['active'] === null) {
            if ($record['enabled'] || $releases !== []) { throw new RegistryException('Null active is reserved for an empty disabled tombstone'); }
        } else {
            $this->hex($record['active'], 40);
            if (!isset($releases[$record['active']])) { throw new RegistryException('Active revision is not registered'); }
        }
        ksort($releases, SORT_STRING);
        return ['state_token' => $record['state_token'], 'enabled' => $record['enabled'], 'active' => $record['active'], 'releases' => $releases];
    }

    private function keys(array $value, array $expected): void {
        $keys = array_keys($value); sort($keys); sort($expected);
        if ($keys !== $expected) { throw new RegistryException('Unsupported registry fields'); }
    }

    private function tenantName($tenant): void {
        if (!is_string($tenant) || !preg_match('/\Apr-[1-9][0-9]{0,9}\z/', $tenant)) { throw new RegistryException('Invalid tenant name'); }
    }

    private function hex($value, int $length): void {
        if (!is_string($value) || !preg_match('/\A[a-f0-9]{' . $length . '}\z/', $value)) { throw new RegistryException('Invalid digest or state token'); }
    }
}
