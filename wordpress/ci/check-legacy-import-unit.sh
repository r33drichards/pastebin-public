#!/usr/bin/env bash
# No sockets, WordPress installation, MySQL, production data, or implicit DB path.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PHP="${PHP_BIN:-php}"
GO="${GO_BIN:-go}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pbin-import-unit.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GOTOOLCHAIN=local
"$GO" version
for file in "$ROOT"/wordpress/migration/*.php "$ROOT"/wordpress/migration/tests/*.php; do "$PHP" -l "$file" >/dev/null; done
# Archived Bolt is isolated to this normal, synthetic-only writer subprocess.
# Never disable checkptr, and never link that writer into the production reader.
export PBIN_LEGACY_BOLT="$WORK/legacy.db"
(cd "$ROOT/wordpress/migration/tests/legacy-writer" && "$GO" mod verify && "$GO" run -mod=readonly . "$PBIN_LEGACY_BOLT")
chmod 0400 "$PBIN_LEGACY_BOLT"
(cd "$ROOT/wordpress/migration/bolt-export" && "$GO" mod verify && PBIN_SYNTHETIC_EXPORT="$WORK/synthetic.json" "$GO" test -mod=readonly -count=1 ./... && "$GO" test -race -mod=readonly -count=1 ./... && "$GO" vet ./...)
(cd "$ROOT/wordpress/migration/bolt-export" && "$GO" build -mod=readonly -o "$WORK/pbin-bolt-export" .)
"$WORK/pbin-bolt-export" --backup "$PBIN_LEGACY_BOLT" --out "$WORK/legacy-export.json" > "$WORK/legacy-export-receipt.json"
if (cd "$WORK" && ./pbin-bolt-export >stdout 2>stderr); then echo 'Exporter accepted an implicit database'; exit 1; fi
test ! -e "$WORK/pbin.db"
if "$WORK/pbin-bolt-export" --backup "$PBIN_LEGACY_BOLT" --out "$WORK/legacy-export.json" >"$WORK/stdout" 2>"$WORK/stderr"; then echo 'Exporter overwrote existing output'; exit 1; fi
"$PHP" "$ROOT/wordpress/migration/tests/importer.php" "$WORK/legacy-export.json"
"$PHP" "$ROOT/wordpress/migration/tests/importer.php" "$WORK/synthetic.json"
"$PHP" "$ROOT/wordpress/migration/tests/importer.php" "$ROOT/wordpress/migration/tests/synthetic.json"
"$PHP" "$ROOT/wordpress/migration/tests/bootstrap.php"
"$PHP" "$ROOT/wordpress/migration/import.php" --help >/dev/null
if "$PHP" "$ROOT/wordpress/migration/import.php" --apply >"$WORK/stdout" 2>"$WORK/stderr"; then echo 'Unsafe CLI accepted incomplete apply'; exit 1; fi
test ! -s "$WORK/stdout"
echo 'PASS: offline migration unit gates (not a real MySQL or production data receipt)'
