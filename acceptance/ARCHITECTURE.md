# WordPress-only architecture and release gates

WordPress PHP handles paste/diff/snapshot routes and optional completion; MySQL
holds document data. Browser JavaScript/WebAssembly handles executable languages.
No submitted code is executed in the WordPress PHP interpreter.

The canonical editor is `/paste?id=...`, with `/pbin-wp-test/*` retained as a
same-data alias. Ordinary WordPress routes stay outside that mount. Isolated
acceptance fixtures may use the original root-level HTTP contract.

Editing is single-user serialized HTTP autosave with retry and unload protection.
Realtime WebSockets, presence and OT were intentionally removed, not replaced by
polling or a hidden Go/Workerman sidecar. Last saved content wins across tabs.

A separate staging WordPress installation selects one trusted PR package per
request. Code is immutable by SHA; tables, schema options, extension hooks,
assets and browser preferences are tenant-specific. This is functional isolation,
not a security boundary against hostile PHP. Only reviewed same-repository code
may run; no production credentials/data belong on staging.

Required gates: PHP/JS/package units; real WordPress/MySQL HTTP and tenant
isolation; upgrade/rollback of A while B remains unchanged; canonical WordPress
routes; browser editing/failure/retry and retained runnable languages. Test the
same digest that is promoted, not a rebuild. Persistent wp-content and MySQL need
explicit rollback; switching a Wasmer app version alone is insufficient.

Details: [CI](../wordpress/ci/README.md), [preview control plane](../wordpress/preview/README.md),
and [package lifecycle](../wordpress/tools/README.md). Live hosted integration and
deployment remain separately gated; local mocks do not establish those results.
