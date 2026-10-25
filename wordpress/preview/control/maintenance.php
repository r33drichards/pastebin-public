<?php
namespace Pbin\Preview\Control;
require_once __DIR__ . '/controller.php';

/** Offline administrator API only. No REST routes, hooks or automatic scheduling.
 * Operators must stop ALL writers before recovery and resolve uncertain commits.
 * This does not establish authority or prove multi-instance quiescence itself.
 */
final class Maintenance {
    public const GRACE_SECONDS = 86400;
    private object $registry;
    private Storage $storage;
    private string $packages;
    public function __construct(object $registry, Storage $storage, string $packages = NativePackage::class) {
        $this->registry = $registry; $this->storage = $storage; $this->packages = $packages;
    }
    private function retention(string $tenant, string $token, string $rollback): array {
        if (!preg_match('/\Apr-[1-9][0-9]{0,9}\z/', $tenant) || !preg_match('/\A[a-f0-9]{64}\z/', $token)
            || !preg_match('/\A[a-f0-9]{40}\z/', $rollback)) { throw new ControlException('Invalid retention identity'); }
        $this->registry->assertDataInventory();
        $current = $this->registry->tenant($tenant);
        if (($current['state_token'] ?? null) !== $token) { throw new \Pbin\Preview\RegistryConflict('Retention state changed'); }
        if ($current['active'] === $rollback || !isset($current['releases'][$rollback])) { throw new ControlException('Distinct retained rollback required'); }
        $remove = [];
        foreach ($current['releases'] as $sha => $release) {
            $directory = $this->storage->root . '/releases/' . $tenant . '/' . $sha;
            $this->packages::verifyExisting($directory, $sha, $release['artifact_sha256'], $release['manifest_sha256']);
            if ($sha !== $current['active'] && $sha !== $rollback) { $remove[$sha] = $release + ['inventory' => self::inventory($directory)]; }
        }
        ksort($remove);
        if ($remove === []) { throw new ControlException('No eligible inactive code'); }
        return ['tenant' => $tenant, 'expected_token' => $token, 'active' => $current['active'], 'rollback' => $rollback, 'remove' => $remove];
    }
    /** Server-stored immutable review plan; requires explicit authorized invocation. */
    public function planRetention(string $tenant, string $token, string $rollback): array {
        return $this->storage->locked(function () use ($tenant, $token, $rollback): array {
            $plan = ['version' => 1, 'created_at' => time()] + $this->retention($tenant, $token, $rollback);
            $json = json_encode($plan, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
            if (strlen($json) > Storage::MAX_RETENTION_PLAN) { throw new ControlException('Retention plan exceeds bound', 507); }
            $id = hash('sha256', $json); $path = $this->storage->root . '/.retention-' . $id . '.json';
            $this->storage->reserve(strlen($json), 1);
            $file = @fopen($path, 'xb');
            if ($file === false) { throw new ControlException('Cannot persist retention plan', 503); }
            try { if (fwrite($file, $json) !== strlen($json) || !fflush($file) || !function_exists('fsync') || !fsync($file)) { throw new ControlException('Retention plan write failed', 503); } }
            finally { fclose($file); }
            if (!chmod($path, 0400)) { throw new ControlException('Cannot seal retention plan', 503); }
            $directory = fopen($this->storage->root, 'r');
            if ($directory === false) { throw new ControlException('Cannot sync retention ledger directory', 503); }
            try { if (!fsync($directory)) { throw new ControlException('Cannot sync retention ledger directory', 503); } }
            finally { fclose($directory); }
            return ['plan_id' => $id, 'not_before' => $plan['created_at'] + self::GRACE_SECONDS, 'plan' => $plan];
        });
    }
    /** Explicit approval applies to exact plan ID, not an automatic age-based purge. */
    public function applyRetention(string $id): array {
        if (!preg_match('/\A[a-f0-9]{64}\z/', $id)) { throw new ControlException('Invalid plan identity'); }
        return $this->storage->locked(function () use ($id): array {
            $plan = $this->storage->retentionPlan($id);
            if (!is_array($plan) || ($plan['version'] ?? null) !== 1 || !is_int($plan['created_at'] ?? null)
                || $plan['created_at'] > time() - self::GRACE_SECONDS) { throw new ControlException('Retention asset grace period incomplete'); }
            $current = $this->retention($plan['tenant'], $plan['expected_token'], $plan['rollback']);
            if ($plan !== ['version' => 1, 'created_at' => $plan['created_at']] + $current) { throw new ControlException('Retention plan no longer matches'); }
            // Metadata first: a failed/uncertain commit NEVER deletes code. An
            // interrupted removal leaves only counted unroutable orphan files.
            $record = $this->registry->retainReleases($plan['tenant'], $plan['expected_token'], $plan['rollback']);
            foreach ($plan['remove'] as $sha => $_) { self::removeCode($this->storage->root . '/releases/' . $plan['tenant'] . '/' . $sha); }
            return Controller::envelope($plan['tenant'], $record);
        });
    }
    /** Resume only an explicitly observed post-commit state, never refresh/replay CAS. */
    public function finishRetention(string $id, string $expectedToken): array {
        return $this->storage->locked(function () use ($id, $expectedToken): array {
            $plan = $this->storage->retentionPlan($id);
            if (!is_int($plan['created_at'] ?? null) || $plan['created_at'] > time() - self::GRACE_SECONDS) { throw new ControlException('Retention asset grace period incomplete'); }
            $current = $this->registry->tenant($plan['tenant']);
            if (($current['state_token'] ?? null) !== $expectedToken || $expectedToken === $plan['expected_token']) {
                throw new \Pbin\Preview\RegistryConflict('Observe committed retention state before recovery');
            }
            if ($current['active'] !== $plan['active'] || count($current['releases']) !== 2 || !isset($current['releases'][$plan['rollback']])) {
                throw new ControlException('Retention recovery targets changed');
            }
            foreach ($current['releases'] as $sha => $release) {
                $this->packages::verifyExisting($this->storage->root . '/releases/' . $plan['tenant'] . '/' . $sha, $sha,
                    $release['artifact_sha256'], $release['manifest_sha256']);
            }
            foreach ($plan['remove'] as $sha => $release) {
                if (isset($current['releases'][$sha])) { throw new ControlException('Cannot remove referenced code'); }
                $path = $this->storage->root . '/releases/' . $plan['tenant'] . '/' . $sha;
                if (!file_exists($path) && !is_link($path)) { continue; }
                foreach (self::inventory($path) as $entry => $metadata) {
                    if (($release['inventory'][$entry] ?? null) !== $metadata) { throw new ControlException('Orphan inventory differs from approved plan'); }
                }
                self::removeCode($path);
            }
            return Controller::envelope($plan['tenant'], $current);
        });
    }
    private static function inventory(string $root): array {
        Storage::canonicalDirectory($root); $result = []; $todo = [''];
        while ($todo !== []) {
            $relative = array_pop($todo); $directory = $root . ($relative === '' ? '' : '/' . $relative);
            Storage::canonicalDirectory($directory);
            foreach (scandir($directory) as $name) {
                if ($name === '.' || $name === '..') { continue; }
                $entry = $relative === '' ? $name : $relative . '/' . $name; $path = $root . '/' . $entry; $stat = lstat($path);
                if (count($result) >= NativePackage::MAX_ENTRIES) { throw new ControlException('Code inventory exceeds bound'); }
                if ($stat !== false && ($stat['mode'] & 0170000) === 0040000) { $result[$entry] = ['kind' => 'directory']; $todo[] = $entry; }
                elseif ($stat !== false && ($stat['mode'] & 0170000) === 0100000 && $stat['nlink'] === 1) {
                    $hash = hash_file('sha256', $path);
                    if (!is_string($hash)) { throw new ControlException('Cannot hash code inventory'); }
                    $result[$entry] = ['kind' => 'file', 'bytes' => $stat['size'], 'sha256' => $hash];
                } else { throw new ControlException('Unsafe code inventory'); }
            }
        }
        ksort($result); return $result;
    }
    private static function removeCode(string $directory): void {
        Storage::canonicalDirectory($directory);
        $names = scandir($directory);
        if ($names === false || !chmod($directory, 0700)) { throw new ControlException('Code cleanup incomplete; inspect orphan', 503); }
        foreach ($names as $name) {
            if ($name === '.' || $name === '..') { continue; }
            $path = $directory . '/' . $name; $stat = lstat($path);
            if ($stat !== false && ($stat['mode'] & 0170000) === 0040000) { self::removeCode($path); }
            elseif ($stat !== false && ($stat['mode'] & 0170000) === 0100000 && $stat['nlink'] === 1) {
                if (!unlink($path)) { throw new ControlException('Code cleanup incomplete; inspect orphan', 503); }
            } else { throw new ControlException('Unsafe code cleanup entry', 503); }
        }
        if (!rmdir($directory)) { throw new ControlException('Code cleanup incomplete; inspect orphan', 503); }
    }
    public function recoveryObservation(): array {
        clearstatcache(true);
        $this->storage->ready(); $this->storage->usage();
        $lock = $this->storage->root . '/.controller-lock'; Storage::canonicalDirectory($lock);
        $names = array_values(array_diff(scandir($lock), ['.', '..']));
        if (count($names) !== 1 || !preg_match('/\Aowner-[a-f0-9]{32}\z/', $names[0])) { throw new ControlException('Unsupported lock shape; manual diagnosis required'); }
        $stat = lstat($lock . '/' . $names[0]);
        if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1 || $stat['size'] !== 0) { throw new ControlException('Unsafe lock owner'); }
        $snapshot = $this->registry->snapshot();
        return ['owner' => $names[0], 'registry_sha256' => hash('sha256', json_encode($snapshot, JSON_THROW_ON_ERROR)),
            'lock_device' => lstat($lock)['dev'], 'lock_inode' => lstat($lock)['ino']];
    }
    /** Local operator attestation is mandatory; never infer abandonment from age. */
    public function recoverLock(array $expected, bool $allWritersStopped, bool $commitOutcomeResolved): void {
        if (!$allWritersStopped || !$commitOutcomeResolved) { throw new ControlException('Stop all writers and resolve uncertain commits first'); }
        if ($this->recoveryObservation() !== $expected) { throw new ControlException('Recovery observation changed', 409); }
        $lock = $this->storage->root . '/.controller-lock';
        if (!unlink($lock . '/' . $expected['owner']) || !rmdir($lock)) { throw new ControlException('Recovery incomplete; inspect before retry', 503); }
    }
}
