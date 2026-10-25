# Immutable WordPress preview packages

These Python 3.10+ standard-library tools implement the local package and staging
lifecycle. They do **not** deploy to Wasmer, provision a WordPress app, distribute
credentials, or install a remotely callable upload endpoint. A safe Wasmer
execution mechanism, persistent filesystem, Python availability, POSIX `flock`,
atomic same-filesystem rename and directory `fsync` still need to be verified
before any hosted deployment is enabled. Managed Wasmer's shared RWX volumes
also require cross-instance authoritative state: the hosted controller is expected
to use MySQL transactions for mutation serialization and compare-and-swap. These
local `flock` tests do not establish production locking or a deployable transport.

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

The controller envelope format is `manifest.json` plus `pbin/**`. It is **not a
standard WordPress plugin-upload ZIP**: the extra top-level manifest prevents
WordPress’s upgrader from discovering the plugin header. Do not upload that
archive in the WordPress dashboard. Use the separately tested derivative below.

The envelope manifest is canonical JSON:

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

## Standard WordPress installer derivative

`wordpress_installer.py build --canonical pbin.zip --canonical-sha256 "$DIGEST"
--revision "$REVISION" --output pbin-wordpress.zip --receipt installer.json`
derives a deterministic ZIP containing only the verified `pbin/**` payload.
It does not modify the envelope or plugin PHP/assets. The receipt binds the
installer digest to the envelope digest, manifest digest, full source SHA and
complete payload inventory; it is not a signature or independent authorization.

Run `wordpress_installer.py verify --installer pbin-wordpress.zip
--receipt installer.json --canonical pbin.zip --canonical-sha256 "$DIGEST"
--revision "$REVISION"` before using downloaded bytes. Verification checks the
canonical envelope first and regenerates the exact deterministic derivative;
editing both the ZIP and its receipt cannot authorize another payload. Output
paths must be new, and canonical files are never overwritten.

CI retains this derivative separately as `pbin-wordpress-installer-<SHA>` only
when real WordPress `Plugin_Upgrader` installation, installed-file integrity,
activation and HTTP contracts pass alongside all existing runtime gates. The
controller retains its original three-file bundle and continues to consume
`pbin.zip`, not the installer derivative. Download the exact successful run’s
installer; do not manually repackage an older green envelope and call it tested.

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
  --revision "$REVISION" --expected-token none
```

The optional `--revision` additionally pins the manifest revision.
`--expected-token` is always required for install, rollback and retire. `none`
(Python API `None`) means the tenant is genuinely absent, not disabled, retired or
missing an active revision. Every existing tenant has an opaque `state_token`:
64 lowercase hex characters generated from 32 random bytes. It is a concurrency
version, not a credential, authorization grant, artifact digest, or commit SHA.

Capture the expected token when authorizing the operation and hold it fixed.
Every actual registry state change rotates it, including retirement, re-enabling,
and A-to-B-to-A rollback. An exact no-op preserves it only after validating the
supplied token and, where applicable, the retained release integrity. Mutation
results include `state_token` and `changed`. A stale request fails without
promotion. Never silently refresh a token and retry an old deploy intent; recheck
current PR eligibility/head and authorize a new intent instead. A matching token
alone is never permission to run a closed or untrusted PR.

Registry v2 schema consumed by the trusted selector (package manifests stay v1):

```json
{
  "version": 2,
  "tenants": {
    "pr-17": {
      "state_token": "64-character-lowercase-random-hex-token",
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

Install validates all bytes, obtains the exclusive registry lock, checks the complete state token and
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
  --pr 17 --revision "$OLD_REVISION" --expected-token "$TOKEN_AFTER_INSTALL"
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews retire \
  --pr 17 --expected-token "$TOKEN_AFTER_ROLLBACK"
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews status
```

Rollback verifies the target manifest/inventory/checksums and can explicitly
re-enable a retired tenant if budgets permit. Retirement disables routing while
retaining the active SHA, all revision files, database tables, and tenant data.
Retirement is allowed even when existing storage exceeds the admission budget so
an operator can disable an over-budget preview. Neither operation deletes data.
Database schema compatibility must be reviewed before rollback: this is a code
pointer rollback, not a database snapshot restore or schema migration system.

### Close-before-install tombstones and competing intents

Retiring an absent PR with `--expected-token none` creates a durable disabled
record with a new token, `active: null`, and `releases: {}`. It creates no release
or tenant data directories. An enabled record must always have a non-null valid
active SHA present in releases; null active with retained releases is invalid.
The selector rejects disabled tombstones before inspecting active state. Retained
asset URLs are also unavailable while a tenant is disabled.

A previously queued first install carrying `none` cannot bypass the tombstone.
An explicit newly authorized reopen can install using the tombstone's token,
but only after the trusted controller rechecks that the PR is eligible and open.
Do not delete tombstones: removal would erase the fence against stale absence.

If first install and retirement both race with expected `none`, exactly one CAS
wins. When retirement wins, the stale install fails. When install wins first,
the stale retirement also fails; the controller must recheck that the PR remains
closed and issue a fresh retirement against the current token. The local registry
never blindly retries conflicts and does not itself query GitHub or reconcile PR
events. CAS protects an authorized intent; it does not replace event reconciliation.

### Explicit legacy migration

The selector and `status` can read registry v1 during transition. New mutations
refuse v1 rather than silently inventing tokens or accepting active-SHA CAS. After
updating all trusted writers and readers, migrate explicitly:

```sh
python3 wordpress/tools/preview_registry.py --root /srv/pbin-previews migrate-v1
```

Migration acquires the same exclusive lock, preserves every tenant's enabled flag,
active SHA, retained release metadata and data, assigns each tenant a random
state token, and atomically replaces the registry as v2. Already-v2 migration is
a no-op and does not rotate tokens. A failed replacement leaves v1 unchanged;
inspect status after any uncertain result. Old `--expected-active` flags and
40-character SHA-only API writes are not supported. Never downgrade the registry,
remove tombstones, or restart from an empty registry to make an old job pass.

## Admission budgets, not automatic deletion

Defaults are 2 active PRs, 3 retained revisions per PR, and 256 MiB total retained
filesystem bytes. All tenants, including retired tenants and orphan revisions,
count. Tenant data and abandoned temporary files count toward storage. The small
registry and lock files do not. Install and rollback fail closed if a limit would
be exceeded. There is no garbage collector, purge operation, automatic eviction,
or reset of saved data. A fourth distinct revision fails rather than discarding
an older revision. Continuing requires an explicitly authorized code-only
retention cleanup (not implemented) or an approved capacity adjustment. Any future
code-only cleanup must preserve tenant runtime data and tombstones, protect active
releases, and rotate the affected state token. There is no runtime-data purge.
An administrator must deliberately revisit capacity/retention policy.

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
retirement without deletion, immutable releases, stale/concurrent token CAS,
close-before-install tombstones, both first-install race orderings, close/ABA
regressions, no-op semantics, explicit atomic legacy migration, budget enforcement
including orphans, rollback integrity checks, unsafe filesystem paths, and
failure/retry around atomic registry promotion. These local tests do
not establish a hosted deployment or a working WordPress/MySQL/browser instance.
