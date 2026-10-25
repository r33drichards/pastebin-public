# WordPress checks, artifact boundary and migration plan

This is a **local implementation, not a green hosted CI or Wasmer deployment
receipt**. A server socket/MySQL listener is prohibited in the implementation
environment. Native syntax, unit, package and filesystem checks can run here;
the mandatory real-WordPress and Chromium gates must run on a suitable host.

## One supported backend and source tree

- PHP/MySQL WordPress is the only supported application backend.
- Maintain `wordpress/pbin/templates` and `wordpress/pbin/static` directly.
  Do not regenerate PHP from root Go templates.
- Browser workers, Wasm and all current language choices remain. The upstream
  root assets match their canonical WordPress copies byte-for-byte except the
  deliberately inactive `collab.js` WebSocket client.
- `tools/gen-clojure-core-docs.js` remains a bounded browser-data generator;
  its stdout goes to `wordpress/pbin/static/js/clojure-core-docs.js`.
- `backend-removals.json` records exact clean-baseline blobs retired by this
  migration. The new public baseline contains no imported old Git ancestry.
  The verifier refuses unknown or modified files; canonical plugin assets and
  licenses remain. No production service/data is deleted by source cleanup.
- Experimental language execution work is separate from this backend migration.
  Existing language choices and executable runner tests are preserved; Go as a
  language choice is not a claim that an executable Go runtime is included.
- Legacy GitLab publishing is not included. GitHub's old Go/Nix/Docker/Railway publishers
  are replaced, not run in parallel. Operational production retirement and
  data/canonical cutover remain separate from source removal.

## Package and local test commands

Requirements: Bash, system PHP 8.1+ with mysqli/mbstring/XML/DOM, Python 3.12,
Node 22, curl, pristine WordPress core and a disposable **local** MySQL/MariaDB
account allowed to create/drop test databases. The fixture only creates random
`pbin_ci_<24 hex>` databases and drops the exact database it created. It refuses
non-local database hosts and never reuses an existing site/database. Do not
supply production credentials. Logs omit wp-config.php and database dumps.

```
bash wordpress/ci/check-unit.sh
mkdir -p /tmp/pbin-check
REVISION=$(git rev-parse HEAD)
python3 wordpress/tools/package.py --source wordpress/pbin \
  --revision "$REVISION" --output /tmp/pbin-check/pbin.zip > /tmp/pbin-check/build.json
DIGEST=$(python3 -c 'import json; print(json.load(open("/tmp/pbin-check/build.json"))["artifact_sha256"])')
python3 wordpress/tools/package.py --verify /tmp/pbin-check/pbin.zip \
  --sha256 "$DIGEST" --revision "$REVISION" --extract-to /tmp/pbin-check/tested
npm --prefix e2e ci --ignore-scripts
(cd e2e && npx --no-install playwright install --with-deps chromium)
PBIN_WP_CORE_DIR=/path/to/pristine-wordpress \
PBIN_TEST_PLUGIN_DIR=/tmp/pbin-check/tested/pbin \
PBIN_TEST_ARTIFACT=/tmp/pbin-check/pbin.zip \
PBIN_TEST_ARTIFACT_SHA256="$DIGEST" \
PBIN_TEST_DB_PASSWORD=disposable-local-test-password \
bash wordpress/ci/run-fixture.sh bash wordpress/ci/run-contracts.sh
```

Choose a new extraction directory for each run: the verifier rejects overwrite.
`PHP_BIN` can select an installed PHP executable. The local fixture accepts
`PBIN_TEST_DB_USER`, `PBIN_TEST_DB_HOST` (localhost only),
`PBIN_TEST_DB_PORT`, and `PBIN_WP_TEST_PORT`. It does not download/install tools.
To smoke-test canonical `/paste` behavior, run a second fixture with
`PBIN_TEST_BASE_PATH=/paste PBIN_TEST_EDITOR_AT_BASE=1` and command
`node --test wordpress/ci/canonical-http-contract.test.mjs`.

## Gates and supported test matrix

