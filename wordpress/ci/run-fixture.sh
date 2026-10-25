#!/usr/bin/env bash
# System PHP + local MySQL/MariaDB. No Go server, Nix, WP-CLI, or extracted toolchain.
# Usage: PBIN_WP_CORE_DIR=/pristine/wordpress bash wordpress/ci/run-fixture.sh COMMAND [ARGS...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
PHP="${PHP_BIN:-php}"
: "${PBIN_WP_CORE_DIR:?Set PBIN_WP_CORE_DIR to pristine WordPress core (without wp-config.php)}"
CORE="$(cd "$PBIN_WP_CORE_DIR" && pwd -P)"
PLUGIN="$(cd "${PBIN_TEST_PLUGIN_DIR:-$ROOT/wordpress/pbin}" && pwd -P)"
export PBIN_TEST_PLUGIN_DIR="$PLUGIN"
[[ -f "$CORE/wp-load.php" && -f "$CORE/wp-admin/includes/upgrade.php" && ! -e "$CORE/wp-config.php" ]] || { echo 'Expected pristine WordPress core'; exit 1; }
[[ -f "$PLUGIN/pbin.php" && -f "$PLUGIN/runtime.php" ]] || { echo 'Expected a complete pbin plugin'; exit 1; }
[[ $# -gt 0 ]] || { echo 'Supply the test command to run inside the fixture'; exit 1; }
"$PHP" -r 'if (PHP_VERSION_ID < 80100 || !extension_loaded("mysqli") || !extension_loaded("mbstring") || !extension_loaded("dom")) { fwrite(STDERR, "PHP 8.1+ with mysqli, mbstring and DOM is required\n"); exit(1); }'
PORT="${PBIN_WP_TEST_PORT:-18081}"
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -gt 1023 && "$PORT" -lt 65536 ]] || { echo 'Invalid HTTP test port'; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pbin-wp-ci.XXXXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
export PBIN_WP_FIXTURE="$WORK" PBIN_WP_TEST_SITE="$WORK/site"
export PBIN_TEST_DB_HOST="${PBIN_TEST_DB_HOST:-127.0.0.1}" PBIN_TEST_DB_PORT="${PBIN_TEST_DB_PORT:-3306}"
export PBIN_TEST_DB_USER="${PBIN_TEST_DB_USER:-root}" PBIN_TEST_DB_PASSWORD="${PBIN_TEST_DB_PASSWORD:-}"
export PBIN_TEST_DB_NAME="pbin_ci_$("$PHP" -r 'echo bin2hex(random_bytes(12));')"
export PBIN_ACCEPTANCE_URL="http://127.0.0.1:$PORT" PBIN_BASE_URL="http://127.0.0.1:$PORT"
export PBIN_WORDPRESS_LOAD="$WORK/site/wp-load.php"
export PBIN_RATE_LIMIT=1000 PBIN_COMPLETION_RATE_LIMIT=1000
unset HF_TOKEN COMPLETION_FALLBACK_URL COMPLETION_FALLBACK_TOKEN OPENAPIKEY
# BEGIN guarded WordPress installer fixture
if [[ "${PBIN_INSTALLER_GATE:-}" == 1 ]]; then
    [[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]] || { echo 'WordPress installer gate requires the fresh hosted fixture'; exit 1; }
    : "${PBIN_INSTALLER_ZIP:?Provide the standard WordPress installer ZIP}"
    : "${PBIN_INSTALLER_RECEIPT:?Provide the installer binding receipt}"
    : "${PBIN_INSTALLER_CANONICAL:?Provide the canonical envelope}"
    : "${PBIN_INSTALLER_CANONICAL_SHA256:?Provide the canonical SHA-256}"
    : "${PBIN_SOURCE_SHA:?Provide the exact source revision}"
    python3 "$ROOT/wordpress/tools/wordpress_installer.py" verify \
        --installer "$PBIN_INSTALLER_ZIP" --receipt "$PBIN_INSTALLER_RECEIPT" \
        --canonical "$PBIN_INSTALLER_CANONICAL" --canonical-sha256 "$PBIN_INSTALLER_CANONICAL_SHA256" \
        --revision "$PBIN_SOURCE_SHA"
fi
# END guarded WordPress installer fixture
SERVER_PID='' DB_CREATED=0
# BEGIN bounded fixture diagnostics (also exercised without a server by unit tests)
fixture_failure_logs() {
    if [[ "${PBIN_CONTROLLER_GATE:-}" == 1 ]]; then
        echo 'Authenticated controller fixture failed; raw logs withheld'
        return
    fi
    for log in install php wp-debug; do echo "--- $log ---"; tail -80 "$WORK/$log.log" 2>/dev/null || true; done
}
# END bounded fixture diagnostics
# BEGIN bounded fixture POST setting
POST_MAX_SIZE=16M
if [[ "${PBIN_CONTROLLER_GATE:-}" == 1 ]]; then
    [[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Controller POST setting requires the hosted fixture'; exit 1; }
    # Raw application/zip also enters PHP's default POST reader. Match the
    # loopback proxy's bounded transport ceiling, not a production PHP setting.
    POST_MAX_SIZE=70M
fi
# END bounded fixture POST setting
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
    if [[ "$DB_CREATED" == 1 ]]; then "$PHP" "$ROOT/wordpress/ci/database.php" drop || { echo 'Disposable DB cleanup failed'; status=1; }; fi
    if [[ "$status" != 0 ]]; then fixture_failure_logs; fi
    if [[ -n "${PBIN_TEST_RESULTS_DIR:-}" ]]; then
        mkdir -p "$PBIN_TEST_RESULTS_DIR"
        # Do not upload wp-config.php, database dumps, cookies, or arbitrary site files.
        for log in install php wp-debug; do [[ ! -f "$WORK/$log.log" ]] || cp "$WORK/$log.log" "$PBIN_TEST_RESULTS_DIR/$log.log"; done
    fi
    echo "Fixture logs retained at $WORK (database removed if cleanup succeeded)"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$PHP" "$ROOT/wordpress/ci/database.php" create
DB_CREATED=1
mkdir "$WORK/site"
cp -a "$CORE/." "$WORK/site/"
mkdir -p "$WORK/site/wp-content/plugins"
[[ ! -e "$WORK/site/wp-content/plugins/pbin" ]] || { echo 'Pristine core unexpectedly contains pbin'; exit 1; }
# Only the dedicated gate installs with WordPress itself; never pre-place pbin.
if [[ "${PBIN_INSTALLER_GATE:-}" != 1 ]]; then
    ln -s "$PLUGIN" "$WORK/site/wp-content/plugins/pbin"
fi
if [[ -n "${PBIN_TEST_ARTIFACT:-}" ]]; then
    : "${PBIN_TEST_ARTIFACT_SHA256:?Provide the exact test artifact SHA-256}"
    export PBIN_TEST_PREVIEW_ROOT="$WORK/previews"
    python3 "$ROOT/wordpress/ci/prepare-previews.py"
fi
"$PHP" "$ROOT/wordpress/ci/install.php" >"$WORK/install.log" 2>&1
grep -q '^PASS: real WordPress' "$WORK/install.log" || { fixture_failure_logs; exit 1; }
"$PHP" -d "post_max_size=$POST_MAX_SIZE" -d memory_limit=256M -S "127.0.0.1:$PORT" -t "$WORK/site" "$ROOT/wordpress/ci/router.php" >"$WORK/php.log" 2>&1 &
SERVER_PID=$!
ready=0
HEALTH_URL="$PBIN_ACCEPTANCE_URL${PBIN_TEST_BASE_PATH:-}/health"
for _ in $(seq 1 100); do
    if curl --fail --silent --max-time 2 "$HEALTH_URL" >"$WORK/health.txt" && [[ "$(cat "$WORK/health.txt")" == OK ]]; then ready=1; break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || { echo 'PHP HTTP fixture failed to start'; exit 1; }
    sleep 0.1
done
[[ "$ready" == 1 ]] || { echo 'PHP HTTP fixture never became ready'; exit 1; }
"$@"
