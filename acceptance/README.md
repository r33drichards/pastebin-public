# Independent WordPress parity acceptance

These independent suites compare the Go backend and the WordPress implementation.

The suites exercise public HTTP, WebSocket and browser behavior, without importing
either backend's implementation. IDs are compared relationally, timestamps are
validated rather than snapshot-compared, and Unicode/persistence assertions are
semantic. Visual snapshots are optional supporting evidence, not an oracle.

Use ONLY an isolated disposable instance. These suites create and edit data.

```
PBIN_ACCEPTANCE_URL=http://127.0.0.1:8000 node --test acceptance/http-contract.test.mjs
PBIN_ACCEPTANCE_URL=http://127.0.0.1:8000 node acceptance/browser-contract.cjs
PBIN_ACCEPTANCE_URL=http://127.0.0.1:8000 node acceptance/websocket-http-contract.cjs
```

Browser scripts need Playwright (PBIN_PLAYWRIGHT_MODULE can select its installed
path) and Chromium (PBIN_CHROMIUM can select its executable). Run npm ci in acceptance/ to install pinned Playwright and ws dependencies.
PBIN_WS_MODULE can select an existing Playwright utilsBundle for local development.

## Required verification

Run the same suites against isolated Go and WordPress instances. Passing HTTP
scenarios alone does not establish full browser, realtime, or language-runner
parity. Verify presence, concurrent inserts, UTF-16 editing, cursor and language
changes, last-close persistence, reconnect and duplicate-operation handling,
history truncation, malformed and oversized messages, restart durability,
migration idempotence, concurrent HTTP and OT writes, optional completions,
every supported language runner, mobile navigation, and subdirectory mounts.

The WordPress companion requires a supported long-running PHP process and
WebSocket proxy routing. Verify these requirements on the intended host before
claiming deployment readiness. Use no production site or database for tests.
