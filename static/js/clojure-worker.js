// Clojure evaluation — Web Worker
//
// Runs Clojure with SCI (the Small Clojure Interpreter) via Scittle,
// babashka's prebuilt browser bundle — the same engine that powers
// tryclojure.org. The worker keeps the run off the main thread so the page
// stays responsive and Cancel can terminate() an infinite loop, and it stays
// alive after the run so the editor (clojure-lsp.js) can look up live
// metadata — docstrings, arglists, definition lines — of the vars the run
// defined.
//
// Protocol (postMessage):
//   in  {type:'run', code, stdin}      run the paste; stdin feeds (read-line)
//   out {type:'result', ok, output, resultStr, timeMs, error}
//        error: {message, line, column, phase}  (phase 'parse' for reader
//        errors, with SCI's structured line/column when it has them)
//   in  {type:'meta', id, sym}         resolve a symbol in the run's context
//   out {type:'meta', id, found, name, ns, doc, arglists, line, macro, special}
//   in  {type:'publics', id}           vars `user` currently defines
//   out {type:'publics', id, names}

importScripts('https://cdn.jsdelivr.net/npm/scittle@0.6.22/dist/scittle.js');

// Everything the program prints, in order. *print-fn* receives raw chunks
// (print/println/pr/prn all go through it); console.log catches js interop
// prints. console.error stays untouched: Scittle writes its own error
// banner there, and the structured error below already carries the message.
let outputBuf = '';
self.__pbinWrite = function (s) { outputBuf += s; };
const origLog = console.log;
console.log = function () {
  outputBuf += Array.prototype.join.call(arguments, ' ') + '\n';
  origLog.apply(console, arguments);
};

const evalString = scittle.core.eval_string;

// Clojure-side helpers, compiled once. SCI functions are plain JS functions,
// so evaluating a `fn` form hands back something callable from here.
evalString('(set! *print-newline* true) (set! *print-fn* (fn [s] (js/__pbinWrite s)))');
const prStr = evalString('pr-str');
const exDataField = evalString(
  '(fn [e k] (get (ex-data e) (keyword k)))');
const metaLookup = evalString(
  '(fn [sym-str] ' +
  '  (when-let [v (resolve (symbol sym-str))] ' +
  '    (let [m (meta v)] ' +
  '      #js {:found true ' +
  '           :name (str (:name m)) ' +
  '           :ns (str (:ns m)) ' +
  '           :doc (:doc m) ' +
  '           :arglists (when (:arglists m) (pr-str (:arglists m))) ' +
  '           :line (:line m) ' +
  '           :macro (boolean (:macro m))})))');
const userPublics = evalString(
  '(fn [] (clj->js (sort (map str (keys (ns-publics (quote user)))))))');

// (read-line) for the Input tab: one line per call, nil at EOF. Defined in
// the user namespace (ClojureScript has no core read-line).
const STDIN_PRELUDE =
  '(def ^:private --pbin-stdin (atom [])) ' +
  '(defn read-line [] ' +
  '  (let [lines @--pbin-stdin] ' +
  '    (when (seq lines) ' +
  '      (reset! --pbin-stdin (subvec lines 1)) ' +
  '      (first lines))))';
evalString(STDIN_PRELUDE);
const setStdin = evalString(
  '(fn [lines] (reset! --pbin-stdin (vec (js->clj lines))))');

function errorInfo(e) {
  const info = {
    message: (e && e.message) || String(e),
    line: null,
    column: null,
    phase: null
  };
  try {
    const line = exDataField(e, 'line');
    const column = exDataField(e, 'column');
    const type = exDataField(e, 'type');
    if (typeof line === 'number') info.line = line;
    if (typeof column === 'number') info.column = column;
    // Reader errors come through as :sci.error/parse (or :edamame/error on
    // the cause); everything else failed while evaluating.
    info.phase = /parse|edamame/.test(String(type || '')) ? 'parse' : 'eval';
  } catch (ignore) { /* a plain js error has no ex-data */ }
  return info;
}

self.onmessage = function (e) {
  const msg = e.data || {};

  if (msg.type === 'run') {
    outputBuf = '';
    const stdinLines = String(msg.stdin || '').split('\n');
    if (stdinLines.length && stdinLines[stdinLines.length - 1] === '') stdinLines.pop();
    setStdin(stdinLines);
    const started = performance.now();
    try {
      const result = evalString(String(msg.code || ''));
      let resultStr = null;
      if (result !== undefined && result !== null) {
        try { resultStr = prStr(result); }
        catch (ignore) { resultStr = String(result); }
      }
      self.postMessage({
        type: 'result',
        ok: true,
        output: outputBuf,
        resultStr: resultStr,
        timeMs: performance.now() - started
      });
    } catch (err) {
      self.postMessage({
        type: 'result',
        ok: false,
        output: outputBuf,
        resultStr: null,
        timeMs: performance.now() - started,
        error: errorInfo(err)
      });
    }
    return;
  }

  if (msg.type === 'meta') {
    let out = { type: 'meta', id: msg.id, found: false };
    try {
      const m = metaLookup(String(msg.sym || ''));
      if (m) {
        out = {
          type: 'meta', id: msg.id, found: true,
          name: m.name, ns: m.ns, doc: m.doc || null,
          arglists: m.arglists || null,
          line: (typeof m.line === 'number') ? m.line : null,
          macro: !!m.macro
        };
      }
    } catch (ignore) { /* unresolvable symbol */ }
    self.postMessage(out);
    return;
  }

  if (msg.type === 'publics') {
    let names = [];
    try { names = Array.from(userPublics()); } catch (ignore) {}
    self.postMessage({ type: 'publics', id: msg.id, names: names });
  }
};

self.postMessage({ type: 'ready' });
