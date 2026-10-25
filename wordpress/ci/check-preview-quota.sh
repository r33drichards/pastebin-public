#!/usr/bin/env bash
# Guarded hosted integration only, inside the disposable WordPress fixture.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PHP="${PHP_BIN:-php}"
: "${PBIN_TEST_DB_NAME:?Run inside the disposable WordPress fixture}"
: "${PBIN_WORDPRESS_LOAD:?Run inside the disposable WordPress fixture}"
export PBIN_TEST_DATABASE_NAME="$PBIN_TEST_DB_NAME" PBIN_TEST_ALLOW_DATABASE_MUTATION=1
"$PHP" "$ROOT/wordpress/tests/preview-quota-integration.php" bytes pr_920002
"$PHP" "$ROOT/wordpress/tests/preview-quota-integration.php" rows pr_920003
