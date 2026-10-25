# Browser runtime feature reference

This reference preserves the browser/editor feature documentation from upstream
the clean public baseline. The supported backend is now WordPress single-user HTTP autosave;
client runtimes are not server executables. Experimental branches are not
implicitly supported or merged by the backend migration. See
[the current gate matrix](../wordpress/ci/README.md).

## Browser-Based Code Execution

The editor includes browser-based code execution powered by Runno, allowing you to run code directly in your browser without any server-side execution:

1. Select a language from the dropdown (languages with ▶ support execution)
2. Write or paste your code in the editor
3. Click the "Run" button or press `Ctrl+Enter`
4. View the output in the Output panel

**What works per language:**

| Language | Runtime | Stdin (Input tab) | Input files | Created files download | Echo Input | Parse JSON |
|---|---|---|---|---|---|---|
| Python | CPython 3.13 (Pyodide) | ✅ | ✅ | ✅ | ✅ | ✅ `json` module |
| Ruby | Ruby 3.2 (WASI, @runno/wasi) | ✅ | ✅ | ✅ | ✅ | ✅ `json` stdlib |
| JavaScript | quickjs-ng (WASI, self-hosted) | ✅ via `std` module | ✅ | ✅ | ✅ | ✅ `JSON.parse` |
| TypeScript | Babel strips types (lines preserved) → QuickJS | ✅ via `std` module | ✅ | ✅ | ✅ | ✅ `JSON.parse` |
| C / C++ | wasm-clang (clang 8 + lld in-browser) | ✅ | ✅ | ❌ | ✅ | ❌ no JSON library in the runtime |
| Shell | bash (Wasmer SDK) | ✅ | ✅ mounted at `/work` (cwd) | ❌ | ✅ | ❌ no `jq` in the runtime |
| Scheme | BiwaScheme (JS interpreter) | ✅ via `(read-line)` | ❌ no filesystem | ❌ | ✅ | ✅ `JSON.parse` via js interop |
| Picat | Picat (Emscripten WASM) | ✅ | ✅ | ❌ | ✅ | ❌ no JSON module in the runtime |
| MiniZinc | MiniZinc + Gecode (WASM) | data, not stdin: JSON or `.dzn` | ❌ | ❌ | ✅ (`.dzn` demo) | ✅ JSON as model data |
| TLA+ | TLA+ checker (WASM worker) | ❌ | ❌ | ❌ | ❌ | ❌ |
| JSX/React | React 18 + Babel (DOM render) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Mermaid | mermaid.js (SVG render) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Markdown | marked + DOMPurify (HTML render) | ❌ | ❌ | ❌ | ❌ | ❌ |
| AutoLISP | acadlisp (WASM) | ❌ | ❌ | ❌ | ❌ | ❌ |

The Output panel's **Download** button works for every language (it saves
whatever the run printed or rendered).

All code execution happens locally in your browser using WebAssembly — nothing
runs server-side. Programs themselves have no network access; the runtimes
(and, for Python, imported packages) are downloaded from CDNs.

### Python packages

