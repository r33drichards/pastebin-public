# Immutable WordPress preview packages

These Python 3.10+ standard-library tools implement the local package and staging
lifecycle. They do **not** deploy to Wasmer, provision a WordPress app, distribute
credentials, or install a remotely callable upload endpoint. A safe Wasmer
execution mechanism, persistent filesystem, Python availability, POSIX `flock`,
atomic same-filesystem rename and directory `fsync` still need to be verified
before any hosted deployment is enabled.

The intended boundary is **one staging WordPress app running trusted, reviewed
same-repository PHP**, not arbitrary or fork-authored code. PR namespaces isolate
normal routing and persistence, not hostile PHP. All packages run with the same
WordPress process/database privileges. Do not use production credentials or
production data. Review and pin the control-plane scripts separately; never run a
PR's installer with deployment credentials. An archive hash proves byte identity,
not provenance or authorization: obtain it from the trusted successful CI run for
the exact approved revision.

## Build once, test those exact bytes

```sh
REVISION=0123456789abcdef0123456789abcdef01234567
python3 wordpress/tools/package.py \
  --source wordpress/pbin --revision "$REVISION" --output /tmp/pbin-preview.zip
```

`--output` is a ZIP filename, not a directory. Standard output is one JSON object
containing `artifact`, `artifact_sha256`, `revision`, `manifest_sha256`,
`file_count`, and `uncompressed_bytes`. Use the full lowercase 40-character commit
SHA of the source checkout. Every regular file under `wordpress/pbin` is included,
including the binary language runtime assets. Unsupported source entries fail the
build rather than being silently omitted. Output must be outside the source tree.

The format is `manifest.json` plus `pbin/**`. The manifest is canonical JSON:

```json
{
  "version": 1,
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "files": {
    "pbin/runtime.php": {"sha256": "64-character-lowercase-sha256", "size": 123}
  }
}
```

The example is abbreviated: both `pbin/pbin.php` and `pbin/runtime.php` are
mandatory, and all payload files must be listed. ZIP entries are sorted, stored
without compression, dated 1980-01-01, and assigned fixed regular-file metadata.
Identical source bytes and revision produce identical ZIP bytes regardless of
source mtimes/modes or zlib versions. No network downloads occur during packaging.

Verify and optionally extract the exact tested artifact:

```sh
DIGEST=the_64_character_artifact_sha256_from_the_trusted_build
python3 wordpress/tools/package.py \
  --verify /tmp/pbin-preview.zip --sha256 "$DIGEST" --revision "$REVISION" \
  --extract-to /tmp/pbin-tested
```

The extraction destination must not exist; its parent must already exist without
symlinked components. The verified plugin is `/tmp/pbin-tested/pbin`. Omitting
`--extract-to` performs verification only. Verification and extraction use a
private snapshot of the same artifact, preventing a concurrent uploader from
changing bytes between the checksum and extraction. The Python API is
`open_verified_package(path, digest)` as a context manager; its result has
`manifest`, `revision`, `artifact_sha256`, `manifest_sha256`, and
`extract(new_directory)`.

Validation rejects traversal/absolute/Windows paths, duplicate and case-colliding
filenames, symlinks and special files, file/directory conflicts, encrypted or
unsupported compression, manifest omissions/extras, duplicate JSON keys, bad
hashes, and control-plane/server-configuration payload paths. Default archive and
expanded limits are 64 MiB, per-file 32 MiB, manifest 1 MiB, and 8,192 payload
files; compressed input is additionally limited to a 200:1 expansion ratio. The
builder emits only uncompressed ZIPs. These bounds reject zip bombs before
extraction. A digest mismatch never creates a staging root.

## Local staging lifecycle

Use a dedicated persistent root outside the public document root. Configure the
trusted MU-loader's `PBIN_PREVIEW_ROOT` to that exact root. Install the trusted
loader/selector separately, never from a PR package. The installer owns the
registry and release trees. The web runtime should have read access to these and
write access only to its tenant data directories, with ownership/access set up
by the administrator. The tools do not grant permissions, change owners, or copy
secrets. They reject symlinked path components.

```text
ROOT/
  registry.json
  .registry.lock
  releases/pr-17/<full-commit-sha>/manifest.json
  releases/pr-17/<full-commit-sha>/pbin/...
  data/pr-17/...
```

