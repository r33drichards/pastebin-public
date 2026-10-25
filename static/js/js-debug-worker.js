// JavaScript/TypeScript debug worker: runs a paste under a line tracer so
// the debugger (static/js/debug.js) can pause it, step and inspect — the
// same protocol as the Python debugger in pyodide-worker.js. TypeScript
// pastes are type-stripped by Babel's typescript preset in the same
// transform pass, so their line numbers survive.
//
// The worker also serves plain (non-debug) TypeScript runs: a {transpile}
// message answers with the paste's types stripped and, thanks to
// retainLines, every statement still on its original line — so QuickJS
// runtime errors report source line numbers without any source maps.
//
// Plain runs stay on the sandboxed QuickJS/WASI runtime (code-runner.js);
// only "run in debugger" runs come here, because QuickJS gives the WASI host
// no pause/inspect hooks. Instead the code is instrumented with Babel
// (standalone, fetched from jsDelivr like Pyodide/basedpyright are): a hook
// call is inserted before every statement, carrying the line number, a fresh
// `expr => eval(expr)` thunk (direct eval sees the enclosing scope, so the
// paused UI can list locals, evaluate watches and write assignments back),
// and the names in scope there. Function bodies get enter/exit bookkeeping
// (try/finally) so the debugger keeps a shadow call stack for step over/out
// and the stack pane.
//
// On a pause the hook posts {type: 'debug-paused', state} and blocks on
// Atomics.wait until the main thread stores a command in the shared control
// buffer — the page is cross-origin isolated (main.go sets COOP/COEP), so a
// blocked worker is fine. Commands and the buffer layout are shared with
// pyodide-worker.js and debug.js: 1-4 resume (continue / step over / step
// into / step out, the data buffer carrying the current breakpoints), 5
// evaluates {frame, code}, 6 re-evaluates watches, 7 serves a step-back
// history snapshot, 8 expands an object one level.
//
// Differences from a QuickJS run, by design: the program executes on the
// browser's own engine inside this worker. console/print and minimal
// QuickJS 'std'/'os' shims are provided (stdin comes from the Input tab);
// network and storage APIs are removed before user code runs, so a debug
// run stays as closed off as the WASI sandbox.

'use strict';

const BABEL_URL = 'https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js';

// Commands in control[0]; control[1] is the byte length of the JSON payload
// in the data buffer. Mirrored in debug.js and pyodide-worker.js.
const CMD = { CONTINUE: 1, STEP_OVER: 2, STEP_INTO: 3, STEP_OUT: 4, EVAL: 5, WATCHES: 6, HISTORY: 7, EXPAND: 8 };

const MAX_VARS = 200;
const MAX_REPR = 200;
const MAX_HIST_REPR = 120;
const MAX_WATCHES = 20;
const MAX_CHILDREN = 200;
const HISTORY_LIMIT = 200;

// ---- sandbox ---------------------------------------------------------------
// The QuickJS runtime has no network or storage; strip the worker's own
// before any user code runs so a debug run can't do more than a plain one.
// A private fetch reference survives for loading the pinned Babel bundle.
const privateFetch = self.fetch.bind(self);
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'indexedDB', 'caches', 'importScripts']) {
  try { self[name] = undefined; } catch (e) { /* some are read-only; fine */ }
}

// The '@opentelemetry/api' tracing shim (static/js/otel-shim.js), fetched the
// same way as Babel and shared with the QuickJS runtime (code-runner.js
// serves it there as a virtual-filesystem module). The shim is strict-mode
// code, so an indirect eval keeps its declarations to itself; the trailing
// expression hands the factory out.
const OTEL_SHIM_URL = '/static/js/otel-shim.js';
let otelFactoryReady = null;
function getOtelFactory() {
  if (otelFactoryReady === null) {
    otelFactoryReady = (async () => {
      const r = await privateFetch(OTEL_SHIM_URL);
      if (!r.ok) throw new Error('fetching otel-shim.js failed: HTTP ' + r.status);
      const src = await r.text();
      return (0, eval)(src + '\n__pbOtelCreate;');
    })().catch((err) => {
      otelFactoryReady = null; // a later run may retry
      throw err;
    });
  }
  return otelFactoryReady;
}

