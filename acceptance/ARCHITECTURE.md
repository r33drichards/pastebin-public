# WordPress parity design and release gates

## Retain the client

Monaco, editor layout, client-side runners, workers, stdin/output, sharing,
snapshots and OT client remain JavaScript/Wasm. PHP replaces server rendering,
HTTP handlers, optional completion proxy and persistence, not language execution.
No submitted code executes in the WordPress PHP interpreter.

## WordPress HTTP and MySQL

The plugin uses a scoped /pbin mount so it cannot take over the host's homepage,
posts or wp-admin. An empty mount is permitted only in isolated acceptance tests.
Tables use the actual wpdb prefix and utf8mb4, with activation/versioned migration.
SQL statements are prepared. Uninstall does not erase user data automatically.
Anonymous unlisted-ID editing is preserved; it must not be presented as private
or authenticated storage. Body limits, rate limiting and deliberate retention
policy are needed to prevent disk exhaustion. Rate-limit counters need bounded
cleanup, not indefinite accumulation. Host-wide COOP/COEP is avoided: headers
are applied to the application pages/assets, and third-party worker dependencies
must satisfy cross-origin isolation. An iframe alone is not full plugin parity.

## Realtime cannot disappear in a PHP port

The existing /collab endpoint is a persistent WebSocket OT authority, with
revisions, history, reconnect keys/sequence deduplication, presence, cursors,
language broadcast, bounded messages and debounced saves. WordPress request
handlers do not provide a long-running WebSocket event loop. Polling is NOT an
accepted replacement. Without the companion reverse proxy, /collab returns 501.

This PHP implementation packages a Workerman-based companion, but its host
must run a supervised long-lived PHP CLI process and route WebSocket upgrades.
Whether the target hosting platform supports this must be verified. Do not
promise it can be installed there as a normal plugin alone. A retained Go socket
sidecar is another option, but does not achieve a complete PHP backend port.

A companion alone is insufficient: HTTP PUT, snapshots and websocket edits need
one ordered authority. Recommended design is a shared transaction boundary on a
MySQL room row, with revisioned operation history and per-client last-sequence
state. Every writer locks the room row, validates its base revision, records the
transformed operation and changes content atomically. A single socket worker
consumes committed changes; additional workers require fanout coordination.
Do not let a delayed in-memory socket save overwrite newer HTTP writes.

The PHP OT core uses UTF-16 code units like JavaScript and the current Go server;
PHP byte indexing or Unicode-codepoint indexing would silently corrupt offsets.
Malformed lengths, oversized operations and stale history must reject safely.
Server timestamps and IDs are nondeterministic test outputs; compare relations
and types, not exact values. Browser screenshots support but do not replace
convergence, persistence and error assertions.

## Release gate

The same independent HTTP, direct WebSocket and browser suites must pass against
both pinned Go and WordPress. Also require restart durability, concurrent HTTP
vs socket operations, duplicate/reconnect handling, scoped/subdirectory installs,
all original runner assets and actual language executions, and schema upgrades.
No review-ready or production-ready claim before these gates pass. Current green
HTTP and direct WebSocket suites are progress, not the complete product.

References:
- https://developer.wordpress.org/plugins/creating-tables-with-plugins/
- https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/
- https://github.com/walkor/workerman
