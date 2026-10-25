<?php
namespace Pbin\Preview\Control;

/** Reviewed write-path compatibility, NOT a sandbox for arbitrary PHP. This
 * file belongs to the trusted control plane and is never read from a package.
 * Store/quota changes require an explicit reviewed update to these hashes. */
final class QuotaRecipe {
    private const FILES = [
        'includes/store.php' => 'a80b1614361ce8ac28cb1946d8ab1af226099ebf641d78e9a033c4ce10d0c804',
        'includes/preview-quota.php' => '68410cbbbb5166ba8d3c2e47bc827584c3310d4cf28dd11419ef126c0ed7fbcc',
    ];
    public static function verify(string $plugin): void {
        Storage::canonicalDirectory($plugin);
        foreach (self::FILES as $path => $expected) {
            $file = $plugin . '/' . $path;
            $stat = @lstat($file);
            if ($stat === false || ($stat['mode'] & 0170000) !== 0100000 || $stat['nlink'] !== 1
                || realpath($file) !== $file || $stat['size'] > 1048576
                || !hash_equals($expected, (string) @hash_file('sha256', $file))) {
                throw new ControlException('Release does not match the reviewed preview quota write-path recipe', 409);
            }
        }
    }
}
