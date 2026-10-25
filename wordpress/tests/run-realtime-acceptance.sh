#!/usr/bin/env bash
# Extends the HTTP fixture within the same process/network namespace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PBIN_WP_AFTER_HTTP="$ROOT/wordpress/tests/realtime-fixture.sh"
exec bash "$ROOT/wordpress/tests/run-http-acceptance.sh"
