<?php
declare(strict_types=1);
namespace Pbin\Preview\Control;

use RuntimeException;
use stdClass;
use Throwable;
use ZipArchive;

final class PackageException extends RuntimeException {}

/**
 * Admission for package.py's deterministic STORED ZIP format, not generic ZIPs.
 * Caller must provide private storage: this library cannot enforce HTTP routing.
 * No package PHP is executed. This is not a sandbox against trusted runtime PHP.
 */
final class NativePackage {
    public const MAX_ARCHIVE = 67108864;
    public const MAX_EXPANDED = 67108864;
    public const MAX_FILE = 33554432;
    public const MAX_MANIFEST = 1048576;
    public const MAX_FILES = 8192;
    public const MAX_ENTRIES = 16384;
    public const MAX_ARCHIVE_BYTES = self::MAX_ARCHIVE;
    public const MAX_EXPANDED_BYTES = self::MAX_EXPANDED;
    private const CHUNK = 131072;
    private const BLOCKED = ['mu-plugins', 'preview', 'releases', '.git', '.github',
        'registry.json', '.registry.lock', 'wp-config.php', '.htaccess', '.user.ini', 'php.ini'];

    public static function extract(string $archivePath, string $artifactSha256,
                                   string $revision, string $destination): array {
        self::digest($artifactSha256);
        self::revision($revision);
        if (!class_exists(ZipArchive::class) || !method_exists(ZipArchive::class, 'getStreamIndex')
            || !method_exists(ZipArchive::class, 'getExternalAttributesIndex')) {
            throw new PackageException('Required native ZIP capabilities are unavailable');
        }
        self::newDestination($destination);
        self::regularFile($archivePath, self::MAX_ARCHIVE);
        $snapshot = dirname($destination) . '/.pbin-archive-' . bin2hex(random_bytes(16));
        $zip = new ZipArchive();
        $opened = false;
        $created = false;
        $snapshotOwned = false;
        try {
            $input = self::openRegular($archivePath, self::MAX_ARCHIVE);
            $copy = @fopen($snapshot, 'x+b');
            if ($copy === false) { fclose($input); throw new PackageException('Cannot create private archive snapshot'); }
            $snapshotOwned = true;
            try {
                if (!chmod($snapshot, 0600)) { throw new PackageException('Cannot protect archive snapshot'); }
                [$digest] = self::copyBounded($input, self::MAX_ARCHIVE, $copy);
                self::sync($copy);
            } finally { fclose($input); fclose($copy); }
            if (!hash_equals($artifactSha256, $digest)) { throw new PackageException('Artifact SHA-256 mismatch'); }
            if ($zip->open($snapshot, ZipArchive::RDONLY | ZipArchive::CHECKCONS) !== true) {
                throw new PackageException('Invalid or inconsistent ZIP archive');
            }
            $opened = true;
            $entries = self::zipInventory($zip);
            if (!isset($entries['manifest.json'])) { throw new PackageException('Missing manifest'); }
            $manifestStream = self::zipStream($zip, $entries['manifest.json']['index']);
            try { $manifestBytes = self::readSmall($manifestStream, self::MAX_MANIFEST); }
            finally { fclose($manifestStream); }
            $manifest = self::manifest($manifestBytes, $revision);
            self::matchInventory($manifest, $entries);
            // No output directory exists before archive identity and all metadata pass.
            self::newDestination($destination);
            if (!@mkdir($destination, 0700)) { throw new PackageException('Destination already exists or cannot be created'); }
            $created = true;
            self::directory($destination);
            $report = self::verifyStreams($manifestBytes, $manifest, $artifactSha256,
                static fn(string $name) => self::zipStream($zip, $entries[$name]['index']),
                $destination, $entries);
            return self::report($report, $destination);
        } catch (Throwable $error) {
            if ($created) { self::removeOwnedDirectory($destination); }
            throw $error;
        } finally {
            if ($opened) { $zip->close(); }
            if ($snapshotOwned) { @unlink($snapshot); }
        }
    }

