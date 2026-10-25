<?php
// Real WordPress upgrader acceptance, included only by the disposable installer fixture.
if (getenv('PBIN_INSTALLER_GATE') !== '1' || getenv('CI') !== 'true' || getenv('GITHUB_ACTIONS') !== 'true'
    || !defined('ABSPATH') || realpath(ABSPATH) !== realpath(getenv('PBIN_WP_TEST_SITE') ?: '')
    || !str_contains(ABSPATH, '/pbin-wp-ci.') || !defined('FS_METHOD') || FS_METHOD !== 'direct') {
    throw new RuntimeException('Refusing WordPress installer outside its disposable hosted fixture');
}
$pluginDir = WP_PLUGIN_DIR . '/pbin';
if (file_exists($pluginDir) || is_link($pluginDir)) { throw new RuntimeException('Installer fixture must start without pbin'); }
$canonical = getenv('PBIN_INSTALLER_CANONICAL') ?: '';
$canonicalDigest = getenv('PBIN_INSTALLER_CANONICAL_SHA256') ?: '';
$installer = getenv('PBIN_INSTALLER_ZIP') ?: '';
$receiptPath = getenv('PBIN_INSTALLER_RECEIPT') ?: '';
$revision = getenv('PBIN_SOURCE_SHA') ?: '';
if (!preg_match('/\A[0-9a-f]{64}\z/D', $canonicalDigest) || !preg_match('/\A[0-9a-f]{40}\z/D', $revision)
    || !is_file($canonical) || !is_file($installer) || !is_file($receiptPath)
    || !hash_equals($canonicalDigest, hash_file('sha256', $canonical))) {
    throw new RuntimeException('Installer identity check failed');
}
// Python has already strictly validated both archives and the canonical JSON.
// Recheck the same immutable identity before WordPress consumes the local file.
$receipt = json_decode(file_get_contents($receiptPath), true, 512, JSON_THROW_ON_ERROR);
$zip = new ZipArchive();
if ($zip->open($canonical) !== true) { throw new RuntimeException('Cannot open canonical installer input'); }
$manifestBytes = $zip->getFromName('manifest.json');
$zip->close();
$manifest = json_decode($manifestBytes, true, 512, JSON_THROW_ON_ERROR);
if ($receipt['revision'] !== $revision || $manifest['revision'] !== $revision
    || $receipt['canonical_artifact_sha256'] !== $canonicalDigest
    || $receipt['canonical_manifest_sha256'] !== hash('sha256', $manifestBytes)
    || $receipt['files'] !== $manifest['files']
    || !hash_equals($receipt['installer_sha256'], hash_file('sha256', $installer))) {
    throw new RuntimeException('Installer receipt binding failed');
}
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';

// Preserve the exact regression: a controller envelope is deliberately NOT an
// ordinary WordPress plugin upload. This must fail before any plugin is placed.
$rejected = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$result = $rejected->install($canonical, ['clear_update_cache' => false, 'overwrite_package' => false]);
if (!is_wp_error($result) || $result->get_error_code() !== 'incompatible_archive_no_plugins'
    || file_exists($pluginDir) || is_link($pluginDir)) {
    throw new RuntimeException('Controller envelope rejection regression failed');
}
$upgrader = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
$result = $upgrader->install($installer, ['clear_update_cache' => false, 'overwrite_package' => false]);
if ($result !== true || $upgrader->plugin_info() !== 'pbin/pbin.php' || is_link($pluginDir)) {
    throw new RuntimeException('WordPress Plugin_Upgrader installation failed');
}
$actual = [];
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($pluginDir, FilesystemIterator::SKIP_DOTS)) as $file) {
    if ($file->isLink() || !$file->isFile()) { throw new RuntimeException('Unexpected installed plugin entry'); }
    $name = 'pbin/' . substr($file->getPathname(), strlen($pluginDir) + 1);
    $actual[$name] = ['sha256' => hash_file('sha256', $file->getPathname()), 'size' => $file->getSize()];
}
ksort($actual);
$expected = $manifest['files'];
ksort($expected);
if ($actual !== $expected) { throw new RuntimeException('Installed plugin differs from the tested canonical payload'); }
if (!hash_equals($canonicalDigest, hash_file('sha256', $canonical))
    || !hash_equals($receipt['installer_sha256'], hash_file('sha256', $installer))) {
    throw new RuntimeException('WordPress changed an immutable input archive');
}
echo "PASS: WordPress Plugin_Upgrader rejected envelope, installed standard ZIP, and verified every payload byte\n";
