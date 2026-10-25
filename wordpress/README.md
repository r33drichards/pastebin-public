# Current deployment scope: single-user WordPress editor

The user explicitly dropped WebSocket features for this WordPress port. The plugin
now uses editable Monaco plus serialized HTTP autosave, with failure/retry and
unsaved-navigation protection. Other tabs do not synchronize; the last save wins.
No presence UI, WebSocket client or companion process is enabled by the plugin.
The isolated installation mount is /pbin-wp-test, avoiding existing paste aliases.
Activation creates only the four HTTP storage tables. The earlier OT/companion
prototype and tests below remain research artifacts, not installation requirements.
The Go application and its collaboration implementation are unchanged.

# WordPress PHP/MySQL port

This directory contains an installable WordPress plugin and focused implementation
checks. It is a **parity candidate, not a claim of complete parity**. The independent
HTTP/browser tests live in the repository's `acceptance/` directory and run against
real servers without importing either implementation.

## Install on an isolated test site

Requirements: WordPress 6.4+, PHP 8.1+ with DOM/libxml, mbstring and the normal WordPress MySQL
driver, and MySQL/MariaDB with InnoDB and an `utf8mb4` connection. Copy `pbin/` to
`wp-content/plugins/pbin/` and activate it. Activation creates four site-prefixed
tables through WordPress's migration helper: `pbin_pastes`, `pbin_diffs`,
`pbin_snapshots`, and short-lived hashed `pbin_limits` buckets. There are no posts,
custom post types, serialized user objects, or Dynamo/Bolt dependencies.

The default entry point is `https://your-site.example/pbin-wp-test/`. The host WordPress
home page, REST API, admin, and unrelated paths remain untouched. If WordPress is
installed below `/blog`, the default mount is `/blog/pbin-wp-test/`. To choose another
mount, define `PBIN_WP_BASE_PATH` in `wp-config.php`, for example `/tools/pbin`.
Only an isolated parity-test installation should use an empty path to expose the
original root-level contract. Do not mount at the root of an existing content site.

No rewrite flush is required. Deactivation removes routing immediately and does
not delete saved data. There is deliberately no automatic uninstall data purge.
This initial version does not automatically provision tables across a multisite
network: activate per site and verify that site's tables before use.

## Implemented HTTP/storage surface

All paths below are relative to the chosen mount:

- `/`: a GET creates a fresh room, preserves a valid language, and redirects 303;
  HEAD and other methods do not create a room.
- `/paste`: form POST creates a UUID paste and redirects 301; PUT replaces an
  existing paste; GET displays it; an ID ending in `.txt` returns exact raw UTF-8.
- `/diff`: creation, persistence, and the original Monaco comparison UI.
- `/snapshot`: immutable copies, optional live field overrides (including explicit
  empty values), Unicode names capped at 120 code points, JSON or 303 responses,
  and raw `.txt` access. No update/delete API is provided.
- `/snapshots`: indexed, newest-first metadata listing with stable snapshot links.
- `/html`: sanitized Markdown, tables, fenced code, definition lists and YAML
  title metadata. The PHP parser is not identical to gomarkdown; obscure Markdown,
  MathJax, malformed YAML and automatic heading-ID edge cases need differential
  coverage before claiming exact rendering parity. Unsafe raw HTML is removed;
  metadata titles are escaped even where the reference implementation was not.
- `/complete`: disabled probe and 503 behavior when unconfigured; otherwise ordered
  Hugging Face/fallback requests, UTF-8-safe FIM context limits and special-token
  removal. Server-side title generation remains optional.
- `/health` and `/static/*`: health response and packaged frontend assets, with
  scoped worker/API URLs and cross-origin-isolation headers only on plugin routes.

The MySQL adapter exposes the original operation names in `PBIN_Store`. Records
use Go-style field keys plus `ID` for templates. Creation timestamps are retained
on paste updates. Snapshot timestamps store fixed-width UTC fractions and display
RFC3339 seconds. Listings fetch metadata only and use a compound parent/time index.

## Historical realtime prototype (not installed)

**Ordinary WordPress/PHP-FPM requests do not provide the `/collab` WebSocket server.**
That endpoint returns 501 in this single-user port. The editor is editable and
saves through HTTP; there is no presence or synchronization between users.
The following describes the earlier prototype, which is not enabled by this plugin.

The historical HTTP integration and PHP Workerman companion used transaction-locked room
state. A replacement commits content, revision and history atomically before the
notification hook runs. The companion's server-side change checks are not a
polling browser transport: clients still use the original WebSocket OT protocol.

