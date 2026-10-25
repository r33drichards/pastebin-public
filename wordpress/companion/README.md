# PHP realtime companion (in progress)

Full WebSocket parity requires a supervised long-running PHP CLI process, not a
WordPress PHP-FPM request. Dependencies are pinned by composer.lock. Install with
`composer install --no-dev`; PHP needs pcntl, posix, mbstring, mysqli and sockets
as required by Workerman/the host. Do not expose an unauthenticated admin API.

The companion must use the same WordPress installation/database as HTTP and a
single authoritative transaction sequence. A reverse proxy must route /pbin/collab
WebSocket upgrades to it, while ordinary /pbin routes remain with WordPress.
Only document-content collaboration is public, matching the existing unlisted
paste semantics. Allowed browser origins must be explicitly configured.

Direct protocol acceptance passes against real WordPress/MariaDB, including
concurrent edits, UTF-16 offsets, presence, reconnect deduplication and HTTP
replacements. Browser execution, crash recovery and hosting remain release gates. Do not enable
this on the production WordPress site until those gates are green.

For an isolated install, set PBIN_WORDPRESS_LOAD to its wp-load.php and
PBIN_ALLOWED_ORIGINS to exact comma-separated browser origins. Optionally set
PBIN_COLLAB_LISTEN (default websocket://127.0.0.1:8825). Run php server.php start.
Use one worker only; multiple workers require explicit event fanout.