Initial install and atomic activation:

```sh
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews install \
  --pr 17 --artifact /tmp/pbin-preview.zip --sha256 "$DIGEST" \
  --revision "$REVISION" --expected-active none
```

The optional `--revision` additionally pins the manifest revision. `--expected-active`
is always required. `none` means the tenant does not yet exist, not that it is
retired. Later installs must name the currently active full SHA, including for a
retired tenant. A stale request fails without promotion; do not replace the
expected value with whatever is current just to force a stale job through.

Registry schema consumed by the trusted selector:

```json
{
  "version": 1,
  "tenants": {
    "pr-17": {
      "enabled": true,
      "active": "0123456789abcdef0123456789abcdef01234567",
      "releases": {
        "0123456789abcdef0123456789abcdef01234567": {
          "artifact_sha256": "64-character-lowercase-sha256",
          "manifest_sha256": "64-character-lowercase-sha256"
        }
      }
    }
  }
}
```

`manifest_sha256` pins the retained manifest so rollback verifies every retained
file against independently recorded integrity metadata without keeping a second
copy of the ZIP. Do not hand-edit the registry or remove this field.

Install validates all bytes, obtains the exclusive registry lock, checks CAS and
budgets, extracts to a new scratch directory, seals release files/directories as
read-only, atomically renames into its immutable revision path, and atomically
replaces the registry. Existing release contents are never overwritten. An exact
repeat can verify/reuse the existing release. Different bytes at the same PR and
revision are rejected. A crash between release publication and registry promotion
leaves a retained, inactive orphan; an exact retry verifies and adopts it without
overwriting. Orphans and unfinished scratch files count toward the storage
budget. Inspect `status` before retrying an operation with an uncertain outcome.

Rollback and retirement change only the tenant's registry pointer/state:

```sh
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews rollback \
  --pr 17 --revision "$OLD_REVISION" --expected-active "$CURRENT_REVISION"
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews retire \
  --pr 17 --expected-active "$CURRENT_REVISION"
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews status
```

Rollback verifies the target manifest/inventory/checksums and can explicitly
re-enable a retired tenant if budgets permit. Retirement disables routing while
retaining the active SHA, all revision files, database tables, and tenant data.
Retirement is allowed even when existing storage exceeds the admission budget so
an operator can disable an over-budget preview. Neither operation deletes data.
Database schema compatibility must be reviewed before rollback: this is a code
pointer rollback, not a database snapshot restore or schema migration system.

## Admission budgets, not automatic deletion

Defaults are 2 active PRs, 3 retained revisions per PR, and 256 MiB total retained
filesystem bytes. All tenants, including retired tenants and orphan revisions,
count. Tenant data and abandoned temporary files count toward storage. The small
registry and lock files do not. Install and rollback fail closed if a limit would
be exceeded. There is no garbage collector, purge operation, automatic eviction,
or reset of saved data. A fourth revision fails rather than discarding an older
revision. An administrator must deliberately revisit capacity/retention policy.

Override limits only on the trusted installer invocation, before the subcommand:

```sh
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews \
  --max-active 2 --max-revisions 3 --max-total-bytes 268435456 status
```

Budgets are filesystem **admission checks** at promotion time. They do not include
WordPress/MySQL database bytes or temporary input-archive snapshots outside the
root, and do not enforce a hard cap on subsequent runtime writes. Enforce the
host's disk/database quotas separately. A runtime writing data concurrently can
change usage after it is measured. Do not claim these tools provide tenant
resource security or hostile-code isolation.

## Tests

```sh
python3 -m unittest discover -s wordpress/tests -p 'test_preview_packages.py' -v
```

Coverage includes exact full-asset reproducibility, CLI extraction of the verified
artifact, malicious ZIP rejection, source-mutation isolation, independent
registry roots, A update/rollback preserving B and both tenants' saved data,
retirement without deletion, immutable releases, stale/concurrent CAS requests,
budget enforcement including orphans, rollback integrity checks, unsafe filesystem
paths, and failure/retry around atomic registry promotion. These local tests do
not establish a hosted deployment or a working WordPress/MySQL/browser instance.
