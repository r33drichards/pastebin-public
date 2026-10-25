#!/usr/bin/env node
// Generates wordpress/pbin/static/js/clojure-core-docs.js: docstrings and arglists for the
// core library symbols the in-browser Clojure runtime (SCI via Scittle)
// provides. Scittle's bundle strips :doc/:arglists metadata from core
// *functions* to save size (macros keep theirs), so hovers, signature help
// and completion detail for clojure.core would otherwise be empty. This
// script parses the docstrings out of the official ClojureScript sources and
// keeps only the symbols that actually resolve in Scittle's SCI context.
//
// Usage:
//   node tools/gen-clojure-core-docs.js <src-dir> <scittle.js> > wordpress/pbin/static/js/clojure-core-docs.js
//
// where <src-dir> holds these files from clojure/clojurescript (r1.11.132):
//   core.cljs         src/main/cljs/cljs/core.cljs
//   core-macros.cljc  src/main/clojure/cljs/core.cljc
//   string.cljs       src/main/cljs/clojure/string.cljs
//   set.cljs          src/main/cljs/clojure/set.cljs
//   walk.cljs         src/main/cljs/clojure/walk.cljs
//   edn.cljs          src/main/cljs/clojure/edn.cljs
// and <scittle.js> is the same Scittle build clojure-worker.js imports.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- A minimal Clojure tokenizer: just enough to walk top-level forms ----

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ';') { // line comment
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') { // string (possibly multi-line)
      const start = i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      toks.push({ t: 'str', v: src.slice(start, i) });
      continue;
    }
    if (c === '\\') { // character literal like \newline or \x
      const start = i++;
      while (i < n && /[^\s()\[\]{}]/.test(src[i])) i++;
      toks.push({ t: 'sym', v: src.slice(start, i) });
      continue;
    }
    if (c === '#' && src[i + 1] === '"') { // regex literal
      const start = i; i += 2;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      toks.push({ t: 'str', v: src.slice(start, i) });
      continue;
    }
    if (c === '#' && src[i + 1] === '_') { toks.push({ t: 'discard', v: '#_' }); i += 2; continue; }
    if ('()[]{}'.includes(c)) { toks.push({ t: c, v: c }); i++; continue; }
    if (c === '#' && '({'.includes(src[i + 1])) { toks.push({ t: src[i + 1], v: '#' + src[i + 1] }); i += 2; continue; }
    if (/\s|,/.test(c)) { i++; continue; }
    if (c === '^') { toks.push({ t: 'meta', v: '^' }); i++; continue; }
    if ("'`~@".includes(c)) { i++; continue; } // quote/unquote: transparent
    if (c === '#') { i++; continue; }          // other dispatch (#?, #', #js)
    const start = i;
    while (i < n && !/[\s,()\[\]{};"]/.test(src[i])) i++;
    toks.push({ t: 'sym', v: src.slice(start, i) });
  }
  return toks;
}

// Skips one complete form starting at index i; returns the index after it.
function skipForm(toks, i) {
  const open = { '(': ')', '[': ']', '{': '}' };
  const t = toks[i];
  if (!t) return i;
  if (t.t === 'meta') return skipForm(toks, skipForm(toks, i + 1)); // ^meta form
  if (t.t === 'discard') return skipForm(toks, skipForm(toks, i + 1)); // #_ form
  if (open[t.t]) {
    const close = open[t.t];
    let depth = 0;
    for (let j = i; j < toks.length; j++) {
      if (open[toks[j].t]) depth++;
      else if (toks[j].t === close || ')]}'.includes(toks[j].t)) depth--;
      if (depth === 0) return j + 1;
    }
    return toks.length;
  }
  return i + 1;
}

// The token indices of one list form's immediate children.
function childIndices(toks, i) {
  const out = [];
  let j = i + 1;
  const end = skipForm(toks, i) - 1;
  while (j < end) {
    out.push(j);
    j = skipForm(toks, j);
  }
  return out;
}

