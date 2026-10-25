# Disabled trusted staging controller: bounded implementation milestone

This code is not installed on Wasmer. No private persistent mount, credential,
principal, capability grant, workflow activation or deployment is performed.
Native ZipArchive availability alone is not deployment acceptance. The module is
trusted control-plane code installed separately from branch ZIPs, never copied
from a PR's package. Shared trusted PHP remains functional isolation, not a sandbox.

## Explicit configuration and setup boundary

The trusted MU entrypoint may require `controller.php` and `loader.php`. All
adjacent dependencies (`mysql-registry.php`, `selector.php`, `health.php`, and
`control/*.php`) must come from the reviewed control-plane revision. The default
controller and setup action are disabled. No code creates a principal, password,
role, capability or persistent credential.

Before an administrator can enable this on the separately approved staging app:

- `PBIN_PREVIEW_STAGING` must be boolean true and `WP_ENVIRONMENT_TYPE` must be
  `staging`. `PBIN_PREVIEW_STAGING_ORIGIN` must be an explicit HTTPS origin exactly
  matching WordPress's home URL. The current client targets only
  `https://pbin-staging.wasmer.app`.
- `PBIN_PREVIEW_REGISTRY_BACKEND` must be exactly `mysql` and `PBIN_PREVIEW_ROOT`
  must name an already approved, canonical, private directory (mode 0700) on the
  persistent RWX mount, disjoint from ABSPATH, WP_CONTENT_DIR and DOCUMENT_ROOT.
  No `/data` location is assumed or created, and there is no wp-content fallback.
- `PBIN_PREVIEW_CONTROLLER_ENABLED` must explicitly be boolean true before the
  management adapter registers. HTTPS is also required for each request.
- Cookie-authenticated administrators need `manage_options` and the real core
  WordPress REST nonce check. Application-password calls require a successfully
  authenticated app password, the explicitly approved
  `PBIN_PREVIEW_AUTOMATION_USER_ID`, and `pbin_manage_previews`. Giving a user only
  `manage_options` does not authorize app-password deployment. No grant is made
  here; creating credentials or changing persistent access requires approval.
- Initial setup is separate: temporarily enable `PBIN_PREVIEW_SETUP_ENABLED`,
  then an HTTPS POST to WordPress's admin-post action
  `pbin_preview_install_schema` must pass `manage_options` and the action's admin
  nonce. It verifies/creates the three private subdirectories and explicitly calls
  `installSchema()`. Disable setup afterward. This action has no public installer
  or form. Runtime reads, normal boot and loader selection never migrate.

For fixture/compatibility use only, explicitly choose registry backend `file`.
MySQL mode never falls back to a filesystem registry when SQL fails. Switching
between backends is a separately controlled migration, not automatic recovery.
The existing disposable HTTP fixture explicitly chooses file mode; it does not
claim to exercise the new MySQL/controller path.

## REST and bounded input

The routes and successful JSON envelopes match `AUTOMATION.md`: GET tenant,
POST raw ZIP to the full-SHA release route, POST retire, and POST rollback.
`record: null` means absence; empty tombstone releases serialize as `{}`. Token
conflicts return 409. An uncertain database commit returns 503; clients must
inspect state without blindly replaying a mutation or refreshing its token.

Core `WP_REST_Server::serve_request()` normally buffers the entire raw body before
route callbacks. Therefore the adapter runs at parse_request priority 0, before
core's REST callback, for this exact namespace only. It handles both pretty
`/wp-json/` and query-form `?rest_route=` routing, sets REST_REQUEST, refreshes a
cached anonymous user as core does, and invokes the actual REST authentication
filters. Cookie administration additionally invokes core's cookie nonce check
explicitly, even if another authentication filter returned early. Authorization
and method/route checks occur before opening/reading the input stream. Unknown
routes/methods, method override and JSONP do not acquire management authority.
No credential is parsed by this code and no CORS permission is added.

