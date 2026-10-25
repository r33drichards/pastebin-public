# Authoritative MySQL preview registry (isolated storage module)

`mysql-registry.php` is trusted control-plane code, not part of a branch archive.
It defines no hooks, endpoints, configuration or credentials, and executes no
release PHP. It is deliberately **not wired into the existing loader/selector**.
An installer and read adapter must use this authoritative store together before
it can replace the filesystem protocol. Never run two authoritative registries.

## Contract and authorization boundary

Construct `Pbin\Preview\MysqlRegistry($wpdb)` using a dedicated, ordinary
autocommit WordPress connection. Its table is the validated WordPress
`base_prefix` plus `pbin_preview_registry`, separate from every tenant/application
table and ordinary WordPress options. It does not use mutable tenant `prefix`.
Canonical tenant identifiers are `pr-` followed by 1–10 positive decimal digits,
without leading zeros. They remain strings on 32-bit PHP.

- `installSchema()` is an **explicit administrator/CI migration**, never a
  public-request fallback. A trusted controller must enforce its administrator
  capability (for example `manage_options`), installation action and CSRF checks
  before calling it. This class does not provide authentication/authorization.
  Existing schemas/state are validated, never reset, repaired or imported from
  `registry.json`. Concurrent or partial first-time installation fails closed;
  administrator recovery is required after a table-created/row-not-created error.
- `snapshot()` returns `{version: 2, tenants: {...}}`; `tenant('pr-N')` returns
  the tenant record or null for actual absence. Runtime reads never create state.
- `compareAndSwap($tenant, $expectedToken, $desired)` takes exactly
  `{enabled, active, releases}`. The caller must have already authenticated and
  authorized the action, verified current PR/head/provenance and artifact hashes,
  completed immutable file publication and performed storage admission. This
  module does not validate archive bytes, install files or establish deploy trust.
- `retire($tenant, $expectedToken)` disables an existing record without deleting
  releases/data. Absence becomes a disabled empty tombstone with a fresh token.

A tenant record has exactly `state_token`, `enabled`, `active`, `releases`.
Tokens are 32 cryptographically random bytes encoded as 64 lowercase hex digits.
`releases` is an object keyed by 40 lowercase hex source SHA; each entry has
exactly `artifact_sha256` and `manifest_sha256`, both 64 lowercase hex digits.
`enabled` is strictly boolean. `active` must name a retained release, except that
null is allowed only for a disabled record with no releases. The PHP API uses
arrays for maps internally; the stored JSON always uses objects, including `{}`
for empty maps. An HTTP wrapper must preserve this object shape when serializing
an empty tombstone, for example by casting `releases` to an object.

`expectedToken === null` means **absence only**, never “any/current state”. A
stale token conflicts even for an otherwise identical request. An exact no-op
with the current token preserves the token; every real mutation rotates it.
Retained release metadata cannot be changed or omitted. Rollback is a CAS whose
`active` names an existing retained SHA; it must keep all release metadata.

## Transaction and failure model

One singleton InnoDB row stores the entire bounded canonical v2 registry. A
transaction takes `SELECT ... FOR UPDATE` on that existing row before checking
the tenant token, no-op, immutability or global admission limits. This serializes
an absent install against retirement without depending on missing-row/gap locks;
it also serializes admission across different tenants. No process-local/flock
assumption, filesystem JSON mirror or cross-instance file lock is involved.

The hard bounds are 1 MiB canonical JSON, 1024 registry records including empty
tombstones, 2 enabled tenants, 2 retained/data-bearing tenants in total and 3
retained releases per tenant. Retired records with releases still occupy a data
slot, so retirement does not admit a third distinct tenant. The retained-data
cap cannot be increased through constructor options; other configurable bounds
may only tighten their defaults. See [data quotas](DATA-QUOTAS.md) for logical
text limits and the distinction from physical database storage. A bound failure rolls back; nothing is purged.
Filesystem/storage/compute limits remain controller responsibilities. This DB
transaction does not atomically commit a filesystem rename, and the loader must
never execute a record until its immutable files are complete and verifiable.

Reads/mutations reject missing or non-InnoDB storage, unexpected table schema,
unknown versions, noncanonical/duplicate-key/corrupt JSON, malformed records,
missing singleton, and database errors. Neither a failed read nor a failed
migration means an absent tenant. Existing caller transactions and autocommit-off
connections are refused rather than implicitly committed by `START TRANSACTION`.

WordPress `wpdb` may reconnect and replay SQL. The lock read and update are fenced
by the original MySQL `CONNECTION_ID()`, and the connection is checked again after
commit. A reconnect cannot write on a fresh unlocked connection. A failed/replayed
commit raises `RegistryCommitUncertain`: the controller must re-read authoritative
state before deciding what happened, not blindly retry. No raw SQL errors or
credentials are included in the module's exception messages.

Tokens fence stale jobs and ABA, not remote PR lifecycle events. If an install
wins a close/install race, retirement using an older token conflicts: the trusted
workflow must re-read the latest token and reconcile the closed PR. This final
close reconciliation, and the decision to reopen a tombstone, are not delegated
to a database record or inferred from an old token.

## Verification and required hosted gate

Local protocol suite (recording wpdb double, **not real SQL/locking proof**):

```sh
php wordpress/tests/mysql-preview-registry.php
```

Inside the repository's existing disposable localhost WordPress/MySQL fixture:

```sh
bash wordpress/ci/run-fixture.sh bash wordpress/ci/check-mysql-preview-registry.sh
```

Use the existing core/artifact/database environment variables documented in
`wordpress/ci/README.md`. MySQL 8.4.4 is the intended hosted target; MariaDB's
schema introspection is not certified. The fixture account needs the existing
create/drop permissions plus PROCESS visibility and permission to kill its own
test connections. Do not use production credentials or an existing database.
The test requires the fixture's random `pbin_ci_<24 hex>` database, canonical
fixture WordPress path, localhost and explicit mutation flag.

The gate boots real WordPress with SHORTINIT (no branch or active plugin PHP),
uses real wpdb/InnoDB, and starts separate PHP processes. It observes both
contenders in InnoDB's LOCK WAIT state before releasing the parent row lock, then
checks absent-install/retire, same-token upgrade and cross-tenant quota races.
It tests real wpdb reconnect/replay by disconnecting its own disposable
connections before UPDATE/COMMIT, checks malformed/oversize/unknown/non-InnoDB
state, and fingerprints all ordinary WordPress/application tables before and
after. The fixture removes its own database afterward.

Integrators should add the local protocol command to the unit gate and the
MySQL script to the existing hosted fixture contract gate. Neither is wired by
this isolated patch. The real database gate has **not been run in the local
socket-prohibited implementation environment**; PHP lint and wpdb-double success
must not be reported as MySQL, Wasmer, controller, deployment or cutover proof.