function unquoteString(tok) {
  if (!tok || tok.t !== 'str' || tok.v[0] !== '"') return null;
  try { return JSON.parse(tok.v.replace(/\n/g, '\\n').replace(/\t/g, '\\t')); }
  catch (e) {
    // A docstring JSON can't parse (odd escapes): strip the quotes and
    // normalize the leading indentation instead.
    return tok.v.slice(1, -1).replace(/\\"/g, '"');
  }
}

// Renders the source text of the form at token index i (vectors only; used
// for arglists, which contain no strings needing exact spacing).
function formText(toks, i) {
  const end = skipForm(toks, i);
  const parts = [];
  for (let j = i; j < end; j++) parts.push(toks[j].v);
  return parts.join(' ')
    .replace(/\[ /g, '[').replace(/ \]/g, ']')
    .replace(/\{ /g, '{').replace(/ \}/g, '}')
    .replace(/\( /g, '(').replace(/ \)/g, ')');
}

// Extracts {name, doc, arglists, kind} from one top-level (defX ...) form.
function parseDef(toks, i) {
  const kids = childIndices(toks, i);
  if (kids.length < 2) return null;
  const head = toks[kids[0]];
  if (!head || head.t !== 'sym') return null;
  const defKind = head.v;
  if (!['def', 'defn', 'defmacro', 'defcurried', 'def-aset'].includes(defKind)) return null;

  // the name: childIndices treats ^meta+form as one child, so kids[1] points
  // at the (possibly metadata-wrapped) name token — unwrap it below.
  let k = 1;
  let nameIdx = kids[k];
  while (toks[nameIdx] && (toks[nameIdx].t === 'meta' || toks[nameIdx].t === 'discard')) {
    nameIdx = skipForm(toks, nameIdx + 1); // past the metadata value
  }
  const nameTok = toks[nameIdx];
  if (!nameTok || nameTok.t !== 'sym') return null;
  const name = nameTok.v;
  if (name.endsWith('-') && defKind === 'defn') return null; // defn- never happens at top level in these sources; private fns use ^:private

  k += 1;
  let doc = null;
  if (kids[k] !== undefined && toks[kids[k]].t === 'str' && kids[k + 1] !== undefined) {
    doc = unquoteString(toks[kids[k]]);
    k += 1;
  }
  // attribute map after the docstring: skip it
  if (kids[k] !== undefined && toks[kids[k]].t === '{' && (defKind === 'defn' || defKind === 'defmacro')) k += 1;

  let arglists = [];
  if (defKind === 'defn' || defKind === 'defmacro' || defKind === 'defcurried') {
    if (kids[k] !== undefined && toks[kids[k]].t === '[') {
      arglists.push(formText(toks, kids[k]));
    } else {
      for (let j = k; j < kids.length; j++) {
        if (toks[kids[j]].t !== '(') continue;
        const body = childIndices(toks, kids[j]);
        if (body.length && toks[body[0]].t === '[') arglists.push(formText(toks, body[0]));
      }
    }
  }
  if (defKind === 'def' && !doc) return null;
  return {
    name,
    doc,
    arglists: arglists.length ? '(' + arglists.join(' ') + ')' : null,
    kind: defKind === 'defmacro' ? 'macro' : 'fn'
  };
}

function parseFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const toks = tokenize(src);
  const out = {};
  let i = 0;
  while (i < toks.length) {
    if (toks[i].t === '(') {
      const entry = (() => { try { return parseDef(toks, i); } catch (e) { return null; } })();
      if (entry && entry.name && !entry.name.endsWith('*') === false) { /* keep */ }
      if (entry && entry.name) {
        const existing = out[entry.name];
        // Prefer the entry with a docstring (core.cljc re-defs some names).
        if (!existing || (!existing.doc && entry.doc)) out[entry.name] = entry;
      }
      i = skipForm(toks, i);
    } else {
      i = skipForm(toks, i);
    }
  }
  return out;
}

// ---- Filter against the symbols Scittle's SCI actually provides ----------

function sciPublics(scittleFile) {
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  globalThis.document = { currentScript: null, querySelectorAll: () => [], addEventListener: () => {} };
  vm.runInThisContext(fs.readFileSync(scittleFile, 'utf8'));
  const evalString = globalThis.scittle.core.eval_string;
  const nss = ['clojure.core', 'clojure.string', 'clojure.set', 'clojure.walk', 'clojure.edn', 'clojure.repl'];
  const out = {};
  for (const ns of nss) {
    out[ns] = Array.from(evalString(
      "(clj->js (sort (map str (keys (ns-publics (quote " + ns + "))))))"));
  }
  // Core macros carry their metadata in the bundle; prefer it when present.
  out.__macroMeta = {};
  for (const name of out['clojure.core']) {
    const m = evalString(
      "(let [m (meta (resolve (symbol \"clojure.core\" " + JSON.stringify(name) + ")))] " +
      " (when (:doc m) #js {:doc (:doc m) :arglists (when (:arglists m) (pr-str (:arglists m))) :macro (boolean (:macro m))}))");
    if (m) out.__macroMeta[name] = { doc: m.doc, arglists: m.arglists || null, macro: !!m.macro };
  }
  return out;
}

