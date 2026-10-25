#!/usr/bin/env bash
# Run every process in one invocation (some executors isolate network namespaces
# between commands). Uses a real WordPress core and MariaDB, not a mocked wpdb.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${PBIN_WP_TOOLCHAIN:?Set PBIN_WP_TOOLCHAIN to the extracted toolchain directory (root/ and wordpress/)}"
TC="$(cd "$PBIN_WP_TOOLCHAIN" && pwd)"
export LD_LIBRARY_PATH="$TC/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PBIN_RATE_LIMIT=1000 PBIN_COMPLETION_RATE_LIMIT=1000
unset HF_TOKEN COMPLETION_FALLBACK_URL OPENAPIKEY
PHP=("$TC/root/usr/bin/php8.4" -n -d "extension_dir=$TC/root/usr/lib/php/20240924" -d extension=mysqlnd.so -d extension=mysqli.so -d extension=dom.so -d extension=mbstring.so -d extension=xml.so)
MYSQL="$TC/root/usr/bin/mariadb"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pbin-wp-acceptance.XXXXXX")"
PORT="${PBIN_WP_TEST_PORT:-18081}"
DB_PID=''; PHP_PID=''
cleanup() {
    status=$?
    [[ -z "$PHP_PID" ]] || kill "$PHP_PID" 2>/dev/null || true
    [[ -z "$DB_PID" ]] || kill "$DB_PID" 2>/dev/null || true
    [[ -z "$PHP_PID" ]] || wait "$PHP_PID" 2>/dev/null || true
    [[ -z "$DB_PID" ]] || wait "$DB_PID" 2>/dev/null || true
    if [[ $status != 0 ]]; then
        echo '--- MariaDB ---'; tail -60 "$WORK/mysql.log" 2>/dev/null || true
        echo '--- PHP ---'; tail -60 "$WORK/php.log" 2>/dev/null || true
        echo '--- WordPress ---'; tail -60 "$WORK/wp-debug.log" 2>/dev/null || true
    fi
    echo "Isolated fixture and logs retained at $WORK"
    exit "$status"
}
trap cleanup EXIT
cp -a "$TC/wordpress" "$WORK/site"
ln -s "$ROOT/wordpress/pbin" "$WORK/site/wp-content/plugins/pbin"
"$TC/root/usr/bin/mariadb-install-db" --no-defaults --basedir="$TC/root/usr" --datadir="$WORK/mysql" --auth-root-authentication-method=normal --skip-test-db >"$WORK/mysql-install.log" 2>&1
"$TC/root/usr/sbin/mariadbd" --no-defaults --basedir="$TC/root/usr" --datadir="$WORK/mysql" --socket= --bind-address=127.0.0.1 --port=18306 --pid-file="$WORK/mysql.pid" --log-error="$WORK/mysql.log" &
DB_PID=$!
for _ in $(seq 1 100); do
    if "$MYSQL" --no-defaults --protocol=TCP --host=127.0.0.1 --port=18306 -uroot -e 'SELECT 1' >/dev/null 2>&1; then break; fi
    kill -0 "$DB_PID" 2>/dev/null || { echo 'MariaDB failed to start'; exit 1; }
    sleep 0.1
done
"$MYSQL" --no-defaults --protocol=TCP --host=127.0.0.1 --port=18306 -uroot -e 'CREATE DATABASE pbin_acceptance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
cat >"$WORK/site/wp-config.php" <<PHP
<?php
// Disposable acceptance installation; never use this configuration in production.
define('DB_NAME', 'pbin_acceptance');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', '127.0.0.1:18306');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
define('WP_HOME', 'http://127.0.0.1:$PORT');
define('WP_SITEURL', 'http://127.0.0.1:$PORT');
define('WP_DEBUG', true);
define('WP_DEBUG_DISPLAY', false);
define('WP_DEBUG_LOG', '$WORK/wp-debug.log');
define('WP_AUTO_UPDATE_CORE', false);
define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);
define('PBIN_WP_BASE_PATH', '');
\$table_prefix = 'wp_';
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
PHP
cat >"$WORK/install.php" <<PHP
<?php
define('WP_INSTALLING', true);
function wp_mail(\$to, \$subject, \$message, \$headers = '', \$attachments = []) { return true; }
require '$WORK/site/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
wp_install('pbin acceptance', 'pbin-test-admin', 'nobody@example.invalid', false, '', 'fixture-only-password');
\$result = activate_plugin('pbin/pbin.php');
if (is_wp_error(\$result)) throw new RuntimeException(\$result->get_error_message());
echo "WordPress and pbin installed\n";
PHP
"${PHP[@]}" "$WORK/install.php" >"$WORK/install.log" 2>&1
grep -q 'WordPress and pbin installed' "$WORK/install.log" || { cat "$WORK/install.log"; exit 1; }
"${PHP[@]}" -S "127.0.0.1:$PORT" -t "$WORK/site" "$WORK/site/index.php" >"$WORK/php.log" 2>&1 &
PHP_PID=$!
for _ in $(seq 1 100); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    kill -0 "$PHP_PID" 2>/dev/null || { echo 'PHP server failed to start'; exit 1; }
    sleep 0.1
done
PBIN_ACCEPTANCE_URL="http://127.0.0.1:$PORT" node --test "$ROOT/acceptance/http-contract.test.mjs"
echo 'HTTP-only acceptance finished; this does not verify realtime or language runners.'

if [[ -n "${PBIN_WP_AFTER_HTTP:-}" ]]; then source "$PBIN_WP_AFTER_HTTP"; fi
