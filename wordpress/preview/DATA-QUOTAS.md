# Preview application data bounds

The selected trusted preview package enforces these fixed per-tenant limits:

- 8 MiB (8,388,608 bytes) total UTF-8 text fields across pastes, diffs and
  snapshots. Text, language, title, snapshot name and both diff sides count.
- 1,000 total document rows, including empty pastes/diffs/snapshots.
- 1,024 rate-limit buckets. Existing clients still use their buckets at the cap;
  new clients are denied until old limiter metadata expires. Only limiter
  metadata older than one hour is reclaimable, never user documents.

The quota is preview-only (`Instance::current()->preview`). Default production
keeps schema version `1`, its four existing table definitions and its original
storage/limiter behavior. Preview uses schema version `2` and one additional
`<WordPress prefix>pbin_pr_<number>_quota` singleton table.

## What is and is not bounded

The 8 MiB figure is **logical text bytes**, not physical MySQL allocation.
Document IDs/timestamps, InnoDB pages, indexes, fragmentation, redo/binlogs,
WordPress tables and provider overhead are not included. Row and limiter caps
bound additional application metadata, but do not promise an exact disk size.
A shared server must budget actual database and filesystem usage separately.

Every retained tenant has its own quota, even when disabled. Retirement does not
remove documents. The trusted global admission described below limits data-bearing
retained tenants to two; metadata-only tombstones do not allocate document space.
No automatic retention/deletion policy is introduced. This logical bound remains
separate from physical database and filesystem accounting.

This is functional protection against anonymous document/limiter writes made
through this implementation, **not a security sandbox for arbitrary branch PHP**.
Reviewed branch code and privileged database clients can bypass it. Older
writable releases without this protocol must not be activated against an
initialized tenant; retained revision routes remain assets-only.

## Admission and failure behavior

All preview document writes and limiter changes serialize on the tenant's
InnoDB quota singleton in a dedicated transaction. Actual `OCTET_LENGTH`/row
aggregates are recomputed while holding that lock; no cached counters can drift.
For a successfully initialized quota-capable tenant, an update charges only its
delta, so a no-op or shrink still works at capacity. A snapshot checks its parent
inside the same locked transaction. Admission failures from that ready tenant
return HTTP 507 without deleting or replacing existing documents. This does not
cover bootstrap migration failures described below. Limiter
capacity exhaustion returns the existing HTTP 429 behavior.

Incoming text is checked as UTF-8 and capped before a SQL write. Every document
write is read back in the transaction and compared byte-for-byte, rolling back
if MySQL truncated or converted a value. All participating tables must remain
InnoDB. Every INSERT/UPDATE/metadata DELETE is fenced by the transaction's
`CONNECTION_ID()` so wpdb reconnect/replay cannot mutate in a replacement
connection outside the lock. A lost commit acknowledgement is explicitly
uncertain, not an automatic retry instruction. Read before retrying; an anonymous
create API does not supply a general idempotency key.

## Migration and existing data

Quota initialization happens only within `PBIN_Store::install()`. The existing
runtime currently calls that method from `plugins_loaded` for the selected
active package when its per-instance schema marker differs. Thus this is still
trusted selected-package bootstrap initialization, **not** a newly implemented
controller-side explicit provisioning gate. Retained asset requests do not run
migrations. Default production's migration behavior is unchanged.

The migration reads existing document bytes/rows and limiter count atomically
under the singleton lock and refuses over-budget data without deleting it or
setting the new schema marker. Initialization is transactional. A failed new
initialization may leave an empty quota table (DDL cannot roll back); later
requests refuse that partial state rather than silently seeding/resetting it.
The thrown bootstrap error prevents all normal preview HTTP routing, including
reads and shrinking updates. Thus an already-over-budget tenant upgrading from
the old schema is preserved in MySQL but is **not readable or shrinkable through
the app** until an operator resolves the failed migration. This patch does not
provide a read-only recovery route or automatic repair. Operators must investigate
and explicitly repair/provision the affected test instance. Missing/corrupt
state during ordinary writes is likewise a hard error,
never schema repair. No upgrade resets a counter or discards documents.

