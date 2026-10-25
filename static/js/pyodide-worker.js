// Pyodide worker: runs Python (CPython compiled to WebAssembly) off the main
// thread, so heavy computation never freezes the editor and the main thread
// can cancel a run by terminating the worker.
//
// Protocol: the main thread posts {code, stdin, files: [{name, bytes}],
// debug}; the worker answers with {type: 'status', text} progress updates
// followed by one {type: 'result', stdout, stderr, exitCode, files: [{name,
// bytes}]} or {type: 'error', error}. The interpreter and any downloaded
// packages are kept across runs; after a cancel or timeout the main thread
// terminates the worker and the next run starts a fresh one.
//
// Debugging (static/js/debug.js): when debug is {breakpoints,
// controlBuffer, dataBuffer}, the program runs under a sys.settrace hook.
// On a breakpoint line the hook posts {type: 'debug-paused', state} with a
// JSON snapshot of the user stack, then blocks on Atomics.wait until the
// main thread stores a command in the control buffer (the page is
// cross-origin isolated, so SharedArrayBuffer and a blocked worker are
// fine). Commands 1-4 resume (continue / step over / step into / step out),
// carrying the current breakpoint lines as JSON in the data buffer; command
// 5 evaluates {frame, code} in a paused frame and answers with
// {type: 'debug-eval'}. Debug runs also stream stdout/stderr as
// {type: 'stream'} messages so prints show up before the next pause.

const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';

importScripts(PYODIDE_BASE + 'pyodide.js');

let pyodideReadyPromise = null;

function getPyodide() {
  if (pyodideReadyPromise === null) {
    pyodideReadyPromise = loadPyodide({ indexURL: PYODIDE_BASE });
  }
  return pyodideReadyPromise;
}

// Runs the user's program the way `python program.py` would: a fresh __main__
// namespace, SystemExit honored, any other exception printed as a traceback
// with exit code 1. eval_code_async also allows top-level await, so programs
// can `await micropip.install(...)` for pure-Python PyPI packages.
const DRIVER = `
async def _pbin_run(code):
    import sys, traceback
    from pyodide.code import eval_code_async
    ns = {'__name__': '__main__', '__doc__': None, '__package__': None}
    try:
        await eval_code_async(code, globals=ns, filename='<program>')
        return 0
    except SystemExit as e:
        if e.code is None:
            return 0
        if isinstance(e.code, int):
            return e.code
        print(e.code, file=sys.stderr)
        return 1
    except BaseException as e:
        # Trim the driver's and eval_code_async's own frames so the
        # traceback starts in the user's program. A SyntaxError has no
        # program frame; print_exception still shows its location.
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != '<program>':
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        return 1
_pbin_run
`;

