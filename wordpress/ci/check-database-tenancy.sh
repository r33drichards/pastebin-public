#!/usr/bin/env bash
# Real database tests, not the source/filesystem mock suite.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PHP="${PHP_BIN:-php}"
: "${PBIN_TEST_DB_NAME:?Run within the disposable WordPress fixture}"
: "${PBIN_WORDPRESS_LOAD:?Run within the disposable WordPress fixture}"
export PBIN_TEST_DATABASE_NAME="$PBIN_TEST_DB_NAME" PBIN_TEST_ALLOW_DATABASE_MUTATION=1
TEST="$ROOT/wordpress/tests/preview-tenancy.php"
input='{"run_id":"same-client-and-route"}'
a="$("$PHP" "$TEST" --wordpress-context=pr_910001 write "$input")"
b="$("$PHP" "$TEST" --wordpress-context=pr_910002 write "$input")"
"$PHP" "$TEST" --wordpress-context=pr_910001 read "$a"
"$PHP" "$TEST" --wordpress-context=pr_910002 read "$b"
"$PHP" "$TEST" --wordpress-context=pr_910001 expect-missing "$b"
"$PHP" "$TEST" --wordpress-context=pr_910002 expect-missing "$a"
"$PHP" "$TEST" --wordpress-context=pr_910001 read "$a"
echo 'PASS: real MySQL interleaved tenant CRUD, snapshots, options and rate-limit isolation'