let babelReady = null;
function getBabel() {
  if (babelReady === null) {
    // importScripts was removed above, so fetch-and-eval the pinned bundle
    // the way a Blob worker would. The eval happens before user code and
    // only on the pinned CDN URL.
    babelReady = (async () => {
      const r = await privateFetch(BABEL_URL);
      if (!r.ok) throw new Error('fetching Babel failed: HTTP ' + r.status);
      const src = await r.text();
      (0, eval)(src);
      return self.Babel;
    })();
  }
  return babelReady;
}

// ---- value rendering --------------------------------------------------------

function typeName(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t !== 'object') return t;
  const proto = Object.getPrototypeOf(value);
  const ctor = proto && proto.constructor && proto.constructor.name;
  return ctor || 'object';
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function reprString(s, max) {
  const body = clip(s, max - 2);
  return "'" + body.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
}

// A one-level preview, python-repr-like: deeper values render shallowly.
function repr(value, max, depth) {
  max = max || MAX_REPR;
  depth = depth || 0;
  try {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    const t = typeof value;
    if (t === 'string') return reprString(value, max);
    if (t === 'number' || t === 'boolean') return String(value);
    if (t === 'bigint') return String(value) + 'n';
    if (t === 'symbol') return value.toString();
    if (t === 'function') {
      return 'ƒ ' + (value.name || '') + '()';
    }
    if (Array.isArray(value)) {
      if (depth >= 1) return 'Array(' + value.length + ')';
      const parts = [];
      let used = 0;
      for (let i = 0; i < value.length; i++) {
        const piece = repr(value[i], 40, depth + 1);
        used += piece.length + 2;
        if (used > max) { parts.push('…'); break; }
        parts.push(piece);
      }
      return clip('[' + parts.join(', ') + ']', max);
    }
    if (value instanceof Map) return 'Map(' + value.size + ')';
    if (value instanceof Set) return 'Set(' + value.size + ')';
    if (value instanceof Date) return 'Date(' + value.toISOString() + ')';
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return clip(value.name + ': ' + value.message, max);
    if (ArrayBuffer.isView(value)) return typeName(value) + '(' + value.length + ')';
    if (depth >= 1) {
      const name = typeName(value);
      return name === 'Object' ? '{…}' : name;
    }
    const keys = Object.keys(value);
    const parts = [];
    let used = 0;
    for (const k of keys) {
      const piece = k + ': ' + repr(value[k], 40, depth + 1);
      used += piece.length + 2;
      if (used > max) { parts.push('…'); break; }
      parts.push(piece);
    }
    const name = typeName(value);
    const body = '{' + parts.join(', ') + '}';
    return clip(name === 'Object' ? body : name + ' ' + body, max);
  } catch (e) {
    return '<unrepresentable>';
  }
}

function isExpandable(value) {
  if (value === null || (typeof value !== 'object')) return false;
  try {
    if (Array.isArray(value)) return value.length > 0;
    if (value instanceof Map || value instanceof Set) return value.size > 0;
    if (ArrayBuffer.isView(value)) return value.length > 0;
    return Object.keys(value).length > 0;
  } catch (e) {
    return false;
  }
}

// [(name, value)] one level down, for the expand command.
function childItems(obj) {
  const items = [];
  try {
    if (Array.isArray(obj) || ArrayBuffer.isView(obj)) {
      for (let i = 0; i < obj.length && i < MAX_CHILDREN; i++) items.push(['[' + i + ']', obj[i]]);
    } else if (obj instanceof Map) {
      let i = 0;
      for (const [k, v] of obj) {
        if (i++ >= MAX_CHILDREN) break;
        items.push([repr(k, 40), v]);
      }
    } else if (obj instanceof Set) {
      let i = 0;
      for (const v of obj) {
        if (i >= MAX_CHILDREN) break;
        items.push(['{' + i + '}', v]);
        i++;
      }
    } else {
      for (const k of Object.keys(obj)) {
        if (items.length >= MAX_CHILDREN) break;
        items.push([k, obj[k]]);
      }
    }
  } catch (e) { /* partial children beat none */ }
  return items;
}