ZIP input is read in bounded chunks into an exclusively created private spool.
The plugin enforces an exact SHA-256, optional exact Content-Length, a 64 MiB
archive cap and the remaining root byte budget while reading. JSON bodies are
limited to 4096 bytes and reject duplicate/extra fields. Compressed HTTP bodies,
multipart uploads, ambiguous digest/token headers and arbitrary paths are refused.
This is a **plugin read/storage bound**, not proof of a PHPix, PHP/SAPI, proxy or
network-level upload cap: those layers may prebuffer bytes before PHP runs and
need separate real-host acceptance and configuration.

## Filesystem publication and admission

A shared atomic `mkdir(.controller-lock)` serializes filesystem mutations across
instances. No flock, timeout lease, stale-lock expiration or automatic lock
stealing is used. Crashes retain the lock and require explicit operator recovery.
Uncertain database commit outcomes retain it too. A DB-only retirement remains
available despite this lock so a failed upload cannot prevent fencing a closed PR.

All files/directories under the root count toward hard bounds: 256 MiB and 65536
entries, including data, pending uploads, partial packages, snapshots and orphans.
Symlinks, multiply linked regular files and other special entries fail closed.
Before extraction, admission reserves the exact verifier snapshot size plus its
64 MiB expanded-byte and 16384-entry hard bounds. A fourth retained or orphan
full-SHA directory for one tenant is refused. No retained data is deleted to fit.

The native verifier exclusively mkdir-creates the final SHA destination. There
is no overwriting rename or replacement of an existing release. An existing
complete directory must pass full canonical archive and manifest verification;
an incomplete directory is refused, never replaced. Successfully verified files
are sealed read-only before publication. Files become routable only after the
MySQL CAS succeeds with the exact approved complete release record. A late CAS
conflict can leave an unroutable, counted orphan; it cannot alter the active token.
The controller never executes package PHP, runs commands or accepts a client path.

Reads select the authoritative MySQL snapshot and ordinary branch loading stays
limited to the existing preview selector paths. Normal WordPress, admin, cron,
REST and unrelated requests do not execute branch PHP. Health still executes the
real selected plugin's health handler. On the exact active `/previews/pr-N/health`
path, the trusted loader replaces the emitted revision and cache headers with
`X-Pbin-Revision` and `Cache-Control: no-store`. If supplied, one exact
`pbin-health-nonce=<64 lowercase hex>` query is echoed as
`X-Pbin-Health-Nonce`. Malformed/duplicate nonce queries are rejected before branch
execution and no nonce is reflected elsewhere. This is not a synthetic OK.

## Intentional lifecycle limit and recovery design

The proof is deliberately bounded: at most two enabled tenants and a hard total
of two retained/data-bearing tenants, three immutable retained releases per
tenant, 1024 registry records including empty tombstones, and the root limits
above. Retired tenants with releases still consume a data slot; retiring either
of the first two does not admit a third distinct PR. See [data quotas](DATA-QUOTAS.md)
for the 16 MiB logical-text ceiling and physical-storage limitations. A fourth
SHA for one tenant is blocked. Disabling a tenant does **not** reclaim
its code, registry releases or data, so this is not complete unattended teardown
or an unlimited ongoing PR lifecycle. Lock recovery is deliberately not a network endpoint and there is no age-based purge.
An explicit offline maintenance implementation is described below.

### Offline reviewed maintenance implementation

`control/maintenance.php` now provides an **offline administrator API**, not a
REST route, hook, automatic sweep or deployed operation. An operator must load it
from the reviewed control revision with the existing trusted registry/storage.
No principal, grant, credential, mount or scheduled operation is created.

- `planRetention(tenant, expectedToken, rollbackSha)` verifies every retained
  package, protects the active revision and a distinct explicit rollback revision,
  and writes an immutable digest-addressed plan in the private root. It refuses
  empty plans and unknown rollback targets. Review the exact plan ID and obtain
  deletion approval before applying it.
- `applyRetention(planId)` enforces a minimum 24-hour asset grace from plan
  creation, re-verifies the plan hash, exact token, packages and retained targets,
  then changes registry metadata under MySQL CAS before removing inactive code.
  Each changed state rotates the token. Commit uncertainty retains the storage
  lock and removes no code. Successful cleanup frees a release slot, enabling a
  fourth version while preserving two verified versions. The plan stays as a durable, digest-addressed
  audit record with the original file inventory and counts toward storage limits.
  Previously removed SHAs cannot be reinstalled, even with different bytes; these
  ledgers must never be pruned while serving the registry.
