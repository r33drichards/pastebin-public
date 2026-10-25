# Effect 3.12.0 offline module graph

`modules.json` contains 151 unchanged UTF-8 ESM source files from the official
Effect 3.12.0 npm package, plus a generated entry exporting the `Effect`, `Tracer`,
`Layer` and `Cause` namespaces. The runner serves that entry as
`pbin/effect@3.12.0` in the offline QuickJS filesystem. Shared dependencies keep
one module identity. This is a VFS archive, not a transformed JavaScript bundle.

The four official package exports and their complete static dependency closure
are included. No `Arbitrary`, `fast-check`, external imports, dynamic imports or
`require` calls occur in this closure. Other Effect namespaces are not exposed
by this built-in; arbitrary URL imports retain their existing CDN allowlist.

## Source and license

- Official registry metadata: https://registry.npmjs.org/effect/3.12.0
- Official archive: https://registry.npmjs.org/effect/-/effect-3.12.0.tgz
- Official source: https://github.com/Effect-TS/effect/tree/effect%403.12.0/packages/effect
- Archive SHA-256: `ce032d0785e27a0ee32dbf75561da4cc1b946c65c79cb4ca0b9c00ef093ec1cb`
- Published npm SRI: `sha512-b/u9s3b9HfTo0qygVouegP0hkbiuxRIeaCe1ppf8P88hPyl6lKCbErtn7Az4jG7LuU7f0Wgm4c8WXbMcL2j8+g==`
- Exact upstream MIT license: `LICENSE`.
- Per-source and generated-asset SHA-256 inventory: `provenance.json`.

## Reproduce and verify

Download the official archive as data; do not run npm lifecycle scripts. With
Python 3 and Node 22+ already installed, from the repository root:

```sh
python3 wordpress/tools/vendor-effect.py /path/to/effect-3.12.0.tgz
python3 wordpress/tools/vendor-effect.py /path/to/effect-3.12.0.tgz --check
node --experimental-vm-modules wordpress/tests/effect-starter.cjs
```

The generator verifies the pinned archive SHA-256 and published SHA-512 SRI,
reads tar members without extracting or executing upstream code, and uses
Node's built-in module parser to enumerate dependencies. No compiler, bundler,
package installation, source rewriting or network access is involved.

The socket-free regression checks source hashes, graph closure, absent dynamic
loading, real runner assembly and actual QuickJS WASM execution with all 13
trace spans. It also tests a missing dependency, cache/retry and the unchanged
URL-import safety rules. Hosted Chromium still verifies serving, TypeScript
compilation and trace UI; its Effect test blocks esm.sh to prevent regression
to a build-on-demand CDN dependency.