Python runs on [Pyodide](https://pyodide.org), which ships prebuilt wheels for
much of the scientific stack. Importing a bundled package (numpy, scipy,
pandas, scikit-learn, matplotlib, ...) just works — the wheel is fetched
automatically before the program runs and cached by the browser. Pure-Python
packages from PyPI can be installed at the top of a program with micropip,
using top-level await:

```python
import micropip
await micropip.install("tabulate")

from tabulate import tabulate
print(tabulate([["scipy", "yes"], ["pip", "micropip"]]))
```

### Debugger (Python, JavaScript, TypeScript)

Python, JavaScript and TypeScript runs can be debugged with real
breakpoints, in the browser:

The debugger lives in its own **debug** tab, a document like code / input /
output: it is always available on a debuggable paste, drags between the
editor groups like any tab, and is brought on screen automatically when a
run pauses (docked beside the code, so the paused line stays visible).

1. Click the editor gutter (left of the line numbers) — or press `F9` — to
   toggle a breakpoint. Right-click the gutter dot to give it a
   **condition**: an expression in the paste's language, evaluated in the
   paused frame, so the run only pauses when it is truthy (a condition that
   raises pauses too, and says so). The debug tab lists every breakpoint
   with a checkbox to **enable/disable** it without losing it, plus
   condition editing and removal; clicking an entry jumps to its line. The
   list header has **enable all / disable all** and **delete all** controls.
2. The caret next to Run (debuggable pastes) is a persistent toggle for what
   the Run button does, remembered per paste:
   - **run** (default) executes the program normally, ignoring breakpoints.
   - **run in debugger** attaches a line tracer: a `sys.settrace` hook in
     the Pyodide worker for Python, or — for JavaScript/TypeScript — a
     dedicated worker that runs the paste instrumented by Babel (per-line
     hooks whose `eval` closures let the panel read and write the live
     scope; TypeScript's types are stripped in the same pass). It pauses at
     enabled breakpoints, or — when there are none — at the first line, so
     a program can be stepped from the start.
   The Run button shows the active mode (it reads "Debug" in debugger mode).
3. While paused, the debug tab shows the call stack and
   each frame's variables. Complex values — objects, lists, dicts, sets —
   show a **disclosure triangle**: click it to expand them one level at a
   time (object attributes, list items, dict entries), drilling as deep as
   you need, so an opaque `<Hand object at 0x…>` becomes its real contents.
   **Click a variable's value to rewrite it** — the
   assignment goes into the live frame, so the program continues with the
   new value. The **watch** column re-evaluates your expressions in the
   selected frame on every pause, frame switch and mutation — click an
   expression to edit it in place (watches can also be managed between
   runs, in the idle debug tab) — and an input box evaluates ad-hoc
   expressions (statements like `x = 5` work too).
4. **continue** (`F8`), **step over** (`F10`), **step into** (`F11`) and
   **step out** (`Shift+F11`) resume; **stop** terminates the run.
   The **pause on exceptions** checkbox (in the breakpoints column, remembered
   per paste) pauses the moment an exception is thrown or raised, with the
   call stack still live — so you land on the line that failed, with every
   frame's variables there to inspect, instead of just reading a traceback
   after the fact. It pauses once per exception, at the innermost throw site,
   then propagates normally on continue. With no breakpoints set it simply
   runs until something throws. (Python skips the control-flow exceptions it
   raises internally — `StopIteration`, `GeneratorExit` — so ordinary loops
   don't trip it.)
5. **back / fwd** browse a recording of the last ~200 executed lines (line,
   stack and variables at each step) read-only — step backwards to see how
   the program got here, then forward to return to the live pause. True
   reverse *execution* isn't possible, so history is inspection only: eval
   and variable editing are disabled while browsing it.

Prints stream into the Output panel live during a debug run, and breakpoint
changes made while paused take effect on resume. Breakpoints and watches are
remembered per paste in your browser and are not shared with the room. The
pause mechanism blocks the worker on `Atomics.wait` over a
`SharedArrayBuffer`, which needs the cross-origin isolation headers the
server already sends (COOP/COEP). Debug runs are exempt from the 30-second
execution timeout. Runs without the debugger take the plain fast path with
no tracing overhead.

JavaScript/TypeScript debug runs execute on the browser's own engine inside
a locked-down worker (network and storage APIs are removed before user code
runs) rather than on QuickJS, which exposes no pause hooks; `console`,
`print` and minimal QuickJS `std`/`os` shims keep the stdin examples
working, and plain runs stay on QuickJS.

### Tracing (JavaScript, TypeScript): OpenTelemetry spans

JavaScript and TypeScript pastes can instrument themselves with
OpenTelemetry-style spans and get a Tempo/Jaeger-style **span waterfall**
in its own **trace** tab — a document like code/input/output, appearing
whenever a run emits traces — opt-in, by importing the API exactly as it
would be imported against the real SDK:

```ts
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('demo');
tracer.startActiveSpan('main', (root) => {
  tracer.startActiveSpan('step-1', (span) => {
    span.setAttribute('n', 42);
    span.addEvent('checkpoint');
    span.end();
  });
  root.end();
});
```

Each trace renders as a waterfall when its **root span ends**: one row per
span, nested under its parent, a time-proportional bar (colored by tracer,
error-status spans outlined), events as diamonds on the bar; clicking a row
shows the span's attributes, events, status and ids. Copy/Download of the
output return the trace as JSON.

The module is a small in-paste shim (`static/js/otel-shim.js`) with an
in-memory span processor instead of an OTLP exporter, so the same paste runs
unchanged in Node against the real `@opentelemetry/api`. It covers
`trace.getTracer`, `startSpan`/`startActiveSpan` (all overloads),
attributes, events, `recordException`, `setStatus`, `SpanKind`,
`SpanStatusCode`, and explicit parenting via `context`/`trace.setSpan`.
Pastes that don't import it are completely unaffected. It works under both
run modes: plain QuickJS runs smuggle finished traces out of the WASI
sandbox as sentinel lines on stdout (stripped back out of the displayed
output), and debugger runs return them on the worker's result message.

Two departures from the real SDK, both playground-friendly: a throw out of a
`startActiveSpan` callback (or a rejection of the promise it returns)
records the exception, marks the span `ERROR` and ends it before rethrowing,
so the trace survives the crash; and since neither runtime has
`AsyncLocalStorage`, the active span is a plain stack — correct for
synchronous code and sequential `await`s, while concurrent branches
(`Promise.all` of traced work) should pass parent context explicitly:
`tracer.startSpan(name, opts, ctx)`. (Effect users don't hit this one — see
"URL module imports" below.)

### URL module imports (JavaScript, TypeScript)

Plain JavaScript/TypeScript runs support Deno-style `https://` imports from
module CDNs — `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`:

```ts
import { Effect } from 'https://esm.sh/effect@3.12.0?bundle';
```

The sandbox itself stays offline: like Deno, the module graph is resolved
and fetched *before* execution — on the page, from those allowlisted hosts
only, so a shared paste can't make a viewer's browser fetch arbitrary URLs —
and mirrored into the program's virtual filesystem, where QuickJS executes
it with no network access, same as any other run. Fetched modules are cached
for the page's lifetime, so re-runs are offline. A small web-globals prelude
(`static/js/qjs-web-globals.js`: `Blob`, `TextEncoder`/`TextDecoder`, `URL`,
timers) is evaluated first, because CDN modules routinely reference those at
module-evaluation time. Limits: statically visible imports only (a dynamic
`import()` of a computed URL won't resolve), 600 modules / 32 MB per graph,
plain runs only (the debugger reports URL imports as unsupported).

The marquee use: **Effect with traced spans**. The runner serves a
`pbin/effect-tracing` module whose layer routes `Effect.withSpan` into the
same span waterfall as the OTel shim — with correctly parented spans under
concurrency, since Effect carries the parent on its fibers:

```ts
import { Effect, Tracer, Layer, Cause } from 'https://esm.sh/effect@3.12.0?bundle';
import { makeEffectTracing } from 'pbin/effect-tracing';

const TracingLive = makeEffectTracing({ Tracer, Layer, Cause });

const step = (name: string, n: number) =>
  Effect.sync(() => { let s = 0; for (let i = 0; i < n; i++) s += Math.sqrt(i); return s; })
    .pipe(Effect.withSpan(name, { attributes: { n } }));

const program = Effect.gen(function* () {
  yield* step('step-one', 200_000);
  yield* Effect.all([step('par-a', 120_000), step('par-b', 90_000)], { concurrency: 2 });
}).pipe(Effect.withSpan('main-effect'));

await Effect.runPromise(program.pipe(Effect.provide(TracingLive)));
```

`makeEffectTracing` takes your own Effect modules rather than importing its
own copy, so the layer always composes with the Effect instance your paste
actually runs on. The **Effect Trace** toolbar button (JavaScript and
TypeScript pastes) inserts a ready-to-run example — concurrent fibers and a
recovered failure included — like the Hello World starter does.

### Custom Input (stdin and files)

The editor pane has an **Input** tab for feeding data to your program:

- **Stdin text:** whatever you type or paste in the Input tab is sent to the
  program as stdin (Python, Ruby, JavaScript, TypeScript, C/C++, Shell,
  Scheme, Picat). For MiniZinc it is read as data — JSON or `.dzn` (e.g.
  `n = 5;`).
- **Files:** attach any files — images, videos, data sets — and they appear by
  name in the program's working directory (Python, Ruby, JavaScript,
  TypeScript, C/C++, Shell, Picat). Files stay in your browser's memory and
  are never uploaded.

The stdin text is remembered per paste in your browser; it is not shared with
the room.

For ready-made examples, the **Echo Input** toolbar button (shown for
stdin-capable languages) inserts a program that reads stdin and prints it
back, and **Parse JSON** (shown for languages whose runtime has a real JSON
parser) inserts one that reads JSON from the Input tab, parses it, and
prints each key and value. Both seed the Input tab with sample text — press
Run to see the round trip. For MiniZinc, JSON in the Input tab becomes the
model's data (keys must match the declared parameters); anything else is
read as `.dzn`.

### Downloading Output

- The Output panel's **Download** button saves the output as `output.txt`
  (or `output.svg` for rendered diagrams).
- Files your program creates in its working directory (Python, Ruby,
  JavaScript) are listed under the output with a download button each.

## React/JSX Live Rendering

Write and render React components directly in the browser with live preview:

1. Select "jsx" from the language dropdown
2. Write your React component code using JSX syntax
3. Click "Run" to see your component rendered live in the output panel

**Features:**
- Full React 18 support with hooks (useState, useEffect, etc.)
- JSX syntax transformation via Babel Standalone
- Live rendering in the output viewer
- Interactive components with event handling
- No build step required - runs entirely in the browser

**Example:**
```jsx
function App() {
  const [count, setCount] = React.useState(0);

  return (
    <div>
      <h1>Counter: {count}</h1>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
}
```

See `examples/react-example.jsx` for a complete example.
