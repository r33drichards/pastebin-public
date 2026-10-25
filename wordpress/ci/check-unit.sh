#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PHP="${PHP_BIN:-php}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pbin-unit.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
while IFS= read -r -d '' file; do "$PHP" -l "$file" >/dev/null; done < <(find wordpress/pbin wordpress/preview wordpress/ci wordpress/tests -type f -name '*.php' -print0)
"$PHP" wordpress/tests/routes.php
"$PHP" wordpress/tests/helpers.php "$WORK/templates.json"
node wordpress/tests/template-syntax.cjs "$WORK/templates.json"
"$PHP" wordpress/tests/platform-compat.php
node wordpress/tests/single-user-editor.cjs
node wordpress/tests/jsx-runner.cjs
node wordpress/tests/effect-starter.cjs
"$PHP" wordpress/tests/preview-tenancy.php
"$PHP" wordpress/tests/preview-bootstrap-state.php
node wordpress/tests/preview-storage.cjs
test -f wordpress/tests/test_preview_packages.py
python3 -m unittest discover -s wordpress/tests -p 'test_preview_packages.py'
echo 'PASS: required syntax and unit gates (not an integration/browser result)'