// ---- instrumentation ---------------------------------------------------------

// Babel plugin: before every statement in a block insert
//   __pb.l(<line>, __pbX => eval(__pbX), <namesIndex>)
// and wrap every function body as
//   __pb.enter(<name>); try { ...body } finally { __pb.exit(); }
// (function declarations are hoisted out of the try so calls before their
// textual position keep working). `debugger` statements become forced
// pauses. The names pool collects, per hook, the bindings visible at that
// statement, so the paused UI can list locals via the thunk.
function buildPlugin(namesPool) {
  const poolIndex = new Map();
  function namesIndexFor(path) {
    const names = [];
    const seen = new Set();
    let scope = path.scope;
    while (scope) {
      for (const name of Object.keys(scope.bindings)) {
        if (seen.has(name) || name.startsWith('__pb')) continue;
        seen.add(name);
        names.push(name);
        if (names.length >= MAX_VARS) break;
      }
      if (names.length >= MAX_VARS) break;
      const isFunctionScope = scope.path.isFunctionParent && scope.path.isFunctionParent();
      scope = scope.parent;
      if (isFunctionScope) break; // a frame lists its own scope, not its callers'
    }
    names.sort();
    const key = names.join(',');
    if (!poolIndex.has(key)) {
      poolIndex.set(key, namesPool.length);
      namesPool.push(names);
    }
    return poolIndex.get(key);
  }

  return function pbinDebugPlugin({ types: t }) {
    function makeThunk() {
      // __pbX => eval(__pbX): direct eval, so it closes over the scope the
      // hook sits in (loop variables included). Marked so the Function
      // visitor never wraps it in frame bookkeeping of its own.
      const arrow = t.arrowFunctionExpression(
        [t.identifier('__pbX')],
        t.callExpression(t.identifier('eval'), [t.identifier('__pbX')])
      );
      arrow._pbWrapped = true;
      return arrow;
    }
    function hookStatement(kind, line, path) {
      const call = t.callExpression(
        t.memberExpression(t.identifier('__pb'), t.identifier(kind)),
        [t.numericLiteral(line), makeThunk(), t.numericLiteral(namesIndexFor(path))]
      );
      const stmt = t.expressionStatement(call);
      stmt._pbHook = true;
      return stmt;
    }
    function functionName(path) {
      const n = path.node;
      if (n.id && n.id.name) return n.id.name;
      if (n.key && !n.computed) {
        if (n.key.name) return n.key.name;
        if (n.key.value !== undefined) return String(n.key.value);
      }
      const parent = path.parent;
      if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        return parent.id.name;
      }
      if (parent && parent.type === 'ObjectProperty' && parent.key && parent.key.name) {
        return parent.key.name;
      }
      return n.type === 'ArrowFunctionExpression' ? '<arrow>' : '<anonymous>';
    }

    return {
      visitor: {
        Statement(path) {
          const node = path.node;
          if (node._pbHook || node._pbWrapped) return;
          // ensureBlock's synthesized `return` keeps its expression's
          // location; fall back to it so arrow bodies still get a hook.
          const loc = node.loc || (node.argument && node.argument.loc);
          if (!loc) return;
          // Hooks go in statement lists only; single-statement bodies are
          // turned into blocks by the parent visitors below.
          const parentType = path.parentPath && path.parentPath.node.type;
          if (parentType !== 'Program' && parentType !== 'BlockStatement' && parentType !== 'SwitchCase') return;
          // Hoisted declarations run before any hook could; pausing "on"
          // them would misrepresent execution order.
          if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return;
          if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' ||
              node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration') return;
          // TypeScript-only statements (interfaces, type aliases, declares)
          // are erased by the typescript preset; a hook would outlive them.
          if (node.type.indexOf('TS') === 0) return;
          if (node.type === 'DebuggerStatement') {
            path.replaceWith(hookStatement('brk', loc.start.line, path));
            return;
          }
          path.insertBefore(hookStatement('l', loc.start.line, path));
        },
        // Give single-statement bodies real blocks so their hooks scope
        // correctly (and loop variables stay visible to the hook's thunk).
        'ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement'(path) {
          if (path.node.body && path.node.body.type !== 'BlockStatement') path.ensureBlock();
        },
        IfStatement(path) {
          const c = path.node.consequent;
          if (c && c.type !== 'BlockStatement') {
            path.get('consequent').replaceWith(t.blockStatement([c]));
          }
          const a = path.node.alternate;
          if (a && a.type !== 'BlockStatement' && a.type !== 'IfStatement') {
            path.get('alternate').replaceWith(t.blockStatement([a]));
          }
        },
        Function: {
          enter(path) {
            // Expression-bodied arrows become blocks up front, so the body
            // statement gets a line hook during normal traversal.
            if (path.node._pbWrapped) { path.skip(); return; }
            if (path.node.body.type !== 'BlockStatement') path.ensureBlock();
          },
          exit(path) {
            const node = path.node;
            if (node._pbWrapped) return;
            node._pbWrapped = true;
            const body = node.body.body;
            // Keep hoisting intact: function declarations move above the
            // try/finally wrapper (they are initialized before any
            // statement runs anyway).
            const hoisted = [];
            const rest = [];
            for (const stmt of body) {
              stmt._pbWrapped = true;
              (stmt.type === 'FunctionDeclaration' ? hoisted : rest).push(stmt);
            }
            const enter = t.expressionStatement(t.callExpression(
              t.memberExpression(t.identifier('__pb'), t.identifier('enter')),
              [t.stringLiteral(functionName(path)),
               t.numericLiteral(node.loc ? node.loc.start.line : 0)]
            ));
            enter._pbHook = true;
            enter._pbWrapped = true;
            const exit = t.expressionStatement(t.callExpression(
              t.memberExpression(t.identifier('__pb'), t.identifier('exit')), []
            ));
            exit._pbHook = true;
            exit._pbWrapped = true;
            // The catch fires at the throw site (innermost first as the
            // error unwinds), so __pb.exc can pause with the stack still
            // live; it rethrows unchanged, so program behavior is intact.
            const excCall = t.expressionStatement(t.callExpression(
              t.memberExpression(t.identifier('__pb'), t.identifier('exc')),
              [t.identifier('__pbExc')]
            ));
            excCall._pbHook = true;
            excCall._pbWrapped = true;
            const rethrow = t.throwStatement(t.identifier('__pbExc'));
            rethrow._pbHook = true;
            rethrow._pbWrapped = true;
            const catchClause = t.catchClause(
              t.identifier('__pbExc'),
              t.blockStatement([excCall, rethrow])
            );
            const wrapped = t.tryStatement(
              t.blockStatement(rest), catchClause, t.blockStatement([exit])
            );
            wrapped._pbHook = true; // no line hook in front of the wrapper
            wrapped._pbWrapped = true;
            node.body = t.blockStatement([...hoisted, enter, wrapped]);
            node.body._pbWrapped = true;
          },
        },
      },
    };
  };
}