## Verification

`php wordpress/tests/preview-quota.php` uses a synthetic database recorder. It
covers byte/row caps, all text fields, no-op/shrink/reuse, failed mutations,
truncation, UTF-8, orphan snapshots, reconnect/replay fences, migration rejection,
missing/corrupt/non-InnoDB state and limiter reclamation. It is not MySQL evidence.
Existing production/tenancy tests remain part of `check-unit.sh`.

`bash wordpress/ci/check-preview-quota.sh` runs only inside the guarded disposable
WordPress fixture against its unique localhost `pbin_ci_<24 hex>` database and
extracted package. It refuses reused test tenants. Two independent PHP/wpdb
workers must both be observed waiting for record locks on the exact quota table
and blocker using the existing live `RaceObserver` helper before the coordinator
releases admission; exactly one may consume the final byte/row capacity.
The fixture also tests UTF-8, no-op/shrink, immutable snapshots and a deliberately
failing insert trigger. It requires the disposable MySQL fixture's ability to
inspect live Performance Schema lock dependencies and create/drop that fixture trigger. It never changes
staging/production or uses real user documents. No live MySQL/listener run is
permitted or claimed in the implementation environment; hosted results must be
reported separately.

## Trusted retained-tenant admission

The trusted MySQL registry now allows at most **two data-bearing retained
tenants**, counting every non-empty release map whether enabled or retired.
The separate 1,024-record ceiling is metadata/empty tombstones only, not 1,024
8 MiB allocations. Empty close tombstones consume no data slot. A third distinct
PR cannot become writable, even after another retires. Updates and compatible
rollbacks of an already-reserved tenant use its existing slot. No slot-release
or automatic data-deletion policy is provided; freeing one needs a separately
authorized retention procedure.

The count is validated in the same locked, connection-fenced registry CAS as
activation. Given a successful inventory preflight and trusted quota-compatible
write paths, admitted allocations total at most 16 MiB logical document text,
2,000 document rows and 2,048 limiter buckets. These are **not** a physical
100 MiB database guarantee. WordPress/default data, indexes, InnoDB allocation,
fragmentation and provider overhead still require verified headroom.

Before controller install/rollback and before MySQL-loader startup, a read-only
metadata inventory refuses preview tables not owned by retained registry
reservations, unknown table suffixes or other preview prefixes in that database.
It neither adopts nor deletes orphan/unregistered/partial data. Reserved tenant
partial initialization is left to the normal schema migration's fail-closed
checks. A previously populated database must pass this inventory and existing
per-tenant migration bounds before a global logical bound is claimed. Only the
trusted controller/registry may provision writable tenants; privileged direct
SQL or unreviewed branch code remains outside the guarantee.

## Writable rollback compatibility and retained assets

`control/quota-recipe.php` independently pins the exact reviewed bytes of
`pbin/includes/store.php` and `pbin/includes/preview-quota.php`. The trusted client
also compares those paths against its reviewed Git baseline. The controller
checks actual files before install/rollback activation; the loader checks them
before loading writable package PHP. A manifest capability string alone is never
accepted. A store/quota change requires an explicit reviewed trusted recipe
update, with the aggregate unit gate verifying the actual integrated bytes.

These two pins prevent accidentally activating pre-quota storage implementations.
They do not certify arbitrary PHP, prevent an intentionally modified runtime from
bypassing the store, or sandbox code sharing WordPress/database credentials.
Ordinary trusted runtime/HTTP/template changes remain possible, including the
existing synthetic PHP upgrade/rollback acceptance fixture.

Immutable asset requests now use `control/static-assets.php` directly and never
include any release's PHP. Old pre-quota releases therefore remain asset-only,
not writable rollback targets. The same trusted server can be used by production
without importing staging quota/registry state: it takes a canonical plugin root,
a relative static path and a trusted URL-mapping callback. It permits GET/HEAD,
serves only whitelisted static MIME types, caps reads at 16 MiB, rejects symlinks
and hardlinks, and preserves worker/immutable-cache headers. Production/default
application storage remains unchanged.
