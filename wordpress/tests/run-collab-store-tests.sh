#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${PBIN_WP_TOOLCHAIN:?Set PBIN_WP_TOOLCHAIN to the extracted toolchain directory}"
: "${PBIN_WP_FIXTURE:?Set PBIN_WP_FIXTURE to a retained run-http-acceptance.sh fixture directory}"
TC="$(cd "$PBIN_WP_TOOLCHAIN" && pwd)"
WORK="$(cd "$PBIN_WP_FIXTURE" && pwd)"
[[ "$WORK" == /tmp/pbin-wp-acceptance.* && -d "$WORK/mysql" && -f "$WORK/site/wp-config.php" ]] || { echo 'Refusing non-test fixture'; exit 1; }
export LD_LIBRARY_PATH="$TC/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
PHP=("$TC/root/usr/bin/php8.4" -n -d "extension_dir=$TC/root/usr/lib/php/20240924" -d extension=mysqlnd.so -d extension=mysqli.so -d extension=dom.so -d extension=mbstring.so -d extension=xml.so)
"$TC/root/usr/sbin/mariadbd" --no-defaults --basedir="$TC/root/usr" --datadir="$WORK/mysql" --socket= --bind-address=127.0.0.1 --port=18306 --pid-file="$WORK/mysql.pid" --log-error="$WORK/mysql.log" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do
    if "$TC/root/usr/bin/mariadb" --no-defaults --protocol=TCP --host=127.0.0.1 --port=18306 -uroot -e 'SELECT 1' >/dev/null 2>&1; then break; fi
    kill -0 "$PID" 2>/dev/null || { tail -30 "$WORK/mysql.log"; exit 1; }
    sleep 0.1
done
"${PHP[@]}" "$ROOT/wordpress/tests/collab-store.php" "$WORK/site/wp-load.php"