The checked-in workflow uses exact source SHA checkout, pinned actions, Node
22.14.0, Python 3.12.10, lockfile-pinned Playwright 1.63.0/Chromium, MySQL 8.4.4,
and real WordPress **7.1.3** at
`fc9832bef919c2a08541248db23af90d14ffb082`, verified against the official GitHub
tag and the observed Wasmer core source. The observed hosting runtime is
PHP 8.3.31. System PHP 8.3 in CI receives Ubuntu 24.04 security updates, so its
exact patch version is logged and can differ. This does not certify Wasm32 or
the Wasmer host's extension/configuration limits. The earlier 6.8.3 compatibility
pin is no longer the required target gate.

1. PHP syntax, route/template/script checks, platform bounds, autosave ordering,
   failure/retry/navigation helpers, tenant context/browser-storage unit tests,
   package validation, reproducibility and negative lifecycle tests.
2. Build twice, compare ZIP bytes, verify archive + file hashes, and extract the
   exact ZIP for every real runtime test. The ZIP is not rebuilt for promotion.
3. Independent upstream HTTP contracts: create/PUT/raw, UTF-8/large documents,
   root/HEAD/language, snapshots/history, diffs, Markdown and errors. New checks
   cover packaged asset MIME/isolation, method compatibility and no WebSocket.
4. Separate real WP/MySQL processes interleave two tenants' CRUD, immutable
   snapshots, options, schema and rate-limit rows, including negative cross-IDs.
5. A real MU loader serves A/B from the original package. A synthetic upgrade
   changes A's PHP header and CSS bytes, verifies B unchanged, pins old assets,
   then rolls back A without discarding its data. The synthetic archive is
   local test material only and is **never retained as a release artifact**.
6. Chromium runs all current editor/runner specs, now against HTTP autosave,
   plus failure/retry/unsaved navigation, edits during saves, and two previews
   in one browser profile. JavaScript, TypeScript, Python, Ruby, Scheme,
   Clojure, shell, C++, JSX, Mermaid, MiniZinc, OCaml, Picat and TLA+ remain covered
   by the current runner suite. Its language-picker matrix test prevents
   silently dropping an enabled runner. No Firefox/WebKit result is implied.
7. A second real site verifies `/paste` canonical routing, legacy alias,
   language/ID handling, snapshots and ordinary WordPress home/login/REST.
8. Only then does a separate `needs: [test]` job retain the same digest and
   source revision. Logs have seven-day retention; packages fourteen days.

Current gaps: native PHP64 cannot certify Wasm32 PHP, target Wasmer extensions,
hosting limits or production configuration parity. Third-party runtime
CDNs remain external dependencies. Experimental Go/Linux/Lean/Rust/etc. branches
have their own readiness gaps and are not implicitly part of this baseline.

## Trust boundary: deployment intentionally absent

PR tests are secretless with read-only repository permissions, disabled checkout
credential persistence, bounded concurrency and no `pull_request_target`.
There is no deploy step, deploy token, SSH/WP password, or hosted installer in
this workflow. A passing same-run artifact is not sufficient authorization to
execute arbitrary branch PHP on shared staging.

Before enabling a separate trusted installer, verify source repository and
trusted same-repository ref, exact current PR head, trusted workflow/run success,
artifact ID/source SHA/digest, explicit expected-state-token compare-and-swap,
approved environment/access and a working Wasmer installation/execution route.
The token must be captured for the authorized intent and rotated on every real
state change; an active SHA alone cannot fence close or rollback/ABA races. A
controller must reconcile close/install conflicts after rechecking current PR
state. Wasmer shared-volume locking is unproven; hosted authoritative mutation
state is expected to use MySQL transactions, not these local `flock` checks.
Never check out or execute PR scripts in a privileged workflow. Untrusted forks
may produce test reports but must never reach shared staging. Stale-head,
wrong-digest and failed-gate attempts must be denied. This host-specific path,
its credentials/access approval, and an end-to-end hosted success are still
pending; no fake deploy-ready YAML has been supplied.

Official pin evidence was verified via GitHub refs for actions/checkout v4.2.2,
actions/setup-node v4.4.0, actions/setup-python v5.6.0,
actions/upload-artifact v4.6.2 and actions/download-artifact v4.3.0.