    /** Verify a retained immutable tree, including reconstruction of its ZIP identity. */
    public static function verifyExisting(string $directory, string $revision,
                                          string $artifactSha256, string $manifestSha256): array {
        self::revision($revision);
        self::digest($artifactSha256);
        self::digest($manifestSha256);
        self::directory($directory);
        $stream = self::openRegular($directory . '/manifest.json', self::MAX_MANIFEST);
        try { $manifestBytes = self::readSmall($stream, self::MAX_MANIFEST); }
        finally { fclose($stream); }
        if (!hash_equals($manifestSha256, hash('sha256', $manifestBytes))) {
            throw new PackageException('Retained manifest checksum mismatch');
        }
        $manifest = self::manifest($manifestBytes, $revision);
        $actual = [];
        $entryCount = 1;
        self::walk($directory, '', $actual, $entryCount);
        self::matchInventory($manifest, $actual);
        if ($entryCount !== self::entryCount(array_keys($actual))) {
            throw new PackageException('Unexpected retained directories');
        }
        $report = self::verifyStreams($manifestBytes, $manifest, $artifactSha256,
            static fn(string $name) => self::openRegular($directory . '/' . $name,
                $name === 'manifest.json' ? self::MAX_MANIFEST : self::MAX_FILE));
        return self::report($report, $directory);
    }

    /** Exposed for contract tests; strict canonical JSON also rejects duplicate keys. */
    public static function manifest(string $bytes, string $revision): stdClass {
        self::revision($revision);
        if (strlen($bytes) > self::MAX_MANIFEST) { throw new PackageException('Manifest exceeds size limit'); }
        try { $value = json_decode($bytes, false, 32, JSON_THROW_ON_ERROR); }
        catch (Throwable $error) { throw new PackageException('Invalid manifest JSON', 0, $error); }
        self::fields($value, ['files', 'revision', 'version']);
        if ($value->version !== 1 || $value->revision !== $revision || !($value->files instanceof stdClass)) {
            throw new PackageException('Unsupported manifest or revision mismatch');
        }
        $files = get_object_vars($value->files);
        if (count($files) > self::MAX_FILES || !isset($files['pbin/pbin.php'], $files['pbin/runtime.php'])) {
            throw new PackageException('Missing entrypoints or excessive file count');
        }
        $names = [];
        $total = strlen($bytes);
        foreach ($files as $name => $record) {
            self::path($name);
            if ($name === 'manifest.json') { throw new PackageException('Reserved manifest payload path'); }
            self::fields($record, ['sha256', 'size']);
            self::digestValue($record->sha256);
            self::size($record->size, self::MAX_FILE);
            self::addBounded($total, $record->size, self::MAX_EXPANDED);
            self::addName($names, $name);
        }
        self::conflicts($names);
        self::entryCount(array_merge(['manifest.json'], array_keys($files)));
        if (self::canonical($value) . "\n" !== $bytes) {
            throw new PackageException('Manifest must be exact canonical JSON without duplicate keys');
        }
        return $value;
    }

    private static function zipInventory(ZipArchive $zip): array {
        if ($zip->numFiles < 1 || $zip->numFiles > self::MAX_FILES + 1) { throw new PackageException('Invalid archive file count'); }
        $entries = [];
        $folded = [];
        $total = 0;
        for ($index = 0; $index < $zip->numFiles; $index++) {
            $name = $zip->getNameIndex($index, ZipArchive::FL_ENC_RAW);
            if (!is_string($name)) { throw new PackageException('Invalid raw ZIP filename'); }
            self::path($name);
            self::addName($folded, $name);
            $stat = $zip->statIndex($index, ZipArchive::FL_UNCHANGED);
            $opsys = $attributes = 0;
            if (!is_array($stat) || ($stat['name'] ?? null) !== $name
                || !$zip->getExternalAttributesIndex($index, $opsys, $attributes, ZipArchive::FL_UNCHANGED)
                || $opsys !== ZipArchive::OPSYS_UNIX || pack('V', $attributes) !== hex2bin('0000a481')) {
                throw new PackageException('Only exact regular-file ZIP metadata is allowed');
            }
            $maximum = $name === 'manifest.json' ? self::MAX_MANIFEST : self::MAX_FILE;
            self::size($stat['size'] ?? null, $maximum);
            self::size($stat['comp_size'] ?? null, $maximum);
            if (($stat['comp_method'] ?? null) !== ZipArchive::CM_STORE
                || $stat['comp_size'] !== $stat['size']
                || !array_key_exists('encryption_method', $stat) || $stat['encryption_method'] !== ZipArchive::EM_NONE
                || !is_int($stat['crc'] ?? null)) {
                throw new PackageException('Only unencrypted STORED entries are allowed');
            }
            self::addBounded($total, $stat['size'], self::MAX_EXPANDED);
            $entries[$name] = ['index' => $index, 'size' => $stat['size'], 'crc' => $stat['crc']];
        }
        self::conflicts($folded);
        return $entries;
    }

