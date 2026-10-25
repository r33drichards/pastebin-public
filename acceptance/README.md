# Independent HTTP acceptance

`http-contract.test.mjs` is the retained black-box HTTP contract. It uses Node's
built-in test runner and fetch, and imports no plugin implementation.

Run only against an isolated disposable WordPress/MySQL instance. Tests create
and edit data. The supported fixture and complete browser gates are documented in
[wordpress/ci/README.md](../wordpress/ci/README.md).

    PBIN_ACCEPTANCE_URL=http://127.0.0.1:18081 node --test acceptance/http-contract.test.mjs

The former WebSocket/collaboration browser contracts and their dependencies were
removed with the intentionally dropped realtime feature. Single-user editor,
autosave, shared-preview storage and language execution coverage lives in `e2e/`.
No Go server or companion process is required.

No new MySQL, HTTP, Chromium or Wasmer pass is claimed by this documentation.
