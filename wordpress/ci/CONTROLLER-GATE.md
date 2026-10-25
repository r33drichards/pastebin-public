# Separate real controller HTTPS/auth gate: implemented, hosted execution pending

The new `run-controller-fixture.sh` entrypoint creates a **second** disposable
WordPress site and random MySQL database using the existing fixture harness. It
does not replace or relax the file-registry, canonical-routing, database-tenancy,
native ZIP, Chromium, package or artifact gates. It refuses non-GitHub/local
invocation before creating a listener. No server/database was started in the
socket-prohibited implementation environment.

The gate uses the already built/extracted exact artifact and exact PBIN_SOURCE_SHA.
It verifies the archive with the current packager and produces a separate
synthetic upgrade solely for this fixture. Neither the upgrade nor authentication
material is an artifact eligible for promotion.

## What runs on the hosted runner

- Core WordPress, the real native ZipArchive verifier, the actual controller,
  wpdb and the MySQL-backed loader run without authentication or SQL doubles.
- The existing harness starts its ordinary loopback PHP server. The new gate
  installs trusted controller files into this newly created fixture only,
  configures a private mode-0700 sibling directory, and explicitly initializes
  the registry. File previews are not prepared in this second fixture.
- A separate loopback-only HTTPS proxy uses a per-fixture self-signed certificate.
  The test client explicitly trusts only that certificate, retains hostname/SNI
  verification for `controller-fixture.invalid`, and connects directly to
  127.0.0.1 at a bounded unprivileged port. It never resolves or connects to an
  external host. No global trust-store change, browser security exception,
  `ignoreHTTPSErrors`, `verify=False` or TLS-warning bypass is used.
- The proxy strips any supplied fixture TLS marker and supplies its private
  random marker. Only the fixture's generated wp-config.php, only for loopback
  requests with that exact marker, sets its backend HTTPS indicator. None of
  this proxy-trust code is shipped in the production plugin or MU controller.
- Three throwaway users are created in the disposable database: a scoped
  deployment principal with `pbin_manage_previews`, a different denied principal,
  and an administrator for real cookie/REST nonce checks. Application passwords,
  the cookie/session/nonce and proxy marker are stored only in a mode-0600 file
  under the private fixture directory. They are never command arguments,
  environment variables, stdout, test assertion text or uploaded artifacts.
- Cleanup runs on success/failure/signal: stop the TLS proxy, remove the exact
  secret/key/certificate and generated config files, then let the outer existing
  harness stop PHP and drop its exact random database (including users, grants
  within WP roles, app-password hashes and sessions). No real staging account,
  credential, database, root mount or permission is touched.

## Assertions

The gate proves actual anonymous/bad-app-password/wrong-principal/missing- or
bad-cookie-nonce rejection, valid admin-cookie GET and mutation, valid scoped
application-password GET, temporary capability removal/reinstatement, pretty and
query-form REST routes, unknown methods/routes, duplicate JSON, invalid native
ZIP and absence of unauthorized spool/publication state.

It then POSTs the exact raw ZIP, checks the response and authoritative state,
probes the real selected plugin health with a fresh echoed nonce, exact revision
and no-store, verifies no-op token preservation and stale CAS refusal, installs
a second tenant using unknown-length chunked transport, and interleaves paste
CRUD and snapshots with negative cross-tenant IDs. A synthetic PHP/CSS upgrade
of A must leave B and A's old immutable asset URL unchanged. Rollback must rotate
tokens without losing data; stale ABA updates and stale rollback must fail.
Retirement must block code and retained assets, preserve releases, and leave B
untouched. Absent retirement creates a tombstone that fences an old null-token
install. Default plugin table counts and schema/option sentinel remain unchanged.

These assertions remain **unrun until hosted CI executes the gate**. Six offline
unit tests pass for fixture guards, loopback-only routing/SNI, local-start refusal,
exact-artifact/synthetic-upgrade preparation, and suppressing raw authenticated
fixture failure logs without removing ordinary fixture diagnostics. PHP/Python/shell lint also passes.
Those local checks are not real WordPress authentication, native ZIP install,
HTTPS request streaming, MySQL controller integration, target Wasm32 or Wasmer
persistent-volume/deployment acceptance.

Known boundaries: the fixture tests one local PHP HTTP process, not concurrent
Wasmer instances or RWX durability. The separate existing MySQL registry gate
covers real concurrent database writers. PHP/proxy prebuffering and production
resource limits still require target-host acceptance. The fixture proxy has its
own 70 MiB test transport cap; that is not a controller or Wasmer server-level cap.
The explicit schema setup used by this fixture is trusted operator setup, not
proof of a live administrator setup UI or credential-creation authorization.

## Required CI insertion, separate from current file tests

After artifact build/extraction and before the long browser gate, the workflow runs:

```yaml
- name: Real WordPress controller HTTPS and authentication gate
  env:
    PBIN_WP_CORE_DIR: ${{ github.workspace }}/.ci-wordpress-core
    PBIN_TEST_PLUGIN_DIR: ${{ runner.temp }}/pbin-tested/pbin
    PBIN_TEST_ARTIFACT: ${{ github.workspace }}/.ci-artifacts/pbin.zip
    PBIN_TEST_ARTIFACT_SHA256: ${{ steps.package.outputs.digest }}
    PBIN_TEST_DB_USER: root
    PBIN_TEST_DB_PASSWORD: disposable-ci-only
  run: bash wordpress/ci/run-controller-fixture.sh
```

The existing workflow provides PBIN_SOURCE_SHA, CI/GITHUB_ACTIONS, MySQL 8.4.4,
Python, OpenSSL and PHP mysqli/ZipArchive. This step uses no repository secrets,
permission increase or write token. Do not set PBIN_TEST_RESULTS_DIR for it: the
new wrapper clears inherited artifact-log copying, and only fixed sanitized PASS
or failure labels appear in the console. Do not upload the fixture directory,
wp-config.php, credential files, TLS keys, account dumps or arbitrary logs.

The unit gate also runs `python3 -m unittest discover -s wordpress/tests -p
 'test_controller_http_fixture.py'`, without removing any existing tests. The
trusted preview client's required TEST_STEPS set includes this exact new step.
A new immutable control baseline must be reviewed before deployment; an old
passing recipe cannot substitute for the newly required controller gate.

The ordinary plugin uses the production-style `/paste` mount in this second
fixture, leaving `/wp-json` and query-form REST routing to WordPress. Only this
explicit hosted controller fixture sets PHP `post_max_size=70M`, matching its
loopback proxy transport ceiling; ordinary fixtures remain at `16M`. The trusted
controller still independently caps raw archives at 64 MiB. This is not a
production/Wasmer upload configuration or a claim about proxy prebuffering.
