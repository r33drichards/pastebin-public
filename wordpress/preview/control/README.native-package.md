# Strict native ZIP package admission

This module accepts **only** the deterministic, uncompressed ZIP format emitted by
`wordpress/tools/package.py`. It uses native `ZipArchive`, never a fallback parser,
never `extractTo`, and never executes package PHP. It is deliberately stricter
than the Python verifier's optional generic DEFLATE support.

## API

```php
require_once 'native-package.php';
use Pbin\Preview\Control\NativePackage;

$report = NativePackage::extract(
    $privateUploadPath, $expectedArtifactSha256, $fullRevisionSha,
    $privateDestinationThatDoesNotExist
);
$verified = NativePackage::verifyExisting(
    $report['directory'], $fullRevisionSha,
    $expectedArtifactSha256, $report['manifest_sha256']
);
```

Reports contain `revision`, `artifact_sha256`, `manifest_sha256`, `file_count`,
`uncompressed_bytes`, `entry_count`, `directory`, and `plugin_dir`.
`file_count` excludes the manifest. `uncompressed_bytes` includes it.
`entry_count` includes all payload files, manifest, unique directories, and the
release root. Retained verification rejects extra files and empty directories.

The destination must be absent, under an existing canonical absolute directory
without symlinked components. The module creates the destination exclusively.
The caller must guarantee the parent is private and not directly served by HTTP.
Creation alone is not publication: the caller owns the state-token CAS and must
not route this directory until extraction and retained verification succeed.

Files are 0600 and directories 0700. The module does not seal or rename releases.
The caller may make its successfully verified tree read-only. Read-only modes are
not a hostile-PHP boundary: the approved branch and controller share runtime
privileges. Package admission does not establish provenance or authorization.

The supplied archive is checked as a single-link regular file and copied through
a bounded SHA-256 pass to an exclusive sibling snapshot, which is removed when
the operation ends. All validation/extraction uses that snapshot. Source path
replacement cannot change the bytes later read by libzip. On validation failure,
only the destination newly created by this call is eligible for cleanup.

## Strict format without another parser

Native ZIP metadata supplies entry streams, raw names, CRCs, sizes and attributes.
The module checks raw/exact ASCII names, fixed Unix regular-file attributes,
STORED/no encryption, inventory and bounds before extraction. Manifest JSON must
match the builder's canonical representation byte-for-byte after schema checking.
That also rejects duplicate JSON keys, alternate scalar types and noncanonical
numbers without a new JSON parser.

While entry streams are checked against manifest sizes/hashes/CRCs, the code
hashes reconstructed **canonical** local headers, bytes, central records and end
record. This must equal the trusted artifact digest. Consequently prefixes,
trailing bytes, extra fields, data descriptors, comments, alternate order,
header discrepancies and flags cannot silently pass as the canonical artifact.
No reconstruction buffer or second archive is needed. All byte counters remain
below 2^31; CRC/attribute comparisons use four-byte representations on wasm32.

Retained verification reconstructs the same full ZIP digest from the actual tree,
not merely its manifest. It therefore verifies both independently recorded
artifact and manifest identities, plus every file and directory.

## Limits and reservations

- MAX_ARCHIVE / MAX_ARCHIVE_BYTES: 67,108,864 bytes.
- MAX_EXPANDED / MAX_EXPANDED_BYTES: 67,108,864 bytes including manifest.
- MAX_FILE: 33,554,432 bytes.
- MAX_MANIFEST: 1,048,576 bytes.
- MAX_FILES: 8,192 payload files.
- MAX_ENTRIES: 16,384 including manifest, directories and release root.

The caller's root accounting must additionally reserve the uploaded source,
private snapshot (exact upload size plus one entry), in-progress extraction and
existing/orphan state. These are admission bounds, not a process-wide disk quota.
The module requires file fsync success but does not establish cross-instance
filesystem consistency, directory durability, HTTP denial or distributed locks.

## Reproducible tests

Generate fixtures into a new directory, using the repository's Python builder:

```sh
python3 wordpress/tests/build-native-package-fixtures.py --output /tmp/pbin-native-fixtures
php wordpress/tests/native-package.test.php /tmp/pbin-native-fixtures
```

CI must require native extraction explicitly, using
`php wordpress/tests/native-package.test.php --require-native /tmp/pbin-native-fixtures`
or setting `PBIN_REQUIRE_NATIVE_ZIP=1`. Missing native ZIP capabilities then fail
the process instead of producing a successful skip. The skip remains visible in
the JSON report even when it is also a required-capability failure.

The generator asserts its valid ZIP is byte-identical to the real builder and
checks it using the Python verifier. It generates 53 archive fixtures. Native
extraction tests are reported **skipped**, not passed, when ZipArchive is absent.
The non-native PHP tests still check canonical manifests, retained-tree identity,
size limits, directory counts, tampering, hardlinks and symlink protection.

`native-package-hosted-smoke.php` is a function-only test helper: load the module
and helper, then call `pbin_native_hosted_smoke($verifiedPrivateParent)` from an
already authorized harness. It creates a known tiny fixture, extracts it, verifies
the tree again and returns digests/counts/platform. It registers no endpoint and
leaves its uniquely named scratch tree for explicit diagnostic cleanup.

PHP lint and 26 non-native checks passed locally; local native extraction is
explicitly skipped because that executor lacks ZipArchive. On 2026-10-25, the
authorized administrator-only staging smoke passed on PHP 8.3.36/phpix, wasm32:
four inert files, eight entries, and 1,594 expanded bytes. Archive digest:
`528b43b601adf2224cf06cee46837441a4610e01f6fb05745ac32136cb7cbaf3`;
manifest digest:
`0369454533372eb311405500d1f39ac21a867e50182a6d4436d7fde361139eb7`.
Its wrapper removed only that synthetic scratch after the test.

That result verifies native extraction, fsync return and retained verification
in private temporary storage, **not persistent-volume durability, concurrent
writers or production deployment**. The complete native adversarial suite must
still pass the required hosted PHP gate; wasm32 adversarial coverage remains
separate from the successful small baseline.
