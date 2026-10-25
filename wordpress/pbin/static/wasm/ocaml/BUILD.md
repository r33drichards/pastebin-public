# OCaml toplevel (vendored)

`toplevel.js` is an OCaml toplevel compiled to JavaScript with
js_of_ocaml, built from `toplevel_main.ml` in this directory. It exposes
`pbinOcaml` on `globalThis` with `reset()`, `setStdout(f)`, `setStderr(f)`,
`execute(code)` and `version()`; `static/js/code-runner.js` uses it to run
OCaml pastes entirely in the browser.

## Rebuilding

Built with OCaml 5.5.0 and js_of_ocaml 6.4.1 from nixpkgs:

```sh
nix-shell -p ocaml ocamlPackages.findlib ocamlPackages.js_of_ocaml \
    ocamlPackages.js_of_ocaml-ppx ocamlPackages.js_of_ocaml-toplevel \
    ocamlPackages.js_of_ocaml-compiler --run '
  ocamlfind ocamlc -package js_of_ocaml-toplevel,js_of_ocaml-ppx \
      -linkpkg -linkall toplevel_main.ml -o ocaml_toplevel.bc
  js_of_ocaml --toplevel --effects=cps ocaml_toplevel.bc -o toplevel.js
'
```

`--toplevel` embeds the stdlib's .cmi files so pastes can use the whole
standard library; `--effects=cps` makes OCaml 5 effect handlers work at
runtime.

## Licensing

The build links the OCaml standard library and compiler-libs (LGPL 2.1
with the OCaml linking exception) and the js_of_ocaml runtime and
libraries (LGPL 2.1 with linking exception; the js_of_ocaml compiler
itself is GPL but is only used at build time). `toplevel_main.ml` is
covered by this repository's MIT license.
