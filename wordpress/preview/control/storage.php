<?php
namespace Pbin\Preview\Control;

class ControlException extends \RuntimeException {
    public int $status;
    public function __construct(string $message, int $status = 400) { parent::__construct($message); $this->status = $status; }
}

/** Private RWX storage. Never uses flock, replaces a release, or expires a lock. */
final class Storage {
    public const MAX_BYTES = 268435456;
    public const MAX_ENTRIES = 65536;
    public string $root;

    public function __construct(string $root, array $publicRoots) {
        self::canonicalDirectory($root);
        if (($root === '/') || ((fileperms($root) & 0077) !== 0)) { throw new ControlException('Preview root must be private', 503); }
        foreach ($publicRoots as $public) {
            $canonical = realpath($public);
            if (!is_string($canonical) || $canonical === '' || self::within($root, $canonical) || self::within($canonical, $root)) {
                throw new ControlException('Preview root must be separate from all WordPress/document roots', 503);
            }
        }
        $this->root = $root;
    }

    private static function within(string $path, string $base): bool { return $path === $base || str_starts_with($path, rtrim($base, '/') . '/'); }

    public static function canonicalDirectory(string $path): void {
        if ($path === '' || $path[0] !== '/' || realpath($path) !== $path || !is_dir($path)) { throw new ControlException('Noncanonical preview directory', 503); }
        for ($part = $path; $part !== '/'; $part = dirname($part)) {
            $stat = @lstat($part);
            if ($stat === false || ($stat['mode'] & 0170000) !== 0040000 || is_link($part)) { throw new ControlException('Unsafe preview directory', 503); }
        }
    }

    /** Explicit setup only; never called from a read or normal request. */
    public function initialize(): void {
        foreach (['releases', 'data', '.uploads'] as $name) { $this->directory($this->root . '/' . $name, true); }
        $this->usage();
    }

    public function ready(): void {
        self::canonicalDirectory($this->root);
        foreach (['releases', 'data', '.uploads'] as $name) { $this->directory($this->root . '/' . $name, false); }
    }

    public function directory(string $path, bool $create): void {
        if (!self::within($path, $this->root) || $path === $this->root) { throw new ControlException('Invalid storage destination'); }
        if (!file_exists($path) && !is_link($path) && $create) {
            $this->reserve(0, 1);
            if (!mkdir($path, 0700)) { throw new ControlException('Cannot create private directory', 503); }
        }
        self::canonicalDirectory($path);
    }

    /** Include every pending upload, partial release, orphan and data byte/entry. */
    public function usage(): array {
        $bytes = 0; $entries = 1; $todo = [$this->root];
        while ($todo !== []) {
            $directory = array_pop($todo); self::canonicalDirectory($directory);
            $names = @scandir($directory);
            if ($names === false) { throw new ControlException('Cannot inspect storage', 503); }
            foreach ($names as $name) {
                if ($name === '.' || $name === '..') { continue; }
                if (++$entries > self::MAX_ENTRIES) { throw new ControlException('Storage entry bound exceeded', 507); }
                $path = $directory . '/' . $name; $stat = @lstat($path);
                if ($stat === false) { throw new ControlException('Storage changed during inspection', 503); }
                $kind = $stat['mode'] & 0170000;
                if ($kind === 0040000) { $todo[] = $path; }
                elseif ($kind === 0100000 && $stat['nlink'] === 1 && $stat['size'] >= 0) { $bytes += $stat['size']; }
                else { throw new ControlException('Storage contains an unsafe entry', 503); }
                if ($bytes > self::MAX_BYTES) { throw new ControlException('Storage byte bound exceeded', 507); }
            }
        }
        return ['bytes' => $bytes, 'entries' => $entries];
    }

    public function reserve(int $bytes, int $entries): void {
        $used = $this->usage();
        if ($bytes < 0 || $entries < 0 || $bytes > self::MAX_BYTES - $used['bytes'] || $entries > self::MAX_ENTRIES - $used['entries']) {
            throw new ControlException('Insufficient bounded preview storage; no retained data was removed', 507);
        }
    }

    /** Atomic mkdir on the shared volume, with no stale/age-based lock stealing. */
    public function locked(callable $operation) {
        $this->ready();
        $this->reserve(0, 2);
        $lock = $this->root . '/.controller-lock';
        if (!@mkdir($lock, 0700)) { throw new ControlException('Preview storage busy or awaiting administrator recovery', 409); }
        $owner = $lock . '/owner-' . bin2hex(random_bytes(16));
        $handle = @fopen($owner, 'xb');
        if ($handle === false) { throw new ControlException('Cannot establish storage lock ownership; administrator recovery required', 503); }
        fclose($handle); $release = true;
        try { return $operation(); }
        catch (\Pbin\Preview\RegistryCommitUncertain $error) { $release = false; throw $error; }
        finally {
            if ($release) {
                self::canonicalDirectory($lock);
                $stat = @lstat($owner);
                if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1 || !unlink($owner) || !rmdir($lock)) {
                    throw new ControlException('Storage lock cleanup uncertain; inspect state before retrying', 503);
                }
            }
        }
    }

    /** Only seals a fully verified, server-derived release tree (new or adopted orphan). */
    public static function seal(string $directory): void {
        self::canonicalDirectory($directory);
        $names = @scandir($directory);
        if ($names === false) { throw new ControlException('Cannot inspect package while sealing', 503); }
        foreach ($names as $name) {
            if ($name === '.' || $name === '..') { continue; }
            $path = $directory . '/' . $name; $stat = @lstat($path);
            if ($stat === false) { throw new ControlException('Package changed while sealing', 503); }
            if (($stat['mode'] & 0170000) === 0040000) { self::seal($path); }
            elseif (($stat['mode'] & 0170000) === 0100000 && $stat['nlink'] === 1) {
                if (!chmod($path, 0444)) { throw new ControlException('Cannot seal package file', 503); }
            } else { throw new ControlException('Unsafe package entry', 503); }
        }
        if (!chmod($directory, 0555)) { throw new ControlException('Cannot seal package directory', 503); }
    }
}
