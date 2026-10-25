<?php
namespace Pbin\Preview\Control;
require_once __DIR__ . '/storage.php';
require_once __DIR__ . '/quota-recipe.php';

final class Configuration {
    public Storage $storage;
    public ?string $automationUser;
    public function __construct(bool $enabled, string $environment, string $origin, string $home, string $root, array $publicRoots, ?string $automationUser = null) {
        if (!$enabled || $environment !== 'staging' || !preg_match('~\Ahttps://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\z~', $origin) || rtrim($home, '/') !== $origin) {
            throw new ControlException('Explicit matching HTTPS staging configuration required', 503);
        }
        if ($automationUser !== null && !preg_match('/\A[1-9][0-9]{0,9}\z/', $automationUser)) { throw new ControlException('Invalid approved automation principal', 503); }
        $this->storage = new Storage($root, $publicRoots); $this->automationUser = $automationUser;
    }
    public static function wordpress(bool $management = true): self {
        if ($management && (!defined('PBIN_PREVIEW_CONTROLLER_ENABLED') || PBIN_PREVIEW_CONTROLLER_ENABLED !== true)) { throw new ControlException('Preview management disabled', 503); }
        if (!defined('PBIN_PREVIEW_REGISTRY_BACKEND') || PBIN_PREVIEW_REGISTRY_BACKEND !== 'mysql') { throw new ControlException('MySQL registry must be explicitly selected', 503); }
        $roots = [rtrim(ABSPATH, '/')];
        if (defined('WP_CONTENT_DIR')) { $roots[] = WP_CONTENT_DIR; }
        if (!empty($_SERVER['DOCUMENT_ROOT'])) { $roots[] = $_SERVER['DOCUMENT_ROOT']; }
        return new self(defined('PBIN_PREVIEW_STAGING') && PBIN_PREVIEW_STAGING === true, wp_get_environment_type(),
            defined('PBIN_PREVIEW_STAGING_ORIGIN') ? PBIN_PREVIEW_STAGING_ORIGIN : '', home_url(),
            defined('PBIN_PREVIEW_ROOT') ? PBIN_PREVIEW_ROOT : '', $roots,
            defined('PBIN_PREVIEW_AUTOMATION_USER_ID') ? (string) PBIN_PREVIEW_AUTOMATION_USER_ID : null);
    }
}

/** Testable trusted service. Only the authenticated adapter may invoke mutations. */
final class Controller {
    private object $registry;
    private Storage $storage;
    private string $packages;
    public function __construct(object $registry, Storage $storage, string $packages = NativePackage::class) {
        $this->registry = $registry; $this->storage = $storage; $this->packages = $packages;
    }
    private static function tenantName(string $tenant): void { if (!preg_match('/\Apr-[1-9][0-9]{0,9}\z/', $tenant)) { throw new ControlException('Invalid tenant'); } }
    private static function digest(string $value, int $length): void { if (!preg_match('/\A[a-f0-9]{' . $length . '}\z/', $value)) { throw new ControlException('Invalid revision, digest or token'); } }
    private static function token(?string $token): void { if ($token !== null) { self::digest($token, 64); } }
    public static function envelope(string $tenant, ?array $record): array {
        if ($record !== null) { $record['releases'] = (object) $record['releases']; }
        return ['version' => 2, 'tenant' => $tenant, 'record' => $record];
    }
    public function get(string $tenant): array {
        self::tenantName($tenant); $this->storage->ready();
        return self::envelope($tenant, $this->registry->tenant($tenant));
    }
    public function retire(string $tenant, ?string $token): array {
        self::tenantName($tenant); self::token($token); $this->storage->ready();
        // Retirement does not allocate storage or depend on a stale filesystem
        // lock: a failed/uncertain install must not prevent fencing a closed PR.
        return self::envelope($tenant, $this->registry->retire($tenant, $token));
    }
    private function current(string $tenant, ?string $token): ?array {
        $current = $this->registry->tenant($tenant);
        if (($current['state_token'] ?? null) !== $token) { throw new \Pbin\Preview\RegistryConflict('Tenant state changed'); }
        return $current;
    }
    public function rollback(string $tenant, string $token, string $revision): array {
        self::tenantName($tenant); self::token($token); self::digest($revision, 40);
        return $this->storage->locked(function () use ($tenant, $token, $revision): array {
            $this->registry->assertDataInventory();
            $current = $this->current($tenant, $token);
            if ($current === null || !isset($current['releases'][$revision])) { throw new ControlException('Rollback revision is not retained'); }
            $release = $current['releases'][$revision];
            $this->packages::verifyExisting($this->releasePath($tenant, $revision), $revision, $release['artifact_sha256'], $release['manifest_sha256']);
            QuotaRecipe::verify($this->releasePath($tenant, $revision) . '/pbin');
            $desired = ['enabled' => true, 'active' => $revision, 'releases' => $current['releases']];
            return self::envelope($tenant, $this->registry->compareAndSwap($tenant, $token, $desired));
        });
    }
    private function releasePath(string $tenant, string $revision): string { return $this->storage->root . '/releases/' . $tenant . '/' . $revision; }

