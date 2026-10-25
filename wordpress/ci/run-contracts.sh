#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
: "${PBIN_WORDPRESS_LOAD:?Run inside wordpress/ci/run-fixture.sh}"
: "${PBIN_ACCEPTANCE_URL:?Disposable HTTP fixture required}"
node --test acceptance/http-contract.test.mjs
node --test wordpress/ci/http-contract.test.mjs
bash wordpress/ci/check-database-tenancy.sh
node --test wordpress/ci/preview-http-contract.test.mjs
npm --prefix e2e test
echo 'PASS: real WordPress HTTP and retained Chromium editor/runner gates'