// The same driver with a line tracer: only frames from '<program>' are
// traced, so the interpreter's and Pyodide's own code runs at full speed.
// pbdbg (installed below) is the bridge to the main thread.
const DEBUG_DRIVER = `
async def _pbin_debug_run(code, config_json):
    import sys, json, types, traceback, reprlib, collections, inspect, ast
    from js import pbdbg

    CONTINUE, STEP_OVER, STEP_INTO, STEP_OUT, EVAL, WATCHES, HISTORY, EXPAND = 1, 2, 3, 4, 5, 6, 7, 8
    MAX_VARS = 200
    MAX_REPR = 200
    MAX_WATCHES = 20
    MAX_CHILDREN = 200
    HISTORY_LIMIT = 200

    _LEAF = (type(None), bool, int, float, complex, str, bytes, bytearray)
    # Callables to hide when listing an object's attributes (methods, etc.);
    # plain data attributes are kept.
    _ROUTINE = tuple(t for t in (
        getattr(types, 'FunctionType', None), getattr(types, 'MethodType', None),
        getattr(types, 'BuiltinFunctionType', None), getattr(types, 'BuiltinMethodType', None),
        getattr(types, 'MethodWrapperType', None), getattr(types, 'WrapperDescriptorType', None),
        getattr(types, 'MethodDescriptorType', None), getattr(types, 'ClassMethodDescriptorType', None),
        getattr(types, 'GetSetDescriptorType', None), getattr(types, 'MemberDescriptorType', None),
    ) if t is not None)

    def safe_repr(value):
        try:
            text = repr(value)
        except BaseException:
            return '<unrepresentable>'
        if len(text) > MAX_REPR:
            text = text[:MAX_REPR] + '\\u2026'
        return text

    # History snapshots happen on every line, so use reprlib's bounded repr
    # there: it never materializes a huge collection's full repr.
    _hist_repr = reprlib.Repr()
    _hist_repr.maxstring = 120
    _hist_repr.maxother = 120
    _hist_repr.maxlevel = 3
    _hist_repr.maxlist = _hist_repr.maxtuple = _hist_repr.maxset = _hist_repr.maxdict = 10

    def hist_repr(value):
        try:
            return _hist_repr.repr(value)
        except BaseException:
            return '<unrepresentable>'

    # Control-flow exceptions Python raises internally (ending a for loop,
    # closing a generator); pausing on these would fire constantly, so
    # "pause on exceptions" skips them.
    _SKIP_EXC = (StopIteration, StopAsyncIteration, GeneratorExit)

    class Debugger:
        def __init__(self, breakpoints, break_on_entry=False, pause_on_exception=False):
            self.set_breakpoints(breakpoints)
            self.entry = break_on_entry   # pause on the first executed line
            self.pause_on_exception = pause_on_exception
            self.last_exc_id = None       # the exception we last paused on
            self.mode = 'run'      # run | step_into | step_over | step_out
            self.step_depth = 0
            self.frames = []       # user frames at the current pause, innermost first
            # A flight recorder of the last HISTORY_LIMIT executed lines,
            # browsed read-only from the UI ("step back").
            self.history = collections.deque(maxlen=HISTORY_LIMIT)
            self.cond_code = {}    # compiled breakpoint conditions, by source
            # Objects the UI can expand, keyed by a ref id. Rebuilt on every
            # pause (the objects are only valid while execution is stopped).
            self.cache = {}
            self.next_ref = 1

        def _register(self, obj):
            ref = self.next_ref
            self.next_ref += 1
            self.cache[ref] = obj
            return ref

        def is_expandable(self, value):
            # Leaves never expand; collections expand when non-empty; anything
            # else expands when it exposes any data attribute.
            if isinstance(value, _LEAF):
                return False
            try:
                if isinstance(value, (list, tuple, set, frozenset, dict)):
                    return len(value) > 0
            except BaseException:
                return False
            return len(self._object_items(value, 1)) > 0

        def _object_items(self, obj, limit):
            # Data attributes of an arbitrary object: instance __dict__ plus
            # everything dir() exposes (so class attributes and dataclass
            # fields show too), skipping dunders and callables (methods).
            items = []
            seen = set()
            d = getattr(obj, '__dict__', None)
            ordered = []
            if isinstance(d, dict):
                ordered.extend([k for k in d.keys() if isinstance(k, str)])
            try:
                ordered.extend(dir(obj))
            except BaseException:
                pass
            for n in ordered:
                if len(items) >= limit:
                    break
                if not isinstance(n, str) or n in seen:
                    continue
                if n.startswith('__') and n.endswith('__'):
                    continue
                seen.add(n)
                try:
                    v = getattr(obj, n)
                except BaseException as e:
                    items.append((n, e)); continue
                if isinstance(v, _ROUTINE) or isinstance(v, type):
                    continue
                items.append((n, v))
            return items

        def _child_items(self, obj):
            # [(name, value)] for the expandable children of obj.
            items = []
            try:
                if isinstance(obj, dict):
                    for k, v in list(obj.items())[:MAX_CHILDREN]:
                        items.append((safe_repr(k), v))
                elif isinstance(obj, (list, tuple)):
                    for i, v in enumerate(obj):
                        if i >= MAX_CHILDREN:
                            break
                        items.append(('[%d]' % i, v))
                elif isinstance(obj, (set, frozenset)):
                    for i, v in enumerate(obj):
                        if i >= MAX_CHILDREN:
                            break
                        items.append(('{%d}' % i, v))
                else:
                    items = self._object_items(obj, MAX_CHILDREN)
            except BaseException:
                pass
            return items

        def var_entry(self, name, value, with_refs):
            entry = {'n': name, 't': type(value).__name__,
                     'v': safe_repr(value) if with_refs else hist_repr(value)}
            if with_refs and self.is_expandable(value):
                entry['ref'] = self._register(value)
            return entry

        def do_expand(self, payload):
            request = json.loads(payload)
            ref = request.get('ref')
            obj = self.cache.get(ref, None) if ref is not None else None
            if obj is None and ref not in self.cache:
                pbdbg.event('expand', json.dumps({'ref': ref, 'children': [], 'expired': True}))
                return
            children = [self.var_entry(n, v, True) for n, v in self._child_items(self.cache[ref])]
            pbdbg.event('expand', json.dumps({'ref': ref, 'children': children}))

        def set_breakpoints(self, breakpoints):
            # [{line, condition}] -> {line: condition or None}
            self.conditions = {}
            for bp in breakpoints:
                self.conditions[bp['line']] = bp.get('condition') or None

        def apply_resume_config(self, payload):
            # Resume commands carry {breakpoints, pauseOnException} (older: a
            # bare breakpoints list); accept both.
            if isinstance(payload, dict):
                self.set_breakpoints(payload.get('breakpoints') or [])
                if 'pauseOnException' in payload:
                    self.pause_on_exception = bool(payload['pauseOnException'])
            else:
                self.set_breakpoints(payload or [])

        def user_depth(self, frame):
            depth = 0
            while frame is not None:
                if frame.f_code.co_filename == '<program>':
                    depth += 1
                frame = frame.f_back
            return depth

        def frame_state(self, frame, keep):
            # keep=True builds the live snapshot (full reprs + expandable refs)
            # and remembers the frames; keep=False is a cheap history record.
            if keep:
                self.frames = []
            frames_out = []
            f = frame
            while f is not None:
                if f.f_code.co_filename == '<program>':
                    if keep:
                        self.frames.append(f)
                    local_vars = []
                    for name, value in list(f.f_locals.items())[:MAX_VARS]:
                        if name.startswith('__') and name.endswith('__'):
                            continue
                        if isinstance(value, types.ModuleType):
                            continue
                        local_vars.append(self.var_entry(name, value, keep))
                    frames_out.append({'name': f.f_code.co_name, 'line': f.f_lineno, 'locals': local_vars})
                f = f.f_back
            return {'line': frame.f_lineno, 'frames': frames_out}

        def snapshot(self, frame):
            # Fresh pause (or re-snapshot): invalidate expand refs, rebuild.
            self.cache = {}
            self.next_ref = 1
            return self.frame_state(frame, True)

        def do_eval(self, payload):
            request = json.loads(payload)
            index = min(max(int(request.get('frame', 0)), 0), len(self.frames) - 1)
            f = self.frames[index]
            src = request.get('code', '')
            try:
                try:
                    value = safe_repr(eval(compile(src, '<debug>', 'eval'), f.f_globals, f.f_locals))
                except SyntaxError:
                    # Not an expression: run it as a statement (assignments
                    # write through to the paused frame, PEP 667).
                    exec(compile(src, '<debug>', 'exec'), f.f_globals, f.f_locals)
                    value = 'ok'
                ok = True
            except BaseException as e:
                value = '%s: %s' % (type(e).__name__, e)
                ok = False
            # Re-snapshot so the variables pane reflects any mutation.
            state = self.snapshot(self.frames[0])
            state['historyLen'] = len(self.history)
            pbdbg.event('eval', json.dumps({'ok': ok, 'value': value, 'state': state}))

        def do_watches(self, payload):
            request = json.loads(payload)
            index = min(max(int(request.get('frame', 0)), 0), len(self.frames) - 1)
            f = self.frames[index]
            values = []
            for src in request.get('exprs', [])[:MAX_WATCHES]:
                try:
                    result = eval(compile(src, '<watch>', 'eval'), f.f_globals, f.f_locals)
                    entry = {'e': src, 'ok': True, 'v': safe_repr(result), 't': type(result).__name__}
                    if self.is_expandable(result):
                        entry['ref'] = self._register(result)
                    values.append(entry)
                except BaseException as e:
                    values.append({'e': src, 'ok': False, 'v': '%s: %s' % (type(e).__name__, e)})
            pbdbg.event('watches', json.dumps({'frame': index, 'values': values}))

        def do_history(self, payload):
            request = json.loads(payload)
            count = len(self.history)
            if count == 0:
                pbdbg.event('history', json.dumps({'index': 0, 'len': 0, 'state': None}))
                return
            index = min(max(int(request.get('index', 0)), 0), count - 1)
            pbdbg.event('history', json.dumps({'index': index, 'len': count, 'state': self.history[index]}))

        def record(self, frame):
            self.history.append(self.frame_state(frame, False))

        def condition_stop(self, cond, frame):
            # A condition that raises pauses too (and says so), instead of
            # silently never firing.
            code = self.cond_code.get(cond)
            try:
                if code is None:
                    code = compile(cond, '<breakpoint>', 'eval')
                    self.cond_code[cond] = code
                return bool(eval(code, frame.f_globals, frame.f_locals)), None
            except BaseException as e:
                return True, 'breakpoint condition %r raised %s: %s' % (cond, type(e).__name__, e)

        def pause(self, frame, note=None):
            state = self.snapshot(frame)
            state['historyLen'] = len(self.history)
            if note:
                state['note'] = note
            pbdbg.pause(json.dumps(state))
            while True:
                command = pbdbg.wait()
                if command == EVAL:
                    self.do_eval(pbdbg.readData())
                    continue
                if command == WATCHES:
                    self.do_watches(pbdbg.readData())
                    continue
                if command == HISTORY:
                    self.do_history(pbdbg.readData())
                    continue
                if command == EXPAND:
                    self.do_expand(pbdbg.readData())
                    continue
                payload = pbdbg.readData()
                if payload:
                    try:
                        self.apply_resume_config(json.loads(payload))
                    except (ValueError, TypeError, KeyError):
                        pass
                if command == STEP_INTO:
                    self.mode = 'step_into'
                elif command == STEP_OVER:
                    self.mode = 'step_over'
                    self.step_depth = self.user_depth(frame)
                elif command == STEP_OUT:
                    self.mode = 'step_out'
                    self.step_depth = self.user_depth(frame)
                else:
                    self.mode = 'run'
                break
            self.frames = []
            pbdbg.event('resumed', '')

        def trace(self, frame, event, arg):
            if frame.f_code.co_filename != '<program>':
                return None
            if event == 'exception':
                # arg is (type, value, traceback). settrace delivers this
                # event in each frame as the exception propagates, innermost
                # first — so the first time we see a given exception is its
                # throw site, with the stack still live.
                if self.pause_on_exception:
                    exc_type, exc_value = arg[0], arg[1]
                    if not issubclass(exc_type, _SKIP_EXC) and id(exc_value) != self.last_exc_id:
                        self.last_exc_id = id(exc_value)
                        self.record(frame)
                        self.pause(frame, 'Exception — %s: %s' % (exc_type.__name__, exc_value))
                return self.trace
            if event == 'line':
                self.record(frame)
                if self.entry:
                    self.entry = False
                    self.pause(frame)
                    return self.trace
                note = None
                stop = False
                if frame.f_lineno in self.conditions:
                    cond = self.conditions[frame.f_lineno]
                    if cond is None:
                        stop = True
                    else:
                        stop, note = self.condition_stop(cond, frame)
                if not stop and self.mode == 'step_into':
                    stop = True
                elif not stop and self.mode in ('step_over', 'step_out'):
                    depth = self.user_depth(frame)
                    if self.mode == 'step_over' and depth <= self.step_depth:
                        stop = True
                    elif self.mode == 'step_out' and depth < self.step_depth:
                        stop = True
                if stop:
                    self.pause(frame, note)
            return self.trace

    config = json.loads(config_json)
    debugger = Debugger(config.get('breakpoints') or [], bool(config.get('breakOnEntry')), bool(config.get('pauseOnException')))
    ns = {'__name__': '__main__', '__doc__': None, '__package__': None}

    # Run with a plain exec rather than pyodide's eval_code_async: the latter
    # re-visits source lines while driving the wrapped coroutine (line 1 is
    # traced again after line 2), which re-triggers breakpoints. Compiling the
    # user code directly (allowing top-level await, and awaiting the resulting
    # coroutine only when the code actually uses it) traces each line once.
    sys.settrace(debugger.trace)
    try:
        program = compile(code, '<program>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        if program.co_flags & inspect.CO_COROUTINE:
            await eval(program, ns)
        else:
            exec(program, ns)
        return 0
    except SystemExit as e:
        if e.code is None:
            return 0
        if isinstance(e.code, int):
            return e.code
        print(e.code, file=sys.stderr)
        return 1
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != '<program>':
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        return 1
    finally:
        sys.settrace(None)
_pbin_debug_run
`;