    private static function matchInventory(stdClass $manifest, array $entries): void {
        $expected = array_merge(['manifest.json'], array_keys(get_object_vars($manifest->files)));
        $actual = array_keys($entries);
        sort($expected, SORT_STRING); sort($actual, SORT_STRING);
        if ($expected !== $actual) { throw new PackageException('Manifest and actual inventory disagree'); }
        foreach (get_object_vars($manifest->files) as $name => $record) {
            if ($entries[$name]['size'] !== $record->size) { throw new PackageException('File size disagrees with manifest'); }
        }
    }

    /**
     * Re-hash the exact canonical ZIP using native-decoded entry bytes. A match
     * proves fixed headers/flags/order/offsets and no extras, descriptors or junk,
     * without implementing a second binary ZIP parser. All arithmetic is <2^31.
     */
    private static function verifyStreams(string $manifestBytes, stdClass $manifest, string $artifactSha256,
                                          callable $open, ?string $destination = null, ?array $zipEntries = null): array {
        $files = get_object_vars($manifest->files);
        ksort($files, SORT_STRING);
        $records = ['manifest.json' => (object) ['size' => strlen($manifestBytes), 'sha256' => hash('sha256', $manifestBytes)]] + $files;
        $archiveHash = hash_init('sha256');
        $central = [];
        $offset = $expanded = 0;
        foreach ($records as $name => $record) {
            // CRC must precede bytes in a local header. ZIP supplies it; retained
            // files get a bounded read-only first pass, never trusted metadata.
            if ($zipEntries !== null) { $crc = pack('V', $zipEntries[$name]['crc']); }
            else {
                $source = $open($name);
                try { [, , $crc] = self::copyBounded($source, $record->size); }
                finally { fclose($source); }
            }
            $local = "PK\x03\x04" . pack('vvvvv', 20, 0, 0, 0, 33) . $crc
                . pack('VVvv', $record->size, $record->size, strlen($name), 0) . $name;
            hash_update($archiveHash, $local);
            $central[] = "PK\x01\x02" . pack('vvvvvv', 788, 20, 0, 0, 0, 33) . $crc
                . pack('VVvvvvv', $record->size, $record->size, strlen($name), 0, 0, 0, 0)
                . hex2bin('0000a481') . pack('V', $offset) . $name;
            self::addBounded($offset, strlen($local), self::MAX_ARCHIVE);
            self::addBounded($offset, $record->size, self::MAX_ARCHIVE);
            $output = null;
            $source = $open($name);
            try {
                if ($destination !== null) {
                    self::makeParents($destination, $name);
                    $output = @fopen($destination . '/' . $name, 'x+b');
                    if ($output === false) { throw new PackageException('Cannot exclusively create payload file'); }
                    if (!chmod($destination . '/' . $name, 0600)) { throw new PackageException('Cannot protect payload file'); }
                }
                [$digest, $size, $actualCrc] = self::copyBounded($source, $record->size, $output, $archiveHash);
                if ($size !== $record->size || !hash_equals($record->sha256, $digest) || $actualCrc !== $crc) {
                    throw new PackageException('Payload length, checksum or CRC mismatch');
                }
                if (is_resource($output)) { self::sync($output); }
            } finally { fclose($source); if (is_resource($output)) { fclose($output); } }
            self::addBounded($expanded, $size, self::MAX_EXPANDED);
        }
        $centralOffset = $offset;
        foreach ($central as $bytes) { hash_update($archiveHash, $bytes); self::addBounded($offset, strlen($bytes), self::MAX_ARCHIVE); }
        $end = "PK\x05\x06" . pack('vvvvVVv', 0, 0, count($records), count($records), $offset - $centralOffset, $centralOffset, 0);
        self::addBounded($offset, strlen($end), self::MAX_ARCHIVE);
        hash_update($archiveHash, $end);
        if (!hash_equals($artifactSha256, hash_final($archiveHash))) {
            throw new PackageException('Archive is not the exact canonical STORED package');
        }
        return ['revision' => $manifest->revision, 'artifact_sha256' => $artifactSha256,
            'manifest_sha256' => hash('sha256', $manifestBytes), 'file_count' => count($files),
            'uncompressed_bytes' => $expanded, 'entry_count' => self::entryCount(array_keys($records))];
    }

