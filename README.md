# pbin: WordPress + browser runtimes

WordPress/PHP/MySQL is the supported application backend. The editor supports
single-user HTTP autosave, raw pastes, diffs, immutable snapshots, Markdown,
and browser-side language execution. No Go HTTP server, WebSocket companion,
presence service, Nix build, Docker publisher, or Railway deployment is required.

## Start here

- [WordPress installation, routing, limitations and runtime details](wordpress/README.md)
- [Reproducible packages, local fixtures and required CI gates](wordpress/ci/README.md)
- [Browser runtime and editor feature reference](docs/browser-runtimes.md)
- [Backend removal inventory](wordpress/ci/backend-removals.json)

The maintained frontend lives in `wordpress/pbin/templates/` and
`wordpress/pbin/static/`. Edit those files directly. Old root Go templates and
duplicated assets are retired by the hash-checked removal plan, not regenerated
into the plugin. Language runners, workers, Wasm, licensing files and language
choices remain part of the plugin. Removing the Go application backend does
not remove Go as a guest language or claim that experimental Go execution is already implemented.

## Checks and package

Use PHP 8.1+ with mysqli, mbstring and XML/DOM, Python 3.12, and Node 22.
A clean CI runner uses a pinned WordPress compatibility baseline and local
MySQL 8.4; no application credentials are provided to PR code.

```sh
bash wordpress/ci/check-unit.sh
python3 wordpress/tools/package.py --source wordpress/pbin \
  --revision "$(git rev-parse HEAD)" --output /tmp/pbin.zip
```

See the CI guide for the real WordPress/MySQL/browser fixture. A package build
or a unit-only pass is not integration, Wasmer, deployment, or cutover proof.

## Preview and deployment status

Packages are immutable and tenant-aware. Shared PHP/MySQL previews are for
reviewed, trusted same-repository code only, not a security sandbox. An untrusted
fork must never execute in a shared staging process or receive credentials.

GitHub CI retains a package only after the exact archive has passed all required
checks. It contains no deployment job. Wasmer execution/install access,
trusted artifact provenance, stale-head rejection, staging authentication and
production migration/rollback readiness must be validated separately before
enabling any secret-bearing installation workflow.

The old production service must not be deleted merely because its source build
path is retired; the canonical/data cutover is a separate operational step.
