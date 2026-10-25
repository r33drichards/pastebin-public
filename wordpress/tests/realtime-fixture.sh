# Sourced by the disposable HTTP fixture; uses its actual WP/database/servers.
"${PHP[@]}" -r "require '$WORK/site/wp-load.php'; require_once '$ROOT/wordpress/pbin/includes/ot.php'; require_once '$ROOT/wordpress/pbin/includes/collab-store.php'; PBIN_CollabStore::install();"
export PBIN_WORDPRESS_LOAD="$WORK/site/wp-load.php"
export PBIN_ALLOWED_ORIGINS="http://127.0.0.1:$PORT"
export PBIN_COLLAB_LISTEN="websocket://127.0.0.1:18825"
export PBIN_COLLAB_PID="$WORK/companion.pid" PBIN_COLLAB_LOG="$WORK/companion.log"
export PBIN_COMPOSER_AUTOLOAD="${PBIN_COMPOSER_AUTOLOAD:-$TC/workerman/vendor/autoload.php}"
"${PHP[@]}" -d extension=posix.so "$ROOT/wordpress/companion/server.php" start >"$WORK/companion-output.log" 2>&1 &
SOCKET_PID=$!
sleep 1
set +e
PBIN_ACCEPTANCE_URL="http://127.0.0.1:$PORT" PBIN_ACCEPTANCE_WS_URL="ws://127.0.0.1:18825" timeout 30 node "$ROOT/acceptance/websocket-http-contract.cjs"
RESULT=$?
kill "$SOCKET_PID" 2>/dev/null; wait "$SOCKET_PID" 2>/dev/null
set -e
if [[ $RESULT != 0 ]]; then cat "$WORK/companion-output.log"; cat "$WORK/companion.log"; return "$RESULT"; fi
