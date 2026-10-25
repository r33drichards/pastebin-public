#!/usr/bin/env bash
# Required hosted integration gate; run only inside the disposable fixture.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PHP="${PHP_BIN:-php}"
: "${PBIN_TEST_DB_NAME:?Run inside wordpress/ci/run-fixture.sh}"
: "${PBIN_WORDPRESS_LOAD:?Run inside wordpress/ci/run-fixture.sh}"
export PBIN_TEST_ALLOW_DATABASE_MUTATION=1
"$PHP" "$ROOT/wordpress/migration/tests/mysql.php"