- This never deletes a tenant's data directory, database tables/options/uploads,
  tombstone or data reservation. The two data-bearing tenant bound is unchanged.
  Approval for code retention is not data-retention approval. Finite root/record
  limits remain admission failures rather than a reason to delete user data.
- A crash after metadata commit may leave counted, unroutable partial/orphan code.
  Do not replay the old mutation or invent a new token. Inspect the stored plan,
  authoritative registry and filesystem. With specific recovery approval,
  `finishRetention(planId, observedToken)` verifies the post-commit active/rollback
  pair, absence of every removed reference, 24-hour grace and an exact subset of
  the original hashed file inventory before completing removal. Extra/changed
  files, unsafe links, stale tokens or a later revision fail closed. This operation
  does not change the registry or infer authorization from elapsed time.
- `recoveryObservation()` records the exact lock owner, lock inode/device and
  authoritative registry digest. `recoverLock(observation, true, true)` requires
  the operator to have stopped **all instances' writers** and resolved any
  uncertain commit, then compares that observation again before removing only
  the exact empty owner marker and lock directory. It never checks age, steals
  a live lock or cleans partial releases. Extra entries, unsafe files or changed
  state fail closed. The booleans are explicit operator attestations, not proof
  that this process can detect another host's liveness. Keep management disabled
  until post-recovery inventory/health checks pass.

These methods are not callable through the preview-management credential/API.
They require separately authorized local administration; production is outside
this controller. Local doubles cover grace, exact-token races, uncertain commits,
other-tenant/data preservation and recovery observations. The real MySQL gate
also covers retention CAS and fourth-release admission. Native-host cleanup,
crash recovery and persistent RWX acceptance are still required before use.

## Verification and required acceptance

Passed locally with native PHP 8.4.24: 16 offline controller/storage/service
protocol groups; 15 separate-process REST-adapter/loader cases; and the existing
85/85 tenancy checks after explicit file-fixture selection. These use package,
WordPress and wpdb doubles. They are not native ZIP extraction, real cookie or
application-password authentication, real request streaming, MySQL, Wasm32,
PHPix buffering, RWX durability, deployment or cutover proof.

Run these additional unit entrypoints in the aggregate gate:

```sh
php wordpress/tests/preview-controller.php
php wordpress/tests/preview-controller-http.php
```

Before activation, the disposable real-WordPress/MySQL/native-ZIP HTTPS fixture
must prove, with no production credentials:

- The explicit setup action cannot run when disabled; missing/bad admin nonce,
  anonymous users and insufficient capabilities cannot create schema/directories.
  Cookie REST missing/bad nonce and app-password errors/wrong principal/capability
  fail before body intake; valid dedicated-principal and admin-cookie paths work.
- Pretty and query-form routes use the same permission path. Oversized known- and
  unknown-length bodies, duplicate headers, redirects, wrong content types,
  malformed JSON and invalid package bytes never publish or execute branch PHP.
- Exact native packages install through the service into MySQL-backed loader
  selection. Separate requests/instances race create/retire and same-token updates;
  no destination replacement occurs. Drop DB connectivity and prove no JSON
  fallback, including when a valid registry.json exists beside the private root.
- Two-tenant CRUD/snapshot/options/storage isolation survives install, upgrade,
  rollback and close. Normal WordPress content remains unchanged. Probe health
  with fresh nonces through the real HTTPS/cache path, checking body, revision,
  nonce and no-store before re-reading the same token/state.
- Crash during upload/extraction/sealing and before/after commit. Check the
  counted orphan/partial state, retained lock, bounded capacity, DB-only close,
  non-replay of uncertain operations and explicit authorized recovery plan.
- Test real shared-volume atomic mkdir, permissions, persistent lifetime and
  space/entry caps on the target host, including PHPix prebuffering and Wasm32
  extension/format behavior. A hosted Linux/MySQL green is necessary but is not
  proof of Wasmer behavior or permission to configure the private mount.