function main() {
  const srcDir = process.argv[2];
  const scittleFile = process.argv[3];
  if (!srcDir || !scittleFile) {
    console.error('usage: gen-clojure-core-docs.js <src-dir> <scittle.js>');
    process.exit(1);
  }

  const coreParsed = Object.assign(
    parseFile(path.join(srcDir, 'core.cljs')),
    parseFile(path.join(srcDir, 'core-macros.cljc'))
  );
  const nsParsed = {
    'clojure.string': parseFile(path.join(srcDir, 'string.cljs')),
    'clojure.set': parseFile(path.join(srcDir, 'set.cljs')),
    'clojure.walk': parseFile(path.join(srcDir, 'walk.cljs')),
    'clojure.edn': parseFile(path.join(srcDir, 'edn.cljs'))
  };

  const sci = sciPublics(scittleFile);
  const docs = {};

  const core = {};
  for (const name of sci['clojure.core']) {
    if (name.startsWith('*')) continue; // dynamic vars: little hover value
    const bundled = sci.__macroMeta[name];
    const parsed = coreParsed[name];
    const doc = (bundled && bundled.doc) || (parsed && parsed.doc) || null;
    const arglists = (bundled && bundled.arglists) || (parsed && parsed.arglists) || null;
    if (!doc && !arglists) continue;
    core[name] = [arglists, doc, (bundled && bundled.macro) || (parsed && parsed.kind === 'macro') ? 'macro' : 'fn'];
  }
  docs['clojure.core'] = core;

  for (const [ns, parsed] of Object.entries(nsParsed)) {
    const table = {};
    for (const name of sci[ns]) {
      const p = parsed[name];
      if (!p || (!p.doc && !p.arglists)) continue;
      table[name] = [p.arglists, p.doc, p.kind];
    }
    docs[ns] = table;
  }

  // Special forms are neither vars nor macros; hand-written, after
  // https://clojure.org/reference/special_forms.
  docs.__special = {
    'if': ['(if test then else?)', 'Evaluates test. If not nil or false, evaluates and yields then, otherwise, evaluates and yields else. If else is not supplied it defaults to nil.'],
    'do': ['(do exprs*)', 'Evaluates the expressions in order and returns the value of the last. If no expressions are supplied, returns nil.'],
    'quote': ['(quote form)', 'Yields the unevaluated form.'],
    'var': ['(var symbol)', 'The symbol must resolve to a var, and the Var object itself (not its value) is returned.'],
    'recur': ['(recur exprs*)', 'Evaluates the exprs in order, then, in parallel, rebinds the bindings of the recursion point to the values of the exprs. Must appear in tail position.'],
    'throw': ['(throw expr)', 'The expr is evaluated and thrown.'],
    'try': ['(try expr* catch-clause* finally-clause?)', 'The exprs are evaluated and, if no exceptions occur, the value of the last is returned. If an exception occurs and catch clauses are provided, its expressions are evaluated in a context in which the named binding is bound to the thrown exception.'],
    'def': ['(def symbol doc-string? init?)', 'Creates and interns a global var with the name of symbol, with the value of init if supplied.'],
    'set!': ['(set! var-symbol expr)', 'Assignment special form: sets the value of the var or js field.'],
    'new': ['(new Classname args*)', 'Instantiates a constructor. The form (Classname. args*) is sugar for this.']
  };

  const header =
    '// GENERATED FILE — do not edit by hand.\n' +
    '// Docstrings and arglists for the symbols the in-browser Clojure runtime\n' +
    '// (SCI via Scittle, see clojure-worker.js) provides, parsed out of the\n' +
    '// ClojureScript r1.11.132 sources by tools/gen-clojure-core-docs.js\n' +
    '// (Scittle strips :doc metadata from core functions to save size).\n' +
    '// Entry format: name -> [arglists, doc, kind].\n';
  process.stdout.write(header + 'window.PbinClojureDocs = ' + JSON.stringify(docs) + ';\n');

  const counts = Object.entries(docs).map(([ns, t]) => ns + ':' + Object.keys(t).length).join(' ');
  console.error('generated: ' + counts);
}

main();