// The JS side of the pause protocol, called from the tracer via \`from js
// import pbdbg\`. Commands and the buffer layout are shared with
// static/js/debug.js.
function installDebugBridge(debug) {
  if (!debug) {
    self.pbdbg = undefined;
    return;
  }
  const ctrl = new Int32Array(debug.controlBuffer);
  const data = new Uint8Array(debug.dataBuffer);
  const decoder = new TextDecoder();
  self.pbdbg = {
    pause(stateJson) {
      // Clear the command slot before announcing the pause: the main thread
      // only writes a command after it sees 'debug-paused', so wait() below
      // cannot miss it.
      Atomics.store(ctrl, 0, 0);
      self.postMessage({ type: 'debug-paused', state: stateJson });
    },
    wait() {
      Atomics.wait(ctrl, 0, 0);
      return Atomics.exchange(ctrl, 0, 0);
    },
    readData() {
      const length = Atomics.load(ctrl, 1);
      if (length <= 0) return '';
      // slice copies out of the SharedArrayBuffer (TextDecoder rejects
      // shared views).
      return decoder.decode(data.slice(0, length));
    },
    event(kind, payload) {
      self.postMessage({ type: 'debug-' + kind, payload });
    },
  };
}

// Empty the directory so each run sees only its own attached input files.
function clearDir(FS, dir) {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = dir + '/' + name;
    const mode = FS.stat(path).mode;
    if (FS.isDir(mode)) {
      clearDir(FS, path);
      FS.rmdir(path);
    } else {
      FS.unlink(path);
    }
  }
}

