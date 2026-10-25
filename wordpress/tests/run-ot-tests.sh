#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PHP="${PHP_BIN:-php}"
GO="${GO_BIN:-go}"
WORK="$(mktemp -d /tmp/pbin-ot-tests.XXXXXX)"
export GOCACHE="${GOCACHE:-$WORK/go-cache}"
"$PHP" -n -l "$ROOT/wordpress/pbin/includes/ot.php"
"$PHP" -n "$ROOT/wordpress/tests/ot.php" "$WORK/corpus.jsonl"
cp "$ROOT/collab_ot.go" "$WORK/collab_ot.go"
cp "$ROOT/wordpress/tests/ot-reference.go" "$WORK/main.go"
"$GO" run "$WORK/collab_ot.go" "$WORK/main.go" <"$WORK/corpus.jsonl" >"$WORK/reference.jsonl"
"$PHP" -n "$ROOT/wordpress/tests/compare-ot.php" "$WORK/corpus.jsonl" "$WORK/reference.jsonl"
echo "OT corpus and reference output retained at $WORK"
