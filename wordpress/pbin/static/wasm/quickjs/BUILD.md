# QuickJS (vendored)

`qjs-wasi.wasm` is the `qjs` interpreter of
[quickjs-ng](https://github.com/quickjs-ng/quickjs) compiled for WASI.
`static/js/code-runner.js` runs JavaScript pastes on it (and TypeScript
pastes after type stripping) through `@runno/wasi`'s worker host, entirely
in the browser.

It replaces the `wasmedge_quickjs.wasm` build previously fetched from
runno.dev, whose QuickJS predates the ES2025 iterator helpers
(`Iterator.prototype.map/filter/flatMap/take/drop/toArray/…`), so
generator pipelines failed with "TypeError: not a function" (issue #75).

quickjs-ng names its runtime modules `qjs:std` and `qjs:os`. Pastes (and
the Hello World / stdin starters) import the classic bare names, which the
module loader resolves as plain file paths — the runner bridges the two by
placing shim files at `/std` and `/os` in the program's virtual
filesystem that re-export `qjs:std` and `qjs:os` (see the `extraFS` of the
`javascript` entry in `runnoLanguageMap`).

## Updating

Unmodified upstream release artifact — download the next release's
`qjs-wasi.wasm` from <https://github.com/quickjs-ng/quickjs/releases>:

```sh
curl -sSL -o qjs-wasi.wasm \
  https://github.com/quickjs-ng/quickjs/releases/download/v0.17.0/qjs-wasi.wasm
```

Current build: quickjs-ng **v0.17.0**, sha256
`42a732a676ec2d93488c19411e0fad283bf72658fdad746f089914b523c783b1`.

## Licensing

quickjs-ng is MIT-licensed (it descends from Fabrice Bellard and Charlie
Gordon's MIT-licensed QuickJS).
