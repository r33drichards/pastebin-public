#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
PHP="${PHP_BIN:-php}"
[[ "${PBIN_CONTROLLER_GATE:-}" == 1 && "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Disposable hosted controller gate required'; exit 1; }
: "${PBIN_WP_FIXTURE:?Run inside the second disposable fixture}"
: "${PBIN_TEST_DB_NAME:?Run inside the second disposable fixture}"
[[ "$PBIN_WP_FIXTURE" == */pbin-wp-ci.* && "$PBIN_TEST_DB_NAME" =~ ^pbin_ci_[a-f0-9]{24}$ ]] || { echo 'Refusing non-disposable fixture'; exit 1; }
[[ "$(cd "$PBIN_WP_FIXTURE" && pwd -P)" == "$PBIN_WP_FIXTURE" && "$(cd "$PBIN_WP_FIXTURE/site" && pwd -P)" == "$PBIN_WP_FIXTURE/site" && ! -L "$PBIN_WP_FIXTURE/site/wp-config.php" ]] || { echo 'Expected canonical fixture paths'; exit 1; }
export PBIN_TEST_ALLOW_DATABASE_MUTATION=1
PROXY_PID=''
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$PROXY_PID" ]]; then kill "$PROXY_PID" 2>/dev/null || true; wait "$PROXY_PID" 2>/dev/null || true; fi
    # Exact files created by this test only. No credentials/configuration survive
    # in the retained fixture tree; run-fixture.sh independently drops its DB.
    if ! rm -f "$PBIN_WP_FIXTURE/controller-secrets.json" "$PBIN_WP_FIXTURE/controller-key.pem" "$PBIN_WP_FIXTURE/controller-cert.pem" "$PBIN_WP_FIXTURE/site/wp-config.php"; then
        echo 'Disposable credential cleanup failed'; status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$PHP" -r 'if (!class_exists("ZipArchive")) { fwrite(STDERR, "Native ZipArchive required\n"); exit(1); }'
python3 "$ROOT/wordpress/ci/prepare-controller-artifacts.py"
"$PHP" "$ROOT/wordpress/ci/prepare-controller-site.php" prepare
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=controller-fixture.invalid' \
  -addext 'subjectAltName=DNS:controller-fixture.invalid' \
  -keyout "$PBIN_WP_FIXTURE/controller-key.pem" -out "$PBIN_WP_FIXTURE/controller-cert.pem" >/dev/null 2>&1
python3 "$ROOT/wordpress/ci/controller-https-proxy.py" >"$PBIN_WP_FIXTURE/controller-proxy.log" 2>&1 &
PROXY_PID=$!
ready=0
for _ in $(seq 1 100); do
    if grep -q '^READY$' "$PBIN_WP_FIXTURE/controller-proxy.log"; then ready=1; break; fi
    kill -0 "$PROXY_PID" 2>/dev/null || { echo 'Loopback fixture HTTPS proxy failed'; exit 1; }
    sleep 0.1
done
[[ "$ready" == 1 ]] || { echo 'Loopback fixture HTTPS proxy did not start'; exit 1; }
python3 "$ROOT/wordpress/ci/controller-http-contract.py"
echo 'PASS: real disposable WordPress/MySQL/native-ZIP controller HTTPS/auth gate (not Wasmer deployment)'