The companion lives in `wordpress/companion/`. It has passed the independent
protocol scenarios against real WordPress/MariaDB, including concurrent edits,
UTF-16 offsets, presence, reconnect sequence deduplication and persistence.
The host must supervise a PHP CLI process and proxy WebSocket upgrades to it;
ordinary WordPress hosting alone is insufficient. Support on the intended hosting platform has
not been verified, and no production deployment has occurred.

The four original large runtime assets were recovered and checked against the
pinned upstream Git blob hashes. Verify every advertised language runner in a
browser; protocol and HTTP tests are not evidence of full runner execution.

## Configuration and operational security

The original server environment variable names are retained:

- `PBIN_RATE_LIMIT` (default 2 requests/second per direct client address and route).
- `PBIN_COMPLETION_RATE_LIMIT` (default 5 requests/second).
- `HF_TOKEN`, `COMPLETION_HF_URL`, `COMPLETION_MODEL`.
- `COMPLETION_FALLBACK_URL`, `COMPLETION_FALLBACK_TOKEN`,
  `COMPLETION_FALLBACK_MODEL`, `COMPLETION_TIMEOUT_SECONDS`.
- `OPENAPIKEY` enables OpenAI title generation on paste creation.

Keep secrets only in server configuration, not in pasted code, frontend assets,
the database, source control, or URLs. Enabling completion/title providers sends
the associated code/text to those configured third-party services. Defaults make
no inference-provider requests.

Like the reference application, paste endpoints are intentionally anonymous and
possession of a paste UUID allows editing. They are not private WordPress posts
and do not inherit WordPress user permissions. Host the app accordingly and apply
appropriate network/abuse controls. Rate-limit keys are salted hashes; forwarded
IP headers are not trusted. Configure trusted proxy/client addressing outside the
plugin when required. Incoming paths cannot select PHP includes; static routes
validate real paths and extensions. Generated scripts serialize data with JSON
hex escaping, and displayed HTML/metadata use contextual escaping.

## Frontend updates and checks

Run `python3 wordpress/pbin/tools/port_templates.py` from the repository to copy
trusted static assets and regenerate reviewable PHP templates. This build tool
accepts only the small set of known Go-template operations and fails on unknown
syntax. It does not evaluate templates at runtime. Review generated PHP diffs on
upstream changes, especially JavaScript/HTML escaping and scoped endpoints.

Focused checks (PHP on PATH):

```sh
find wordpress/pbin -name '*.php' -exec php -l '{}' \;
php wordpress/tests/helpers.php /tmp/pbin-templates.json
node wordpress/tests/template-syntax.cjs /tmp/pbin-templates.json
```

For real parity testing, bootstrap an isolated WordPress/MySQL installation,
activate the plugin, configure its empty test mount, and set `PBIN_RATE_LIMIT=1000`.
Run the untouched independent acceptance suite against that server, then the same
suite against the Go reference. The browser suite must not be marked passing until
a genuine `/collab` WebSocket implementation is operational.

### Pure-PHP operational transformation core

`pbin/includes/ot.php` provides the protocol-compatible OT primitive, without
opening sockets or depending on WordPress storage. `PBIN_TextOp::fromWire()` and
`fromJSON()` decode arrays of retain counts, insert strings and negative delete
counts. `Retain`, `InsertString`, `Insert`, `Delete`, `Apply`, `TransformIndex`,
`IsNoop`, `wire`, `baseLength` and `targetLength` follow the Go core. Static
`TransformOps(a, b)` returns `[aPrime, bPrime]`, with `a`'s insert winning a shared
insertion position. Operations also implement `JsonSerializable`.

Internal documents and `Insert`/`Apply` arguments are UTF-16LE binary strings, not
UTF-8 strings. Use `PBIN_UTF16::fromUTF8()`/`toUTF8()` at network/storage boundaries;
retain binary documents between edits so a temporarily unpaired surrogate is not
prematurely replaced. `InsertString` and `ApplyString` are UTF-8 conveniences.
`PBIN_JSON::decode()` preserves Go's U+FFFD handling of invalid UTF-8 and escaped
lone JSON surrogates while still rejecting invalid JSON syntax. Socket frame
readers can share that decoder. Impossible integer-overflow lengths are rejected.

Run `bash wordpress/tests/run-ot-tests.sh` with PHP and Go on PATH (or supply
`PHP_BIN`/`GO_BIN`). It runs concrete Unicode/concurrency/validation tests and
10,000 seeded property-style cases, then compiles the unmodified `collab_ot.go`
as an independent oracle and checks every canonical wire array, transformed
operation, binary UTF-16 result and cursor mapping against PHP. This verifies the
OT core, not the WebSocket lifecycle, persistence, presence or browser integration.
