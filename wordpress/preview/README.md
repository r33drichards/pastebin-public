# Shared WordPress preview staging

This is functional isolation for reviewed PHP from trusted, same-repository branches.
It is **not a PHP security sandbox**. A branch has the WordPress process's filesystem,
database and network authority. Never run untrusted fork PHP here, and never put
production data, production completion-provider keys, or production credentials on
this staging app. Use a distinct staging hostname and WordPress installation.

## Design

The trusted MU loader chooses one immutable package for one request. It does not
activate all PR plugins or rewrite source to invent a namespace for each build.
The plugin uses the fixed `Pbin\Plugin` namespace and an injected `Instance`.
A second bootstrap is rejected. The ordinary plugin is suppressed on preview
requests; preview packages are not in WordPress's active-plugin lists.

* `/previews/pr-123` selects the active SHA in a trusted registry.
* Code is stored at `releases/pr-123/<SHA>/pbin`, outside normal plugin activation.
* Assets use `/previews/pr-123/_releases/<SHA>/static/...` and stay pinned when
  another revision is promoted. Old release URLs serve assets only.
* Tables use `{$wpdb->prefix}pbin_pr_123_`; schema options, extension hooks,
  future object-cache groups, and browser localStorage keys have the same tenant.
* Reserved data directory: `data/pr-123`. The current plugin stores documents only
  in MySQL and does not write tenant files, schedule cron, or register REST routes.
* Default production tables/options remain `pbin_` / `pbin_schema_version`.
* No preview package executes on CLI, admin, AJAX, cron, REST, unrelated paths,
  unknown/disabled tenants, malformed paths, or invalid package paths.
* Preview completion-provider credentials are ignored. This is defense in depth,
  not a secret boundary against trusted branch PHP.

WordPress Multisite alone would share plugin files. Namespace rewriters alone
would not isolate options, tables or URLs. One-selected-version loading has prior
art in [Gutenberg Versions Mirror](https://github.com/inpsyde/gutenberg-versions-mirror).

## Control plane and installation

Install `loader.php` and `selector.php` together as trusted MU-plugin code, with a
top-level MU entrypoint requiring the loader. Define `PBIN_PREVIEW_ROOT` as an
absolute canonical directory on the staging app's persistent volume. Do not put
the control plane inside a PR ZIP. The web server must not directly expose or
execute arbitrary release-directory PHP; all requests go through WordPress.
Keep the control plane and registry writable only to the authorized deploy path.

`wordpress/tools/package.py` and `preview_registry.py` implement and test the
artifact/registry protocol. They are Python operator tools, **not a claim that
managed Wasmer WordPress can run Python**. The Wasmer write transport must be
verified before deployment automation can be enabled. Local filesystem `flock`
and atomic-rename tests do not establish cross-instance locking on Wasmer's shared
RWX volumes. Hosted control is expected to use MySQL-authoritative transactional
state and token CAS; do not treat this local operator protocol as production-proven.
Candidate transports are a
deployment job with verified persistent-volume access, or a separately reviewed
authenticated WordPress deployment endpoint. No credentials are created here.

## CI and lifecycle gates

1. Run PHP lint/unit tests, the real WordPress/MySQL HTTP contract, two-tenant
   isolation tests, and browser runner tests. Existing browser runners are preserved; experimental Go-language execution is separate and must not be confused with
   retiring the Go backend service.
2. Package the exact tested commit and retain its artifact digest and manifest.
   Deploy that artifact, never rebuild it in a privileged deploy job.
3. For previews, accept only reviewed same-repository PR heads. Do not use
   `pull_request_target` to execute PR code with secrets. Recheck the PR is open and
   its current head is the tested SHA before promotion. Serialize each tenant;
   compare-and-swap an opaque v2 state token, not just the active SHA. Every real
   change rotates the token, so retirement and A-to-B-to-A rollback fence stale
   installs. Do not refresh a stale job's token without revalidating its intent.
4. Verify both PR A and PR B can create/edit/read/snapshot independently with the
   same IDs in separate tables; check options, rate limits and browser storage.
   Upgrade and roll back A and prove B's code/data are unchanged.
5. On PR close, disable its registry entry, creating a durable token-bearing
   tombstone even before the first install. Keep tombstones and code/data. If an
   install beats a close request's CAS, recheck that the PR is still closed before
   issuing a fresh retirement; event reconciliation belongs to the controller.
   Any permanent database/file purge requires a separately approved retention policy.
6. Refuse operations over the configured package/tenant/disk limits. Inspect the
   actual account budget before staging creation. Database storage and compute
   usage also need observation; the disk cap is not a MySQL/compute quota.

Default proof limits are two enabled tenants, three retained releases per tenant,
and 256 MiB on disk. These are conservative configurable proof limits, not a
statement of available Wasmer account quota. A fourth distinct retained revision
fails until an explicitly authorized code-only retention cleanup or approved
capacity change. No cleanup or runtime-data purge is implemented. Never upgrade a
plan automatically.

The selector reads registry v1/v2 during transition, but operator mutations require
v2. Use the explicit locked `migrate-v1` command to preserve legacy records and
assign state tokens; no SHA-only mutation fallback exists. See
[the operator protocol](../tools/README.md) for migration and token semantics.

## Production promotion and rollback

Preview state must not be shared with production. Promote only the tested main or
approved release artifact after staging acceptance. Record the installed digest,
current/previous revision, schema version and deployment result.

Wasmer WordPress's persistent `wp-content` and database survive app versions.
Changing the app version alone is **not** a plugin-volume/database rollback.
Use an explicit validated plugin artifact/pointer rollback and verify its health.
Keep schema migrations backward compatible; a code pointer cannot undo an
irreversible data migration. Take a restorable database backup before such changes.

## Verification status

Local PHP and JavaScript unit checks run without a database; Python package tests
exercise the filesystem protocol. They do not prove WordPress/MySQL or Wasmer
behavior. A local real WordPress/MariaDB fixture was prepared, but this execution
sandbox rejects server socket creation. The real HTTP/MySQL/browser CI and staging
gates remain required and must not be reported as passed until executed.

## Preview data bounds

Preview document and limiter writes have fixed per-tenant application quotas.
See [DATA-QUOTAS.md](DATA-QUOTAS.md) for byte/row limits, migration behavior,
concurrency tests, physical-allocation caveats and retained-tenant accumulation.