function instrument(Babel, code, namesPool, lang) {
  const typescript = lang === 'typescript';
  const result = Babel.transform(code, {
    // 'unambiguous': imports/exports make it a module (then rewritten to
    // the require shim below), plain scripts stay scripts.
    sourceType: 'unambiguous',
    filename: typescript ? '/program.ts' : '/program.js',
    parserOpts: { allowReturnOutsideFunction: false },
    plugins: [buildPlugin(namesPool), 'transform-modules-commonjs'],
    // Type stripping happens in the same pass, after the plugins, so the
    // hooks carry the original line numbers.
    presets: typescript ? [['typescript', {}]] : [],
    retainLines: true,
    compact: false,
  });
  return result.code;
}

// ---- QuickJS std/os shims -----------------------------------------------------
// Enough of QuickJS's 'std' module that the stdin examples (hello-world.js)
// behave the same under the debugger as under the real runtime.
function makeModuleShims(stdinText, writeOut, writeErr) {
  let pos = 0;
  const stdIn = {
    getline() {
      if (pos >= stdinText.length) return null;
      const nl = stdinText.indexOf('\n', pos);
      const line = nl === -1 ? stdinText.slice(pos) : stdinText.slice(pos, nl);
      pos = nl === -1 ? stdinText.length : nl + 1;
      return line;
    },
    readAsString() {
      const rest = stdinText.slice(pos);
      pos = stdinText.length;
      return rest;
    },
    eof() { return pos >= stdinText.length; },
  };
  const std = {
    in: stdIn,
    out: { puts: (s) => writeOut(String(s)), printf: (...a) => writeOut(formatPrintf(a)) },
    err: { puts: (s) => writeErr(String(s)), printf: (...a) => writeErr(formatPrintf(a)) },
    exit(code) {
      const e = new Error('exit');
      e.__pbExit = typeof code === 'number' ? code : 0;
      throw e;
    },
    getenv() { return undefined; },
  };
  const os = {
    platform: 'browser',
    now: () => Date.now(),
  };
  return { std, os };
}