    private static function report(array $report, string $directory): array {
        return $report + ['directory' => $directory, 'plugin_dir' => $directory . '/pbin'];
    }
    private static function zipStream(ZipArchive $zip, int $index) {
        $stream = $zip->getStreamIndex($index, ZipArchive::FL_UNCHANGED);
        if (!is_resource($stream)) { throw new PackageException('Cannot read ZIP entry'); }
        return $stream;
    }
    private static function copyBounded($input, int $maximum, $output = null, $archiveHash = null): array {
        $hash = hash_init('sha256'); $crc = hash_init('crc32b'); $size = 0;
        while (!feof($input)) {
            $bytes = fread($input, min(self::CHUNK, $maximum - $size + 1));
            if ($bytes === false || ($bytes === '' && !feof($input))) { throw new PackageException('Payload read failed'); }
            self::addBounded($size, strlen($bytes), $maximum);
            hash_update($hash, $bytes); hash_update($crc, $bytes);
            if ($archiveHash !== null) { hash_update($archiveHash, $bytes); }
            if (is_resource($output)) {
                $position = 0;
                while ($position < strlen($bytes)) {
                    $written = fwrite($output, substr($bytes, $position));
                    if ($written === false || $written === 0) { throw new PackageException('Payload write failed'); }
                    $position += $written;
                }
            }
        }
        return [hash_final($hash), $size, strrev(hash_final($crc, true))];
    }
    private static function readSmall($stream, int $maximum): string {
        $bytes = stream_get_contents($stream, $maximum + 1);
        if (!is_string($bytes) || strlen($bytes) > $maximum || !feof($stream)) { throw new PackageException('Invalid bounded metadata read'); }
        return $bytes;
    }
    private static function sync($stream): void {
        if (!fflush($stream) || !function_exists('fsync') || !fsync($stream)) { throw new PackageException('File durability operation failed'); }
    }
    private static function fields($value, array $expected): void {
        if (!($value instanceof stdClass)) { throw new PackageException('Manifest object expected'); }
        $keys = array_keys(get_object_vars($value)); sort($keys, SORT_STRING);
        if ($keys !== $expected) { throw new PackageException('Unexpected manifest fields'); }
    }
    private static function canonical($value): string {
        if ($value instanceof stdClass) {
            $properties = get_object_vars($value); ksort($properties, SORT_STRING); $pieces = [];
            foreach ($properties as $key => $child) { $pieces[] = json_encode($key, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . ':' . self::canonical($child); }
            return '{' . implode(',', $pieces) . '}';
        }
        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }
    private static function path(string $name): void {
        if (strlen($name) > 1024) { throw new PackageException('Package path too long'); }
        $parts = explode('/', $name);
        if (count($parts) > 20) { throw new PackageException('Package path too deep'); }
        foreach ($parts as $part) {
            if ($part === '.' || $part === '..' || strlen($part) > 255 || !preg_match('/^[A-Za-z0-9_.-]+$/D', $part)) {
                throw new PackageException('Unsafe package path');
            }
        }
        if ($name === 'manifest.json') { return; }
        if (count($parts) < 2 || $parts[0] !== 'pbin') { throw new PackageException('Payload must remain under pbin'); }
        foreach (array_slice($parts, 1) as $part) {
            if (in_array(strtolower($part), self::BLOCKED, true)) { throw new PackageException('Control-plane payload forbidden'); }
        }
    }
    private static function addName(array &$names, string $name): void {
        $folded = strtolower($name);
        if (isset($names[$folded])) { throw new PackageException('Duplicate or case-colliding filename'); }
        $names[$folded] = true;
    }
    private static function conflicts(array $names): void {
        foreach ($names as $name => $_) {
            while (str_contains($name, '/')) {
                $name = substr($name, 0, (int) strrpos($name, '/'));
                if (isset($names[$name])) { throw new PackageException('File and directory conflict'); }
            }
        }
    }
    private static function entryCount(array $files): int {
        $directories = [];
        foreach ($files as $name) {
            while (str_contains($name, '/')) {
                $name = substr($name, 0, (int) strrpos($name, '/'));
                $directories[$name] = true;
                if (count($files) + count($directories) + 1 > self::MAX_ENTRIES) {
                    throw new PackageException('Extracted entry count exceeds limit');
                }
            }
        }
        return count($files) + count($directories) + 1;
    }
    private static function revision(string $value): void {
        if (!preg_match('/^[a-f0-9]{40}$/D', $value)) { throw new PackageException('Full lowercase revision SHA required'); }
    }
    private static function digest(string $value): void { self::digestValue($value); }
    private static function digestValue($value): void {
        if (!is_string($value) || !preg_match('/^[a-f0-9]{64}$/D', $value)) { throw new PackageException('Lowercase SHA-256 required'); }
    }
    private static function size($value, int $maximum): void {
        if (!is_int($value) || $value < 0 || $value > $maximum) { throw new PackageException('Invalid or excessive byte count'); }
    }
    private static function addBounded(int &$value, int $amount, int $maximum): void {
        if ($amount < 0 || $value > $maximum - $amount) { throw new PackageException('Size limit exceeded'); }
        $value += $amount;
    }
    private static function directory(string $path): void {
        if ($path === '' || $path[0] !== '/' || $path === '/' || str_ends_with($path, '/')
            || str_contains($path, "\0") || str_contains($path, '\\')) { throw new PackageException('Canonical absolute directory required'); }
        $cursor = '';
        foreach (explode('/', substr($path, 1)) as $part) {
            if ($part === '' || $part === '.' || $part === '..') { throw new PackageException('Noncanonical storage path'); }
            $cursor .= '/' . $part;
            clearstatcache(true, $cursor);
            $stat = @lstat($cursor);
            if ($stat === false || ($stat['mode'] & 0170000) !== 0040000 || is_link($cursor)) {
                throw new PackageException('Storage path is missing or symlinked');
            }
        }
        if (realpath($path) !== $path) { throw new PackageException('Storage path is not canonical'); }
    }
    private static function newDestination(string $path): void {
        self::directory(dirname($path));
        $name = basename($path);
        if ($name === '' || $name === '.' || $name === '..' || $path !== dirname($path) . '/' . $name
            || str_contains($name, "\0") || str_contains($name, '\\')) { throw new PackageException('Invalid unpublished destination'); }
        clearstatcache(true, $path);
        if (@lstat($path) !== false) { throw new PackageException('Unpublished destination must not exist'); }
    }
    private static function regularFile(string $path, int $maximum): array {
        self::directory(dirname($path)); clearstatcache(true, $path);
        $stat = @lstat($path);
        if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1 || is_link($path)) {
            throw new PackageException('Single-link regular file required');
        }
        self::size($stat['size'], $maximum);
        return $stat;
    }
    private static function openRegular(string $path, int $maximum) {
        $before = self::regularFile($path, $maximum);
        $stream = @fopen($path, 'rb');
        if ($stream === false) { throw new PackageException('Cannot open regular file'); }
        $after = fstat($stream);
        if (!is_array($after) || $after['dev'] !== $before['dev'] || $after['ino'] !== $before['ino']
            || ($after['mode'] & 0170000) !== 0100000 || $after['nlink'] !== 1 || $after['size'] !== $before['size']) {
            fclose($stream); throw new PackageException('Source changed while opening');
        }
        return $stream;
    }
    private static function makeParents(string $root, string $name): void {
        $parts = explode('/', $name); array_pop($parts); $path = $root;
        foreach ($parts as $part) {
            $path .= '/' . $part;
            if (@lstat($path) === false && !@mkdir($path, 0700)) { throw new PackageException('Cannot create payload directory'); }
            self::directory($path);
        }
    }
    private static function walk(string $root, string $prefix, array &$files, int &$entryCount): void {
        self::directory($root); $children = scandir($root);
        if ($children === false) { throw new PackageException('Cannot enumerate release'); }
        foreach ($children as $name) {
            if ($name === '.' || $name === '..') { continue; }
            if (++$entryCount > self::MAX_ENTRIES) { throw new PackageException('Excessive retained entry count'); }
            $relative = $prefix . $name;
            $path = $root . '/' . $name; $stat = @lstat($path);
            if ($stat !== false && ($stat['mode'] & 0170000) === 0040000 && !is_link($path)) {
                // pbin itself is the one allowed top-level directory.
                if ($relative !== 'pbin') { self::path($relative); }
                self::walk($path, $relative . '/', $files, $entryCount);
            } else {
                self::path($relative);
                $stat = self::regularFile($path, $relative === 'manifest.json' ? self::MAX_MANIFEST : self::MAX_FILE);
                $files[$relative] = ['size' => $stat['size']];
                if (count($files) > self::MAX_FILES + 1) { throw new PackageException('Excessive retained inventory'); }
            }
        }
    }
    private static function removeOwnedDirectory(string $path): void {
        // Only the fresh unpublished directory created by this call is eligible.
        $stat = @lstat($path);
        if ($stat === false) { return; }
        if (($stat['mode'] & 0170000) !== 0040000 || is_link($path)) { @unlink($path); return; }
        $children = @scandir($path);
        if ($children === false) { return; }
        foreach ($children as $name) { if ($name !== '.' && $name !== '..') { self::removeOwnedDirectory($path . '/' . $name); } }
        @rmdir($path);
    }
}