    /** $stream is a bounded-read input resource, never an arbitrary client path. */
    public function install(string $tenant, string $revision, string $digest, ?string $token, $stream, ?int $length): array {
        self::tenantName($tenant); self::digest($revision, 40); self::digest($digest, 64); self::token($token);
        if (!is_resource($stream) || ($length !== null && ($length <= 0 || $length > $this->packages::MAX_ARCHIVE_BYTES))) { throw new ControlException('Invalid or oversized archive body', 413); }
        return $this->storage->locked(function () use ($tenant, $revision, $digest, $token, $stream, $length): array {
            $this->registry->assertDataInventory();
            $current = $this->current($tenant, $token);
            $oldRelease = $current['releases'][$revision] ?? null;
            if ($oldRelease !== null && $oldRelease['artifact_sha256'] !== $digest) { throw new ControlException('Immutable release digest differs', 409); }
            if ($oldRelease === null && count($current['releases'] ?? []) >= 3) { throw new ControlException('Retained release bound exceeded', 507); }
            $this->storage->reserve(0, 1);
            $upload = $this->storage->root . '/.uploads/upload-' . bin2hex(random_bytes(16)) . '.zip';
            $file = @fopen($upload, 'xb');
            if ($file === false) { throw new ControlException('Cannot create private upload', 503); }
            chmod($upload, 0600);
            $primaryError = null;
            try {
                $available = Storage::MAX_BYTES - $this->storage->usage()['bytes'];
                $maximum = min($this->packages::MAX_ARCHIVE_BYTES, $available);
                $received = 0; $hash = hash_init('sha256');
                while (!feof($stream)) {
                    $chunk = fread($stream, min(131072, $maximum - $received + 1));
                    if ($chunk === false || ($chunk === '' && !feof($stream))) { throw new ControlException('Archive input failed'); }
                    $received += strlen($chunk);
                    if ($received > $maximum) { throw new ControlException('Upload exceeds package or storage bound', 413); }
                    hash_update($hash, $chunk);
                    if ($chunk !== '' && fwrite($file, $chunk) !== strlen($chunk)) { throw new ControlException('Upload storage failed', 503); }
                }
                if ($received === 0 || ($length !== null && $length !== $received) || !hash_equals($digest, hash_final($hash))) { throw new ControlException('Archive length or checksum mismatch'); }
                if (!fflush($file)) { throw new ControlException('Cannot flush upload', 503); }
                fclose($file); $file = null;
                $this->storage->directory($this->storage->root . '/releases/' . $tenant, true);
                $this->storage->directory($this->storage->root . '/data/' . $tenant, true);
                $destination = $this->releasePath($tenant, $revision);
                if (file_exists($destination) || is_link($destination)) {
                    Storage::canonicalDirectory($destination);
                    $manifest = $destination . '/manifest.json'; $stat = @lstat($manifest);
                    if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1 || $stat['size'] > $this->packages::MAX_MANIFEST) { throw new ControlException('Incomplete or unsafe retained package', 409); }
                    $manifestHash = $oldRelease['manifest_sha256'] ?? hash_file('sha256', $manifest);
                    $verified = $this->packages::verifyExisting($destination, $revision, $digest, $manifestHash);
                    if ($oldRelease === null) { Storage::seal($destination); }
                } else {
                    $slots = 0;
                    $names = @scandir(dirname($destination));
                    if ($names === false) { throw new ControlException('Cannot inspect retained release slots', 503); }
                    foreach ($names as $name) {
                        if (preg_match('/\A[a-f0-9]{40}\z/', $name)) { ++$slots; }
                    }
                    if ($slots >= 3) { throw new ControlException('Retained and orphan release bound exceeded', 507); }
                    // Reserve the verifier's private ZIP snapshot and full hard
                    // expansion/entry bounds before it writes anything else.
                    $this->storage->reserve($received + $this->packages::MAX_EXPANDED_BYTES, 1 + $this->packages::MAX_ENTRIES);
                    $verified = $this->packages::extract($upload, $digest, $revision, $destination);
                    Storage::seal($destination);
                    $verified = $this->packages::verifyExisting($destination, $revision, $digest, $verified['manifest_sha256']);
                }
                QuotaRecipe::verify($destination . '/pbin');
                $this->storage->usage();
                $release = ['artifact_sha256' => $digest, 'manifest_sha256' => $verified['manifest_sha256']];
                $releases = $current['releases'] ?? []; $releases[$revision] = $release;
                return self::envelope($tenant, $this->registry->compareAndSwap($tenant, $token, ['enabled' => true, 'active' => $revision, 'releases' => $releases]));
            } catch (\Throwable $error) { $primaryError = $error; throw $error; }
            finally {
                if (is_resource($file)) { fclose($file); }
                // This exact file was exclusively created by this invocation.
                // No retained release, orphan, or tenant data is removed.
                if (!@unlink($upload) && $primaryError === null) { throw new ControlException('Upload cleanup uncertain; inspect authoritative state', 503); }
            }
        });
    }
}