self.onmessage = async (ev) => {
  const { code, stdin, files, debug } = ev.data;
  try {
    self.postMessage({ type: 'status', text: 'Loading Python runtime (Pyodide)...' });
    const pyodide = await getPyodide();

    const cwd = pyodide.FS.cwd();
    clearDir(pyodide.FS, cwd);
    for (const f of files) {
      pyodide.FS.writeFile(cwd + '/' + f.name, f.bytes);
    }

    // Stdin is the Input tab's text, served as one chunk then EOF, like a
    // pipe: read-to-end gets everything, line reads consume it line by line.
    let stdinSent = false;
    pyodide.setStdin({
      stdin: () => {
        if (stdinSent) return null;
        stdinSent = true;
        return stdin;
      },
      autoEOF: false,
      isatty: false,
    });

    let stdout = '';
    let stderr = '';
    const outDecoder = new TextDecoder();
    const errDecoder = new TextDecoder();
    pyodide.setStdout({
      write: (buf) => {
        const text = outDecoder.decode(buf, { stream: true });
        stdout += text;
        // While debugging, stream prints live so they show up before the
        // next pause instead of all at once at the end.
        if (debug && text) self.postMessage({ type: 'stream', stream: 'stdout', text });
        return buf.length;
      },
    });
    pyodide.setStderr({
      write: (buf) => {
        const text = errDecoder.decode(buf, { stream: true });
        stderr += text;
        if (debug && text) self.postMessage({ type: 'stream', stream: 'stderr', text });
        return buf.length;
      },
    });

    // Download any imported packages that ship with Pyodide (numpy, scipy,
    // pandas, micropip, ...) before running. A syntax error in the code
    // surfaces here too; ignore it — the run below reports it properly.
    try {
      await pyodide.loadPackagesFromImports(code, {
        messageCallback: (msg) => self.postMessage({ type: 'status', text: msg }),
      });
    } catch (e) { /* reported by the run */ }

    installDebugBridge(debug);

    self.postMessage({ type: 'status', text: 'Running code...' });
    const run = pyodide.runPython(debug ? DEBUG_DRIVER : DRIVER);
    let exitCode;
    try {
      exitCode = debug
        ? await run(code, JSON.stringify({ breakpoints: debug.breakpoints, breakOnEntry: !!debug.breakOnEntry, pauseOnException: !!debug.pauseOnException }))
        : await run(code);
    } finally {
      run.destroy();
    }
    stdout += outDecoder.decode();
    stderr += errDecoder.decode();

    // Root-level files the program created in its working directory, offered
    // as downloads by the main thread.
    const created = [];
    const inputNames = new Set(files.map((f) => f.name));
    for (const name of pyodide.FS.readdir(cwd)) {
      if (name === '.' || name === '..' || inputNames.has(name)) continue;
      const mode = pyodide.FS.stat(cwd + '/' + name).mode;
      if (!pyodide.FS.isFile(mode)) continue;
      created.push({ name, bytes: pyodide.FS.readFile(cwd + '/' + name) });
    }

    self.postMessage({ type: 'result', stdout, stderr, exitCode, files: created });
  } catch (err) {
    self.postMessage({ type: 'error', error: (err && err.message) || String(err) });
  }
};