// A tiny %s/%d/%f/%% printf for the std shim.
function formatPrintf(args) {
  const fmt = String(args[0] == null ? '' : args[0]);
  let i = 1;
  return fmt.replace(/%[sdif%]/g, (m) => {
    if (m === '%%') return '%';
    const v = args[i++];
    if (m === '%d' || m === '%i') return String(Math.trunc(Number(v)));
    if (m === '%f') return String(Number(v));
    return String(v);
  });
}

// ---- the debugger -------------------------------------------------------------

function makeDebugger(debug, namesPool) {
  const ctrl = new Int32Array(debug.controlBuffer);
  const data = new Uint8Array(debug.dataBuffer);
  const decoder = new TextDecoder();

  let conditions = {};       // line -> condition source or null
  let pauseOnException = !!debug.pauseOnException;
  function setBreakpoints(breakpoints) {
    conditions = {};
    for (const bp of breakpoints || []) conditions[bp.line] = bp.condition || null;
  }
  // Resume commands carry {breakpoints, pauseOnException} (older: a bare
  // breakpoints array); accept both.
  function applyResumeConfig(payload) {
    if (Array.isArray(payload)) { setBreakpoints(payload); return; }
    if (payload && typeof payload === 'object') {
      setBreakpoints(payload.breakpoints);
      if ('pauseOnException' in payload) pauseOnException = !!payload.pauseOnException;
    }
  }
  setBreakpoints(debug.breakpoints);

  let lastExc = null;               // the exception we last paused on (skip re-pausing as it unwinds)
  let entry = !!debug.breakOnEntry; // pause on the first executed line
  let mode = 'run';                 // run | step_into | step_over | step_out
  let stepDepth = 0;
  const stack = [];                 // [{name, line, thunk, namesIdx}] outermost first
  const history = [];               // flight recorder of executed lines
  let cache = new Map();            // ref -> value, valid for the current pause
  let nextRef = 1;

  function register(value) {
    const ref = nextRef++;
    cache.set(ref, value);
    return ref;
  }

  function frameLocals(frame, withRefs) {
    const out = [];
    if (!frame.thunk) return out;
    const names = namesPool[frame.namesIdx] || [];
    for (const name of names) {
      let value;
      try {
        value = frame.thunk(name);
      } catch (e) {
        continue; // not yet initialized (TDZ) or otherwise unreadable
      }
      const entry = {
        n: name,
        t: typeName(value),
        v: withRefs ? repr(value, MAX_REPR) : repr(value, MAX_HIST_REPR),
      };
      if (withRefs && isExpandable(value)) entry.ref = register(value);
      out.push(entry);
    }
    return out;
  }

  // Innermost first, like the Python debugger's snapshots.
  function frameState(withRefs) {
    const frames = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      frames.push({ name: f.name, line: f.line, locals: frameLocals(f, withRefs) });
    }
    const top = stack[stack.length - 1];
    return { line: top ? top.line : 0, frames };
  }

  function snapshot() {
    cache = new Map();
    nextRef = 1;
    return frameState(true);
  }

  function record() {
    if (history.length >= HISTORY_LIMIT) history.shift();
    history.push(frameState(false));
  }

  function readData() {
    const length = Atomics.load(ctrl, 1);
    if (length <= 0) return '';
    return decoder.decode(data.slice(0, length));
  }

  function event(kind, payload) {
    self.postMessage({ type: 'debug-' + kind, payload });
  }

  function selectedFrame(request) {
    const fromTop = Math.min(Math.max(request.frame | 0, 0), stack.length - 1);
    return stack[stack.length - 1 - fromTop]; // the UI counts innermost-first
  }

  function doEval(payload) {
    const request = JSON.parse(payload);
    const frame = selectedFrame(request);
    let ok = true;
    let value;
    try {
      value = repr(frame.thunk(String(request.code)), MAX_REPR);
    } catch (e) {
      ok = false;
      value = e instanceof Error ? e.name + ': ' + e.message : String(e);
    }
    const state = snapshot();
    state.historyLen = history.length;
    event('eval', JSON.stringify({ ok, value, state }));
  }

  function doWatches(payload) {
    const request = JSON.parse(payload);
    const frame = selectedFrame(request);
    const values = [];
    for (const src of (request.exprs || []).slice(0, MAX_WATCHES)) {
      try {
        const result = frame.thunk('(' + String(src) + ')');
        const entry = { e: src, ok: true, v: repr(result, MAX_REPR), t: typeName(result) };
        if (isExpandable(result)) entry.ref = register(result);
        values.push(entry);
      } catch (e) {
        values.push({ e: src, ok: false, v: (e instanceof Error ? e.name + ': ' + e.message : String(e)) });
      }
    }
    event('watches', JSON.stringify({ frame: request.frame | 0, values }));
  }

  function doHistory(payload) {
    const request = JSON.parse(payload);
    const count = history.length;
    if (count === 0) {
      event('history', JSON.stringify({ index: 0, len: 0, state: null }));
      return;
    }
    const index = Math.min(Math.max(request.index | 0, 0), count - 1);
    event('history', JSON.stringify({ index, len: count, state: history[index] }));
  }

  function doExpand(payload) {
    const request = JSON.parse(payload);
    const ref = request.ref;
    if (!cache.has(ref)) {
      event('expand', JSON.stringify({ ref, children: [], expired: true }));
      return;
    }
    const children = childItems(cache.get(ref)).map(([n, v]) => {
      const entry = { n, t: typeName(v), v: repr(v, MAX_REPR) };
      if (isExpandable(v)) entry.ref = register(v);
      return entry;
    });
    event('expand', JSON.stringify({ ref, children }));
  }

  function pause(note) {
    const state = snapshot();
    state.historyLen = history.length;
    if (note) state.note = note;
    // Clear the command slot before announcing the pause: the main thread
    // only writes a command after it sees 'debug-paused'.
    Atomics.store(ctrl, 0, 0);
    self.postMessage({ type: 'debug-paused', state: JSON.stringify(state) });
    for (;;) {
      Atomics.wait(ctrl, 0, 0);
      const command = Atomics.exchange(ctrl, 0, 0);
      if (command === CMD.EVAL) { doEval(readData()); continue; }
      if (command === CMD.WATCHES) { doWatches(readData()); continue; }
      if (command === CMD.HISTORY) { doHistory(readData()); continue; }
      if (command === CMD.EXPAND) { doExpand(readData()); continue; }
      const payload = readData();
      if (payload) {
        try { applyResumeConfig(JSON.parse(payload)); } catch (e) { /* keep the old config */ }
      }
      if (command === CMD.STEP_INTO) {
        mode = 'step_into';
      } else if (command === CMD.STEP_OVER) {
        mode = 'step_over';
        stepDepth = stack.length;
      } else if (command === CMD.STEP_OUT) {
        mode = 'step_out';
        stepDepth = stack.length;
      } else {
        mode = 'run';
      }
      break;
    }
    event('resumed', '');
  }

  function conditionStop(cond, thunk) {
    try {
      return [!!thunk('(' + cond + ')'), null];
    } catch (e) {
      const why = e instanceof Error ? e.name + ': ' + e.message : String(e);
      return [true, 'breakpoint condition `' + cond + '` raised ' + why];
    }
  }

  // The __pb object the instrumented code calls.
  return {
    enter(name, line) {
      stack.push({ name, line, thunk: null, namesIdx: -1 });
    },
    exit() {
      stack.pop();
    },
    l(line, thunk, namesIdx) {
      const top = stack[stack.length - 1];
      top.line = line;
      top.thunk = thunk;
      top.namesIdx = namesIdx;
      record();
      if (entry) {
        entry = false;
        pause();
        return;
      }
      let note = null;
      let stop = false;
      if (line in conditions) {
        const cond = conditions[line];
        if (cond === null) stop = true;
        else [stop, note] = conditionStop(cond, thunk);
      }
      if (!stop && mode === 'step_into') {
        stop = true;
      } else if (!stop && (mode === 'step_over' || mode === 'step_out')) {
        if (mode === 'step_over' && stack.length <= stepDepth) stop = true;
        else if (mode === 'step_out' && stack.length < stepDepth) stop = true;
      }
      if (stop) pause(note);
    },
    brk(line, thunk, namesIdx) {
      const top = stack[stack.length - 1];
      top.line = line;
      top.thunk = thunk;
      top.namesIdx = namesIdx;
      record();
      pause();
    },
    // Called from each function body's (and the module's) catch clause as an
    // exception unwinds. The innermost catch fires first, so the stack is
    // still live here; pause once per exception (skip the outer catches it
    // passes through on the way up). std.exit() is not an error, so skip it.
    exc(err) {
      if (!pauseOnException || err === lastExc) return;
      if (err && err.__pbExit !== undefined) return;
      lastExc = err;
      const top = stack[stack.length - 1];
      let msg;
      try {
        msg = err instanceof Error ? (err.name + ': ' + err.message) : ('thrown: ' + repr(err, MAX_REPR));
      } catch (e) { msg = 'exception'; }
      if (top) pause('Exception — ' + msg);
    },
    stackDepth() { return stack.length; },
    lastState() { return history.length ? history[history.length - 1] : null; },
  };
}

