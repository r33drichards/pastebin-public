// Clojure editor support: language-server-style features without a server.
//
// Monaco ships only a Monarch grammar for Clojure (highlighting + the generic
// keyword list from lsp-completions.js). This module adds the editor actions
// a Clojure editor is expected to have, built from three sources:
//
//   1. A generated docs table (static/js/clojure-core-docs.js — docstrings
//      and arglists for everything the SCI runtime provides, parsed from the
//      ClojureScript sources) for clojure.core, clojure.string/set/walk/edn
//      and the special forms.
//   2. A lightweight reader over the buffer itself: top-level `(def…)` forms
//      give document symbols, go-to-definition, find-references, completion
//      of the paste's own functions, and their arglists for signature help;
//      a delimiter scanner gives live diagnostics for the classic Lisp
//      failure mode — unbalanced parens — plus unclosed strings.
//   3. The live SCI context of the last run (clojure-worker.js, via
//      window.pbinClojureMeta): hovers over vars the run defined show their
//      real :doc/:arglists metadata, REPL-style.
//
// Features: completions (core + namespaces + special forms + buffer defs +
// keywords in the buffer), hovers, signature help, document symbols
// (outline), go-to-definition, find-references, delimiter/paren diagnostics
// as you type, and markers on the failing line when a run errors.
//
// The docs table (~80 KB) loads lazily the first time a paste is in Clojure.
(function (global) {
  'use strict';

  var DOCS_URL = '/static/js/clojure-core-docs.js';
  var DEBOUNCE_MS = 200;

  // Characters that can make up a Clojure symbol. Monaco's default word
  // boundaries split on - < > ! ? etc., so symbols are read by hand.
  var SYM_CHAR = /[^\s()\[\]{}"';,`~@^\\]/;

  // ---- A minimal Clojure scanner -----------------------------------------
  // Walks the text once, reporting delimiters, strings, symbols and keywords
  // with 1-based line/column positions. Good enough for everything here; it
  // does not evaluate anything.
  function scan(text, visit) {
    var line = 1, col = 1, i = 0, n = text.length;
    function advance(c) {
      if (c === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
    while (i < n) {
      var c = text[i];
      if (c === ';') { // comment to end of line
        while (i < n && text[i] !== '\n') advance(text[i]);
        continue;
      }
      if (c === '\\' && i + 1 < n) { // character literal \a \( \newline
        var chLine = line, chCol = col;
        advance(c);           // the backslash
        advance(text[i]);     // the character itself, whatever it is
        while (i < n && SYM_CHAR.test(text[i])) advance(text[i]); // \newline
        visit({ type: 'char', line: chLine, col: chCol });
        continue;
      }
      if (c === '^') { // metadata: ^Type and ^:kw tag the following form
        advance(c);
        while (i < n && SYM_CHAR.test(text[i])) advance(text[i]); // ^Type hint
        continue; // ^:kw and ^{...} fall through to the keyword/map branches
      }
      if (c === '"' || (c === '#' && text[i + 1] === '"')) { // string / regex
        var sLine = line, sCol = col;
        if (c === '#') advance(c);
        advance(text[i]); // opening quote
        var closed = false;
        while (i < n) {
          if (text[i] === '\\') { advance(text[i]); if (i < n) advance(text[i]); continue; }
          if (text[i] === '"') { advance(text[i]); closed = true; break; }
          advance(text[i]);
        }
        if (closed) visit({ type: 'string', line: sLine, col: sCol });
        else visit({ type: 'unclosed-string', line: sLine, col: sCol });
        continue;
      }
      if ('([{'.indexOf(c) >= 0) {
        visit({ type: 'open', ch: c, line: line, col: col });
        advance(c);
        continue;
      }
      if (')]}'.indexOf(c) >= 0) {
        visit({ type: 'close', ch: c, line: line, col: col });
        advance(c);
        continue;
      }
      if (c === ':' && i + 1 < n && SYM_CHAR.test(text[i + 1])) { // keyword
        var kLine = line, kCol = col;
        var start = i;
        advance(c);
        if (text[i] === ':') advance(text[i]); // ::auto-resolved
        while (i < n && SYM_CHAR.test(text[i])) advance(text[i]);
        visit({ type: 'keyword', text: text.slice(start, i), line: kLine, col: kCol });
        continue;
      }
      if (SYM_CHAR.test(c) && c !== '#' && c !== "'") {
        var yLine = line, yCol = col, yStart = i;
        while (i < n && SYM_CHAR.test(text[i])) advance(text[i]);
        visit({ type: 'symbol', text: text.slice(yStart, i), line: yLine, col: yCol });
        continue;
      }
      advance(c);
    }
  }

  var MATCHING = { '(': ')', '[': ']', '{': '}' };

  // Unbalanced-delimiter and unclosed-string diagnostics.
  function delimiterProblems(text) {
    var stack = [];
    var problems = [];
    scan(text, function (t) {
      if (t.type === 'open') {
        stack.push(t);
      } else if (t.type === 'close') {
        var top = stack.pop();
        if (!top) {
          problems.push({ line: t.line, col: t.col, len: 1,
            message: "Unmatched '" + t.ch + "'" });
        } else if (MATCHING[top.ch] !== t.ch) {
          problems.push({ line: t.line, col: t.col, len: 1,
            message: "Mismatched delimiter: '" + t.ch + "' closes '" + top.ch +
              "' opened at line " + top.line });
        }
      } else if (t.type === 'unclosed-string') {
        problems.push({ line: t.line, col: t.col, len: 1,
          message: 'Unclosed string' });
      }
    });
    for (var k = 0; k < stack.length; k++) {
      var open = stack[k];
      problems.push({ line: open.line, col: open.col, len: 1,
        message: "Unclosed '" + open.ch + "': expected '" + MATCHING[open.ch] + "'" });
    }
    return problems;
  }

  // Top-level definitions in the buffer:
  // [{name, kind, defForm, line, col, argLine}] — argLine is the raw text of
  // the first arg vector for signature help.
  var DEF_FORMS = /^(defn|defn-|defmacro|def|defonce|defmulti|defmethod|defprotocol|defrecord|deftype|ns)$/;
  function bufferDefs(text) {
    var defs = [];
    var depth = 0;
    var pendingDef = null; // saw (defX, waiting for the name symbol
    scan(text, function (t) {
      if (t.type === 'open') { depth++; return; }
      if (t.type === 'close') { depth = Math.max(0, depth - 1); pendingDef = null; return; }
      if (t.type === 'symbol') {
        if (pendingDef && depth === pendingDef.depth) {
          defs.push({ name: t.text, kind: pendingDef.form, line: t.line, col: t.col });
          pendingDef = null;
          return;
        }
        if (depth === 1 && DEF_FORMS.test(t.text)) {
          pendingDef = { form: t.text, depth: 1 };
        }
      }
    });
    return defs;
  }

  // The argument vectors of a top-level defn in the buffer, as source text
  // (e.g. ["[a b]", "[a b & more]"]). Reads forward from the def's position.
  function bufferArglists(model, def) {
    var text = model.getValue();
    var offset = model.getOffsetAt({ lineNumber: def.line, column: def.col });
    var rest = text.slice(offset, offset + 2000); // arglists live near the name
    var lists = [];
    // single-arity: first top-level [ after the name (skip docstring)
    var m = rest.match(/^[^\[\]()"]*(?:"(?:[^"\\]|\\.)*"\s*)?(\[[^\]]*\])/);
    if (m) { lists.push(m[1].replace(/\s+/g, ' ')); return lists; }
    // multi-arity: ([...] ...) groups
    var re = /\(\s*(\[[^\]]*\])/g, g;
    while ((g = re.exec(rest)) && lists.length < 8) lists.push(g[1].replace(/\s+/g, ' '));
    return lists;
  }

  // The Clojure symbol around a Monaco position, with its range.
  function symbolAt(model, position) {
    var lineText = model.getLineContent(position.lineNumber);
    var idx = position.column - 1;
    var start = idx, end = idx;
    while (start > 0 && SYM_CHAR.test(lineText[start - 1])) start--;
    while (end < lineText.length && SYM_CHAR.test(lineText[end])) end++;
    if (start === end) return null;
    var word = lineText.slice(start, end);
    if (!/[^0-9.]/.test(word)) return null; // just a number
    return {
      word: word,
      range: {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: start + 1, endColumn: end + 1
      }
    };
  }

  // ---- The docs table ------------------------------------------------------

  var docsState = 'idle'; // idle | loading | ready | failed
  var docsWaiters = [];
  function withDocs(fn) {
    if (docsState === 'ready' || docsState === 'failed') { fn(); return; }
    docsWaiters.push(fn);
    if (docsState === 'loading') return;
    docsState = 'loading';
    var script = document.createElement('script');
    script.src = DOCS_URL;
    script.onload = function () { docsState = 'ready'; flush(); };
    script.onerror = function () { docsState = 'failed'; flush(); };
    function flush() {
      var w = docsWaiters; docsWaiters = [];
      for (var i = 0; i < w.length; i++) w[i]();
    }
    document.head.appendChild(script);
  }
  function docs() { return global.PbinClojureDocs || null; }

  // Looks a symbol up in the docs table. Accepts plain names (map),
  // namespace-qualified ones (clojure.string/join) and common aliases
  // (str/join, string/join, set/union, walk/postwalk, edn/read-string).
  var NS_ALIASES = {
    'clojure.core': 'clojure.core', 'core': 'clojure.core', 'cljs.core': 'clojure.core',
    'clojure.string': 'clojure.string', 'string': 'clojure.string', 'str': 'clojure.string',
    'clojure.set': 'clojure.set', 'set': 'clojure.set',
    'clojure.walk': 'clojure.walk', 'walk': 'clojure.walk',
    'clojure.edn': 'clojure.edn', 'edn': 'clojure.edn'
  };
  function lookupDocs(word) {
    var d = docs();
    if (!d) return null;
    var slash = word.indexOf('/');
    if (slash > 0 && slash < word.length - 1) {
      var ns = NS_ALIASES[word.slice(0, slash)];
      var name = word.slice(slash + 1);
      if (ns && d[ns] && d[ns][name]) return entry(ns, name, d[ns][name]);
      return null;
    }
    if (d.__special[word]) {
      var sp = d.__special[word];
      return { ns: null, name: word, arglists: sp[0], doc: sp[1], kind: 'special form' };
    }
    if (d['clojure.core'][word]) return entry('clojure.core', word, d['clojure.core'][word]);
    return null;
  }
  function entry(ns, name, row) {
    return { ns: ns, name: name, arglists: row[0], doc: row[1],
      kind: row[2] === 'macro' ? 'macro' : 'function' };
  }

  // ---- Hover content -------------------------------------------------------

  function hoverMarkdown(info) {
    var title = '**' + (info.ns ? info.ns + '/' : '') + info.name + '**';
    if (info.kind) title += ' *' + info.kind + '*';
    var parts = [title];
    if (info.arglists) parts.push('```clojure\n' + info.arglists + '\n```');
    if (info.doc) parts.push(info.doc);
    return parts.map(function (v) { return { value: v }; });
  }

  // Live metadata from the last run's SCI context, when the runner has one.
  function liveMeta(word) {
    if (typeof global.pbinClojureMeta !== 'function') return Promise.resolve(null);
    try { return global.pbinClojureMeta(word); } catch (e) { return Promise.resolve(null); }
  }

  // ---- Signature help ------------------------------------------------------

  // Splits "([f] [f coll] [f c1 c2 & colls])" into its vectors.
  function splitArglists(arglists) {
    if (!arglists) return [];
    var out = [], depth = 0, start = -1;
    for (var i = 0; i < arglists.length; i++) {
      var c = arglists[i];
      if (c === '[') { if (depth === 0) start = i; depth++; }
      else if (c === ']') { depth--; if (depth === 0 && start >= 0) { out.push(arglists.slice(start, i + 1)); start = -1; } }
    }
    return out;
  }

  // The top-level parameters of one arg vector, e.g. "[f [a b] & more]"
  // → ["f", "[a b]", "& more"].
  function vectorParams(vec) {
    var inner = vec.slice(1, -1).trim();
    if (!inner) return [];
    var params = [], depth = 0, cur = '';
    for (var i = 0; i < inner.length; i++) {
      var c = inner[i];
      if ('([{'.indexOf(c) >= 0) depth++;
      if (')]}'.indexOf(c) >= 0) depth--;
      if (/\s/.test(c) && depth === 0) {
        if (cur) { params.push(cur); cur = ''; }
      } else cur += c;
    }
    if (cur) params.push(cur);
    // join "& rest" into one parameter
    for (var j = 0; j < params.length - 1; j++) {
      if (params[j] === '&') { params.splice(j, 2, '& ' + params[j + 1]); }
    }
    return params;
  }

  // Finds the enclosing call at the cursor: the head symbol and how many
  // complete argument forms precede the cursor.
  function enclosingCall(model, position) {
    var text = model.getValueInRange({
      startLineNumber: 1, startColumn: 1,
      endLineNumber: position.lineNumber, endColumn: position.column
    });
    // Token stream up to the cursor; track open lists with their head + arity.
    var stack = [];
    scan(text, function (t) {
      if (t.type === 'open') {
        stack.push({ ch: t.ch, head: null, args: -1 }); // head itself is arg -1
      } else if (t.type === 'close') {
        stack.pop();
        bump();
      } else if (t.type === 'symbol' || t.type === 'keyword') {
        var top = stack[stack.length - 1];
        if (top && top.ch === '(' && top.head === null) top.head = t.text;
        else bump();
      } else if (t.type === 'string' || t.type === 'char' || t.type === 'unclosed-string') {
        bump();
      }
      function bump() {
        var top = stack[stack.length - 1];
        if (top) top.args++;
      }
    });
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i].ch === '(' && stack[i].head) {
        return { head: stack[i].head, argIndex: Math.max(0, stack[i].args + 1) };
      }
    }
    return null;
  }

  // ---- Wiring --------------------------------------------------------------

  function start(opts) {
    var monaco = opts.monaco;
    var editor = opts.editor;
    var registered = false;
    var changeTimer = null;

    function isClojure() {
      var model = editor.getModel();
      return !!model && model.getLanguageId() === 'clojure';
    }

    function refreshDiagnostics() {
      var model = editor.getModel();
      if (!model || !isClojure()) return;
      var problems = delimiterProblems(model.getValue());
      monaco.editor.setModelMarkers(model, 'clojure-syntax', problems.map(function (p) {
        return {
          severity: monaco.MarkerSeverity.Error,
          message: p.message,
          startLineNumber: p.line, startColumn: p.col,
          endLineNumber: p.line, endColumn: p.col + p.len
        };
      }));
    }

    function clearMarkers() {
      var model = editor.getModel();
      if (!model) return;
      monaco.editor.setModelMarkers(model, 'clojure-syntax', []);
      monaco.editor.setModelMarkers(model, 'clojure-run', []);
    }

    // A failed run marks the failing line; the marker clears on edit.
    global.addEventListener('pbin-clojure-run', function (ev) {
      var model = editor.getModel();
      if (!model || !isClojure()) return;
      var error = ev.detail && ev.detail.error;
      if (!error || typeof error.line !== 'number' || error.line < 1 ||
          error.line > model.getLineCount()) {
        monaco.editor.setModelMarkers(model, 'clojure-run', []);
        return;
      }
      var col = (typeof error.column === 'number' && error.column >= 1) ? error.column : 1;
      monaco.editor.setModelMarkers(model, 'clojure-run', [{
        severity: monaco.MarkerSeverity.Error,
        message: error.message || 'Evaluation failed',
        startLineNumber: error.line, startColumn: col,
        endLineNumber: error.line,
        endColumn: model.getLineMaxColumn(error.line)
      }]);
    });

    function register() {
      if (registered) return;
      registered = true;

      // The generic keyword word-list would duplicate these completions;
      // PbinLSP keeps serving its snippets.
      if (global.PbinLSP && global.PbinLSP.claim) global.PbinLSP.claim('clojure');

      var K = monaco.languages.CompletionItemKind;

      monaco.languages.registerCompletionItemProvider('clojure', {
        provideCompletionItems: function (model, position) {
          var d = docs();
          var sym = symbolAt(model, position);
          var range = sym ? sym.range : {
            startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
            startColumn: position.column, endColumn: position.column
          };
          var suggestions = [];
          var seen = {};
          function add(label, kind, detail, doc, sortPrefix) {
            if (seen[label]) return;
            seen[label] = true;
            suggestions.push({
              label: label, kind: kind, insertText: label, range: range,
              detail: detail || undefined,
              documentation: doc ? { value: doc } : undefined,
              sortText: (sortPrefix || '2') + label
            });
          }

          // The paste's own definitions first.
          var defs = bufferDefs(model.getValue());
          for (var i = 0; i < defs.length; i++) {
            add(defs[i].name, /defmacro/.test(defs[i].kind) ? K.Snippet : K.Function,
              defs[i].kind + ' (this paste)', null, '0');
          }
          // Keywords used in the buffer complete like constants.
          scan(model.getValue(), function (t) {
            if (t.type === 'keyword') add(t.text, K.Constant, 'keyword', null, '3');
          });

          if (d) {
            Object.keys(d.__special).forEach(function (name) {
              add(name, K.Keyword, 'special form', d.__special[name][1], '1');
            });
            Object.keys(d['clojure.core']).forEach(function (name) {
              var row = d['clojure.core'][name];
              add(name, row[2] === 'macro' ? K.Keyword : K.Function,
                (row[0] || '') + (row[2] === 'macro' ? ' macro' : ''),
                row[1], '2');
            });
            ['clojure.string', 'clojure.set', 'clojure.walk', 'clojure.edn'].forEach(function (ns) {
              Object.keys(d[ns]).forEach(function (name) {
                var row = d[ns][name];
                add(ns + '/' + name, K.Function, row[0] || '', row[1], '4');
              });
            });
          }
          return { suggestions: suggestions };
        }
      });

      monaco.languages.registerHoverProvider('clojure', {
        provideHover: function (model, position) {
          var sym = symbolAt(model, position);
          if (!sym) return null;

          // 1. A definition in this paste.
          var defs = bufferDefs(model.getValue());
          for (var i = 0; i < defs.length; i++) {
            if (defs[i].name === sym.word) {
              var arglists = bufferArglists(model, defs[i]);
              var local = {
                ns: null, name: sym.word,
                kind: defs[i].kind + ' (this paste, line ' + defs[i].line + ')',
                arglists: arglists.length ? '(' + arglists.join(' ') + ')' : null,
                doc: null
              };
              // 2. Enrich with live metadata when the last run defined it.
              return liveMeta(sym.word).then(function (m) {
                if (m && m.ns === 'user') {
                  if (m.doc) local.doc = m.doc;
                  if (m.arglists) local.arglists = m.arglists;
                }
                return { range: sym.range, contents: hoverMarkdown(local) };
              });
            }
          }

          // 3. The docs table (core, namespaces, special forms) — falling
          // back to the live context for anything it resolves (e.g. vars
          // from a previous run that were since deleted from the buffer).
          var info = lookupDocs(sym.word);
          if (info) return { range: sym.range, contents: hoverMarkdown(info) };
          return liveMeta(sym.word).then(function (m) {
            if (!m) return null;
            return {
              range: sym.range,
              contents: hoverMarkdown({
                ns: m.ns, name: m.name,
                kind: m.macro ? 'macro' : null,
                arglists: m.arglists, doc: m.doc
              })
            };
          });
        }
      });

      monaco.languages.registerSignatureHelpProvider('clojure', {
        signatureHelpTriggerCharacters: [' ', '('],
        provideSignatureHelp: function (model, position) {
          var call = enclosingCall(model, position);
          if (!call) return null;
          var arglists = null, title = call.head, docText = null;
          var info = lookupDocs(call.head);
          if (info && info.arglists) {
            arglists = info.arglists;
            title = (info.ns ? info.ns + '/' : '') + info.name;
            docText = info.doc;
          } else {
            var defs = bufferDefs(model.getValue());
            for (var i = 0; i < defs.length; i++) {
              if (defs[i].name === call.head) {
                var lists = bufferArglists(model, defs[i]);
                if (lists.length) arglists = '(' + lists.join(' ') + ')';
                break;
              }
            }
          }
          if (!arglists) return null;

          var vectors = splitArglists(arglists);
          if (!vectors.length) return null;
          var signatures = vectors.map(function (vec) {
            var params = vectorParams(vec);
            return {
              label: '(' + title + (params.length ? ' ' + params.join(' ') : '') + ')',
              documentation: docText ? { value: docText } : undefined,
              parameters: params.map(function (p) { return { label: p }; })
            };
          });
          // The arity whose count fits (a trailing "& rest" matches any
          // surplus), else the largest.
          var active = signatures.length - 1;
          for (var s = 0; s < vectors.length; s++) {
            var params = vectorParams(vectors[s]);
            var variadic = params.length && params[params.length - 1].indexOf('&') === 0;
            if (call.argIndex < params.length || (variadic && call.argIndex >= params.length - 1)) {
              active = s;
              break;
            }
          }
          var activeParams = vectorParams(vectors[active]);
          var activeParam = Math.min(call.argIndex, Math.max(0, activeParams.length - 1));
          return {
            value: {
              signatures: signatures,
              activeSignature: active,
              activeParameter: activeParam
            },
            dispose: function () {}
          };
        }
      });

      monaco.languages.registerDocumentSymbolProvider('clojure', {
        provideDocumentSymbols: function (model) {
          var S = monaco.languages.SymbolKind;
          var kinds = {
            defn: S.Function, 'defn-': S.Function, defmacro: S.Function,
            defmulti: S.Function, defmethod: S.Method,
            def: S.Variable, defonce: S.Variable,
            defprotocol: S.Interface, defrecord: S.Class, deftype: S.Class,
            ns: S.Namespace
          };
          return bufferDefs(model.getValue()).map(function (def) {
            var range = {
              startLineNumber: def.line, startColumn: def.col,
              endLineNumber: def.line, endColumn: def.col + def.name.length
            };
            return {
              name: def.name, detail: def.kind,
              kind: kinds[def.kind] || S.Variable,
              range: range, selectionRange: range, tags: []
            };
          });
        }
      });

      monaco.languages.registerDefinitionProvider('clojure', {
        provideDefinition: function (model, position) {
          var sym = symbolAt(model, position);
          if (!sym) return null;
          var name = sym.word.indexOf('/') > 0 ? sym.word.split('/').pop() : sym.word;
          var defs = bufferDefs(model.getValue());
          for (var i = 0; i < defs.length; i++) {
            if (defs[i].name === name) {
              return [{
                uri: model.uri,
                range: {
                  startLineNumber: defs[i].line, startColumn: defs[i].col,
                  endLineNumber: defs[i].line, endColumn: defs[i].col + name.length
                }
              }];
            }
          }
          return null;
        }
      });

      monaco.languages.registerReferenceProvider('clojure', {
        provideReferences: function (model, position) {
          var sym = symbolAt(model, position);
          if (!sym) return null;
          var refs = [];
          scan(model.getValue(), function (t) {
            if (t.type === 'symbol' && t.text === sym.word) {
              refs.push({
                uri: model.uri,
                range: {
                  startLineNumber: t.line, startColumn: t.col,
                  endLineNumber: t.line, endColumn: t.col + t.text.length
                }
              });
            }
          });
          return refs;
        }
      });

      refreshDiagnostics();
    }

    editor.onDidChangeModelContent(function () {
      if (!isClojure()) return;
      var model = editor.getModel();
      if (model) monaco.editor.setModelMarkers(model, 'clojure-run', []);
      clearTimeout(changeTimer);
      changeTimer = setTimeout(refreshDiagnostics, DEBOUNCE_MS);
    });

    function onLanguage() {
      if (isClojure()) {
        withDocs(register);
        refreshDiagnostics();
      } else {
        clearMarkers();
      }
    }
    editor.onDidChangeModelLanguage(onLanguage);
    onLanguage();
  }

  global.PbinClojure = {
    start: start,
    // exposed for tests
    _delimiterProblems: delimiterProblems,
    _bufferDefs: bufferDefs,
    _splitArglists: splitArglists,
    _vectorParams: vectorParams
  };
})(window);
