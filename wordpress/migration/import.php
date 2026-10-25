<?php
/** No HTTP route. Run only as an explicitly configured offline CLI operator. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/importer.php';
require __DIR__ . '/bootstrap.php';

use Pbin\Migration\ExportFile;
use Pbin\Migration\Importer;
use Pbin\Migration\WpdbDestination;
use Pbin\Migration\MigrationException;
use Pbin\Migration\CommitUncertain;
use Pbin\Migration\BootstrapGuard;

try {
    $options = [];
    foreach (array_slice($argv, 1) as $arg) {
        if (!preg_match('/\A--([a-z][a-z0-9-]*)(?:=(.*))?\z/s', $arg, $match)) { throw new MigrationException('Use --option=value arguments; see --help'); }
        $key = $match[1];
        if (array_key_exists($key, $options)) { throw new MigrationException('Duplicate CLI option'); }
        $flags = ['apply', 'offline-writes-confirmed', 'help'];
        $values = ['export', 'export-sha256', 'wordpress-load', 'database', 'table-prefix', 'expect-plan-sha256'];
        if (in_array($key, $flags, true) && count($match) === 2) { $options[$key] = true; }
        elseif (in_array($key, $values, true) && isset($match[2]) && $match[2] !== '') { $options[$key] = $match[2]; }
        else { throw new MigrationException('Unknown CLI option or missing value; see --help'); }
    }
    if (isset($options['help'])) {
        echo "Read-only dry run (default):\nphp import.php --export=/private/export.json --export-sha256=SHA256 --wordpress-load=/site/wp-load.php --database=DB_NAME --table-prefix=wp_pbin_\n\nApply only after reviewing that exact target's dry run and freezing all writers:\nAdd --apply --expect-plan-sha256=PLAN_SHA256 --offline-writes-confirmed\n\nNo tables are installed, no existing records are modified, no data is deleted.\nSee README.md for bounds, required metadata privileges, backup and rollback gates.\n";
        exit(0);
    }
    foreach (['export', 'export-sha256', 'wordpress-load', 'database', 'table-prefix'] as $key) {
        if (!isset($options[$key])) { throw new MigrationException("Missing --$key; no source or destination is inferred"); }
    }
    $apply = isset($options['apply']);
    if ($apply !== isset($options['expect-plan-sha256']) || $apply !== isset($options['offline-writes-confirmed'])) { throw new MigrationException('Apply requires both a reviewed plan hash and explicit offline-writes confirmation'); }
    if ($apply) { ExportFile::hex($options['expect-plan-sha256']); }
    // Fully validate supplied bytes before loading WordPress or opening its DB.
    $export = ExportFile::read($options['export'], $options['export-sha256']);
    $load = realpath($options['wordpress-load']);
    if ($load === false || !is_file($load) || basename($load) !== 'wp-load.php' || $load !== $options['wordpress-load']) { throw new MigrationException('Supply the canonical local wp-load.php path'); }
    if (defined('ABSPATH') || defined('SHORTINIT')) { throw new MigrationException('Use a fresh dedicated CLI process, not an already bootstrapped WordPress'); }
    define('SHORTINIT', true);
    $pbinMigrationBootstrapGuard = BootstrapGuard::start();
    try {
        // Preserve global bootstrap scope: WordPress defines core globals here.
        require $load;
        $pbinMigrationBootstrapGuard->complete();
    } catch (Throwable $error) {
        $pbinMigrationBootstrapGuard->failed();
        throw new MigrationException(BootstrapGuard::FAILURE);
    }
    if (!defined('DB_NAME') || DB_NAME !== $options['database'] || !defined('DB_HOST') || !isset($GLOBALS['wpdb']) || (defined('SAVEQUERIES') && SAVEQUERIES)) { throw new MigrationException('Wrong WordPress database or unsafe query logging; no import attempted'); }
    $targetHash = hash('sha256', "pbin-target-v1\0" . DB_HOST . "\0" . DB_NAME . "\0" . $options['table-prefix']);
    $destination = new WpdbDestination($GLOBALS['wpdb'], $options['table-prefix'], $targetHash, $options['database']);
    $importer = new Importer($destination);
    $receipt = $apply ? $importer->apply($export, $options['expect-plan-sha256'], true) : $importer->reconcile($export);
    fwrite(STDOUT, ExportFile::json($receipt));
    exit($receipt['rows']['conflict'] === 0 ? 0 : 2);
} catch (Throwable $error) {
    // Raw wpdb errors, SQL, paths, titles and content are never printed here.
    $message = $error instanceof MigrationException ? $error->getMessage() : 'Import failed; inspect the private environment without publishing database logs';
    fwrite(STDERR, ExportFile::json(['status' => $error instanceof CommitUncertain ? 'commit-uncertain' : 'refused', 'reason' => $message]));
    exit($error instanceof CommitUncertain ? 3 : 1);
}