// ---- run --------------------------------------------------------------------

// Type stripping for plain runs (code-runner.js's transpileTypeScript): no
// instrumentation, no module rewrite (QuickJS executes ES modules), just
// Babel's typescript preset with retainLines so the output's line numbers
// are the source's.
async function handleTranspile(data) {
  try {
    const Babel = await getBabel();
    const result = Babel.transform(data.code, {
      sourceType: 'unambiguous',
      filename: '/program.ts',
      presets: [['typescript', {}]],
      retainLines: true,
      compact: false,
    });
    self.postMessage({ type: 'transpiled', code: result.code });
  } catch (e) {
    self.postMessage({ type: 'transpile-error', error: String((e && e.message) || e) });
  }
}

self.onmessage = async (ev) => {
  if (ev.data && ev.data.transpile) {
    await handleTranspile(ev.data);
    return;
  }
  const { code, stdin, lang, debug } = ev.data;
  let stdout = '';
  let stderr = '';
  const writeOut = (text) => {
    stdout += text;
    if (text) self.postMessage({ type: 'stream', stream: 'stdout', text });
  };
  const writeErr = (text) => {
    stderr += text;
    if (text) self.postMessage({ type: 'stream', stream: 'stderr', text });
  };

  try {
    self.postMessage({ type: 'status', text: 'Loading JavaScript debugger...' });
    const Babel = await getBabel();

    const namesPool = [];
    let instrumented;
    try {
      instrumented = instrument(Babel, code, namesPool, lang);
    } catch (e) {
      // A parse error, reported like a runtime SyntaxError would be.
      writeErr(String(e && e.message || e) + '\n');
      self.postMessage({ type: 'result', stdout, stderr, exitCode: 1, files: [] });
      return;
    }

    const pb = makeDebugger(debug, namesPool);
    const { std, os } = makeModuleShims(stdin || '', writeOut, writeErr);

    // The paste's '@opentelemetry/api' imports (otel-shim.js) are served by
    // the require shim below. require is synchronous, so the factory is
    // fetched up front whenever the code mentions the module; finished
    // traces are collected here and returned on the result message rather
    // than printed, keeping the live output stream clean.
    const otelTraces = [];
    let otelFactory = null;
    let otelApi = null;
    if (code.indexOf('@opentelemetry/api') !== -1) {
      try { otelFactory = await getOtelFactory(); } catch (e) { /* require reports it */ }
    }

    const requireShim = (name) => {
      if (name === 'std' || name === 'qjs:std') return std;
      if (name === 'os' || name === 'qjs:os') return os;
      if (name === '@opentelemetry/api') {
        if (!otelFactory) throw new Error("Cannot load '@opentelemetry/api' (fetching the tracing shim failed)");
        if (!otelApi) {
          otelApi = otelFactory((json) => otelTraces.push(json), () => performance.now());
        }
        return otelApi;
      }
      if (/^https:\/\//.test(name)) {
        throw new Error("URL imports aren't supported under the debugger yet — run without it to use '" + name + "'");
      }
      throw new Error("Cannot find module '" + name + "' (the debugger provides only QuickJS's 'std' and 'os', and '@opentelemetry/api')");
    };

    // console/print go to the stream like QuickJS's would.
    const joinArgs = (args) => args.map((a) =>
      typeof a === 'string' ? a : repr(a, 1000)
    ).join(' ') + '\n';
    const console_ = {
      log: (...a) => writeOut(joinArgs(a)),
      info: (...a) => writeOut(joinArgs(a)),
      debug: (...a) => writeOut(joinArgs(a)),
      warn: (...a) => writeErr(joinArgs(a)),
      error: (...a) => writeErr(joinArgs(a)),
    };
    self.console = Object.assign({}, self.console, console_);
    self.print = (...a) => writeOut(joinArgs(a));

    self.postMessage({ type: 'status', text: 'Running code...' });

    // The program runs as the body of an async function, so top-level await
    // works; the module frame is pushed around it.
    let exitCode = 0;
    pb.enter('<module>', 1);
    try {
      // The outer try/catch gives top-level (non-function) throws a pause
      // point for "pause on exceptions" too — the module frame is still on
      // the stack here, so __pb.exc can show it before rethrowing.
      const factory = new Function(
        '__pb', 'require', 'exports', 'module', 'std', 'os',
        'return (async () => { try {\n' + instrumented +
        '\n} catch (__pbExc) { __pb.exc(__pbExc); throw __pbExc; } })();'
      );
      const moduleShim = { exports: {} };
      await factory(pb, requireShim, moduleShim.exports, moduleShim, std, os);
    } catch (err) {
      if (err && err.__pbExit !== undefined) {
        exitCode = err.__pbExit;
      } else {
        exitCode = 1;
        const name = (err && err.name) || 'Error';
        const message = err && err.message !== undefined ? err.message : String(err);
        // A pseudo-traceback from the shadow stack's last recorded lines,
        // innermost first like the browser's own stacks.
        let trace = '';
        const last = pb.lastState();
        if (last && last.frames) {
          trace = last.frames.map((f) => '    at ' + f.name + ' (line ' + f.line + ')').join('\n');
        }
        writeErr(name + ': ' + message + (trace ? '\n' + trace : '') + '\n');
      }
    } finally {
      pb.exit();
    }

    self.postMessage({ type: 'result', stdout, stderr, exitCode, files: [], otelTraces });
  } catch (err) {
    self.postMessage({ type: 'error', error: (err && err.message) || String(err) });
  }
};
