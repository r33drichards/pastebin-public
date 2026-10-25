(* OCaml toplevel for pbin, compiled to JavaScript with js_of_ocaml.
   Exports an API as pbinOcaml (on globalThis in the browser):
     setStdout(f) / setStderr(f): install flushers for the program's
       stdout and stderr channels;
     reset(): start a fresh toplevel session (clears all definitions);
     execute(code): run a chunk of OCaml code through the toplevel,
       returning the toplevel's own output (values, types, errors);
     version(): the OCaml compiler version. *)

open Js_of_ocaml
open Js_of_ocaml_toplevel

let execute code =
  let code = Js.to_string code in
  let buf = Buffer.create 1024 in
  let fmt = Format.formatter_of_buffer buf in
  JsooTop.execute true fmt code;
  Format.pp_print_flush fmt ();
  Js.string (Buffer.contents buf)

let set_flusher channel f =
  Sys_js.set_channel_flusher channel (fun s ->
      ignore (Js.Unsafe.fun_call f [| Js.Unsafe.inject (Js.string s) |]))

let () =
  JsooTop.initialize ();
  Js.export "pbinOcaml"
    (object%js
       method execute code = execute code

       method reset = JsooTop.initialize ()

       method setStdout f = set_flusher stdout f

       method setStderr f = set_flusher stderr f

       method version = Js.string Sys.ocaml_version
    end)
