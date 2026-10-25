<?php
namespace Pbin\Preview;

use RuntimeException;

/** Trusted control plane: never load a request-selected filename or arbitrary ZIP. */
final class Selector {
    public static function resolve(string $path, array $registry, string $root): ?array {
        if ($path !== '/previews' && !str_starts_with($path, '/previews/')) { return null; }
        if (str_contains($path, '%') || str_contains($path, '//') || str_contains($path, '\\')
            || preg_match('~(?:^|/)\.{1,2}(?:/|$)|[\x00-\x20\x7f]~', $path)) { throw new RuntimeException('Invalid preview path'); }
        if (!preg_match('~^/previews/(pr-([1-9][0-9]{0,9}))(?=/|$)~D', $path, $match)) { throw new RuntimeException('Unknown preview'); }
        $version = $registry['version'] ?? null;
        if (!in_array($version, [1, 2], true)) { throw new RuntimeException('Unsupported registry'); }
        $tenant = $match[1];
        $record = $registry['tenants'][$tenant] ?? null;
        if (!is_array($record) || ($record['enabled'] ?? false) !== true) { throw new RuntimeException('Unknown preview'); }
        // Disabled v2 tombstones are rejected above before nullable active or
        // release metadata is examined. Enabled records must be complete even
        // when the request pins an older asset revision.
        if ($version === 2 && (!is_string($record['state_token'] ?? null)
            || !preg_match('/^[a-f0-9]{64}$/D', $record['state_token']))) { throw new RuntimeException('Invalid state token'); }
        $revision = $record['active'] ?? null;
        if (!is_string($revision) || !preg_match('/^[a-f0-9]{40}$/D', $revision)
            || !is_array($record['releases'] ?? null) || !isset($record['releases'][$revision])) { throw new RuntimeException('Invalid active release'); }
        $base = '/previews/' . $tenant;
        $requestBase = $base;
        $suffix = substr($path, strlen($base));
        if (str_starts_with($suffix, '/static/')) { throw new RuntimeException('Preview assets require an immutable release URL'); }
        if (str_starts_with($suffix, '/_releases/')) {
            if (!preg_match('~^/_releases/([a-f0-9]{40})(/static/.+)$~D', $suffix, $asset)) { throw new RuntimeException('Release routes serve assets only'); }
            $revision = $asset[1];
            $requestBase .= '/_releases/' . $revision;
        }
        if (!is_string($revision) || !preg_match('/^[a-f0-9]{40}$/D', $revision) || !isset($record['releases'][$revision])) { throw new RuntimeException('Unknown release'); }
        $canonicalRoot = realpath($root);
        $directory = $root . '/releases/' . $tenant . '/' . $revision . '/pbin';
        if (!$canonicalRoot || realpath($directory) !== $canonicalRoot . '/releases/' . $tenant . '/' . $revision . '/pbin') { throw new RuntimeException('Invalid package path'); }
        $entry = $directory . '/runtime.php';
        if (!is_file($entry) || is_link($entry) || realpath($entry) !== $entry) { throw new RuntimeException('Missing package entry'); }
        return [
            'key' => 'pr_' . $match[2], 'base_path' => $base,
            'request_base_path' => $requestBase, 'revision' => $revision,
            'plugin_dir' => $directory, 'data_dir' => $canonicalRoot . '/data/' . $tenant,
        ];
    }
}
