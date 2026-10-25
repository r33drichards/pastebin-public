// Code Runner Module
// Modular code execution functionality for PBIN pastebin

// Global execution state tracking
let executionState = {
  isRunning: false,
  shouldCancel: false,
  timeoutId: null
};

// Lazy initialization for MiniZinc (similar to sync.OnceValue in Go)
let miniZincInitPromise = null;
let miniZincModule = null;

async function getMiniZinc() {
  if (miniZincInitPromise === null) {
    miniZincInitPromise = (async () => {
      // Dynamically load MiniZinc library from CDN
      const MiniZinc = await import('https://cdn.jsdelivr.net/npm/minizinc/dist/minizinc.mjs');

      // Initialize MiniZinc with WASM (only called once)
      await MiniZinc.init({
        workerURL: 'https://cdn.jsdelivr.net/npm/minizinc/dist/minizinc-worker.js',
        wasmURL: 'https://cdn.jsdelivr.net/npm/minizinc/dist/minizinc.wasm',
        dataURL: 'https://cdn.jsdelivr.net/npm/minizinc/dist/minizinc.data'
      });

      miniZincModule = MiniZinc;
      return MiniZinc;
    })();
  }
  return miniZincInitPromise;
}

// Cancel execution function
function cancelExecution() {
  if (executionState.isRunning) {
    executionState.shouldCancel = true;
    // Actually stop the TLA+ worker if one is mid-check (terminate() is the only
    // way to interrupt the synchronous WASM model-checking loop).
    terminateTlaWorker();
    // Likewise for a Python run (Pyodide); the interpreter reloads on the
    // next run.
    terminatePyodideWorker();
    // And for a Clojure run (SCI); a fresh interpreter spawns on the next run.
    terminateClojureWorker();
    // And for a JavaScript debug run (its worker may be blocked on a pause).
    terminateJsDebugWorker();
    if (executionState.timeoutId) {
      clearTimeout(executionState.timeoutId);
    }

    const outputEl = document.getElementById("output");
    if (outputEl) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled by user</div>';
    }

    // Reset UI state
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
    executionState.isRunning = false;
  }
}

// Helper function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Helper function to convert ANSI color codes to HTML
function ansiToHtml(text) {
  if (typeof AnsiUp !== 'undefined') {
    const ansi_up = new AnsiUp();
    return ansi_up.ansi_to_html(text);
  }
  return escapeHtml(text);
}

// ---- Custom input (stdin + attached files) --------------------------------
// The Input tab (templates/paste.html) exposes window.pbinInput; runs read it
// through these helpers. Pages without the tab simply have no input.

function getStdinText() {
  try { return (window.pbinInput && window.pbinInput.getText()) || ''; } catch (e) { return ''; }
}

// Returns [{name, bytes: Uint8Array}] for the attached files.
function getInputFiles() {
  try { return (window.pbinInput && window.pbinInput.getFiles()) || []; } catch (e) { return []; }
}

// ---- Downloads ------------------------------------------------------------

function formatByteSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function triggerDownload(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Download the visible output as a file: the text as output.txt, or the
// rendered SVG (Mermaid, AutoLISP drawings) as output.svg when that is all
// there is. Output that was detected as structured (JSON/XML/SVG/Mermaid)
// and is the whole output downloads with the matching extension.
function downloadOutput() {
  const outputEl = document.getElementById('output');
  if (!outputEl) return;
  const only = soleStructuredOutput(outputEl);
  if (only) {
    const byLang = {
      json: ['json', 'application/json'],
      xml: ['xml', 'application/xml'],
      svg: ['svg', 'image/svg+xml'],
      mermaid: ['mmd', 'text/plain'],
    };
    const [ext, mime] = byLang[only.dataset.pbLang] || byLang.json;
    triggerDownload('output.' + ext, only.__pbOutputRaw, mime + ';charset=utf-8');
    return;
  }
  const svg = outputEl.querySelector('svg');
  if (svg && outputEl.innerText.trim() === '') {
    triggerDownload('output.svg', new XMLSerializer().serializeToString(svg), 'image/svg+xml');
    return;
  }
  triggerDownload('output.txt', outputPlainText(outputEl), 'text/plain;charset=utf-8');
}

// Files the last run created, offered as downloads under the output.
let runProducedFiles = [];

function downloadRunFile(index) {
  const file = runProducedFiles[index];
  if (file) triggerDownload(file.name, file.content);
}

function renderRunFiles(outputEl, files) {
  runProducedFiles = files;
  if (!files.length) return;
  let html = '<div class="text-purple-600 font-bold mt-2">Files created:</div><div>';
  files.forEach((file, i) => {
    html += '<button type="button" class="pbin-runfile" onclick="window.pbinDownloadRunFile(' + i + ')">' +
            '<i class="fas fa-download" aria-hidden="true"></i> ' + escapeHtml(file.name) +
            ' <span>(' + formatByteSize(file.content.length) + ')</span></button>';
  });
  html += '</div>';
  outputEl.insertAdjacentHTML('beforeend', html);
}

// ---- Structured output ------------------------------------------------------
// The runners above print program output into plain <pre> blocks. When such a
// block turns out to be structured (JSON, XML, SVG markup, Mermaid diagram
// source), it is upgraded: JSON/XML get a read-only Monaco editor — syntax
// highlighting plus folding, so big JSON objects can be collapsed — while SVG
// and Mermaid render as the actual graphic, with a button to flip to the
// source. A MutationObserver on #output picks the blocks up after every run,
// whichever runner wrote them. The raw text stays on the container
// (__pbOutputRaw) so Copy/Download keep returning the real output rather than
// whatever Monaco or the renderer happens to have in the DOM.

let outputMonacoEditors = [];
let outputBlockId = 0;

const MERMAID_FIRST_LINE =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|xychart(?:-beta)?|sankey(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|requirementDiagram|C4(?:Context|Container|Component|Dynamic|Deployment))\b/;

// The first line that isn't blank or a %% comment/directive.
function firstMeaningfulLine(text) {
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s && !s.startsWith('%%')) return s;
  }
  return '';
}

// 'json' | 'xml' | 'svg' | 'mermaid' | null for the given program output.
function detectStructuredOutput(text) {
  const t = text.trim();
  if (!t) return null;
  if (t[0] === '{' || t[0] === '[') {
    try {
      const v = JSON.parse(t);
      // Compact single-line JSON counts too: it is pretty-printed for
      // display so it can be folded. Only {} and [] gain nothing.
      const nonEmpty = Array.isArray(v) ? v.length > 0 : (v !== null && typeof v === 'object' && Object.keys(v).length > 0);
      if (nonEmpty) return 'json';
    } catch (e) { /* not JSON */ }
    return null;
  }
  if (t[0] === '<' && t[t.length - 1] === '>') {
    try {
      const doc = new DOMParser().parseFromString(t, 'application/xml');
      if (!doc.getElementsByTagName('parsererror').length) {
        if (doc.documentElement.localName === 'svg') return 'svg';
        if (t.indexOf('\n') !== -1 || t.length >= 60) return 'xml';
      }
    } catch (e) { /* not XML */ }
    return null;
  }
  // A Mermaid guess is verified by mermaid.parse before anything renders,
  // so a plain sentence starting with "graph" stays text.
  if (MERMAID_FIRST_LINE.test(firstMeaningfulLine(t))) return 'mermaid';
  return null;
}

// A read-only Monaco editor inside host, sized to hug its content (folding
// shrinks it live) up to most of the pane; past that it scrolls internally.
function createOutputEditor(host, text, language, outputEl) {
  const editor = monaco.editor.create(host, {
    value: text,
    language: language,
    theme: window.pbinMonacoTheme ? window.pbinMonacoTheme() : 'vs-dark',
    readOnly: true,
    domReadOnly: true,
    folding: true,
    showFoldingControls: 'always',
    minimap: { enabled: false },
    lineNumbers: 'on',
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    occurrencesHighlight: 'off',
    contextmenu: false,
    fontSize: 12,
    automaticLayout: true,
    scrollbar: { alwaysConsumeMouseWheel: false },
  });
  const fit = () => {
    const max = Math.max(120, (outputEl.clientHeight || 400) - 40);
    host.style.height = Math.min(editor.getContentHeight() + 2, max) + 'px';
    editor.layout();
  };
  editor.onDidContentSizeChange(fit);
  fit();
  outputMonacoEditors.push({ editor, container: host });
  return editor;
}

function makeStructuredContainer(className, lang, text) {
  const container = document.createElement('div');
  container.className = 'pb-output-structured ' + className;
  container.dataset.pbLang = lang;
  container.__pbOutputRaw = text;
  return container;
}

// A button on a rendered SVG/Mermaid block that flips between the graphic
// and its source in a read-only Monaco editor.
function attachSourceToggle(container, body, text, sourceLanguage, outputEl) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pb-btn pb-btn--ghost pb-output-src-toggle';
  toggle.title = 'Toggle between the rendered graphic and its source';
  toggle.setAttribute('aria-label', 'Toggle graphic source');
  toggle.innerHTML = window.pbinIcon ? window.pbinIcon('code') : '&lt;/&gt;';
  let srcHost = null;
  let showingSource = false;
  toggle.onclick = () => {
    showingSource = !showingSource;
    if (showingSource && !srcHost && window.monaco && monaco.editor) {
      srcHost = document.createElement('div');
      srcHost.className = 'pb-output-monaco';
      container.appendChild(srcHost);
      createOutputEditor(srcHost, text, sourceLanguage, outputEl);
    }
    if (srcHost) srcHost.style.display = showingSource ? '' : 'none';
    body.style.display = showingSource ? 'none' : '';
  };
  container.appendChild(toggle);
}

// SVG markup renders directly (sanitized: program output must not script the
// page); Mermaid source is validated first and renders as its diagram.
function renderGraphicOutput(pre, text, kind, outputEl) {
  if (kind === 'svg') {
    // Without a sanitizer available, fall back to showing the markup.
    if (typeof DOMPurify === 'undefined') {
      upgradeToEditor(pre, text, 'xml', outputEl);
      return;
    }
    const container = makeStructuredContainer('pb-output-render', 'svg', text);
    const body = document.createElement('div');
    body.className = 'pb-output-render-body';
    body.innerHTML = DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } });
    if (!body.querySelector('svg')) {
      pre.dataset.pbPlain = '1'; // sanitized away entirely: keep the text
      return;
    }
    container.appendChild(body);
    pre.replaceWith(container);
    attachSourceToggle(container, body, text, 'xml', outputEl);
    return;
  }

  // Mermaid: the keyword match is only a guess, so parse first and leave the
  // block as plain text when it isn't actually a diagram.
  if (typeof mermaid === 'undefined') return;
  pre.dataset.pbPlain = '1'; // claimed: don't re-process while parsing
  const id = 'pbOutputMermaid' + (++outputBlockId);
  Promise.resolve()
    .then(() => mermaid.parse(text))
    .then(() => mermaid.render(id, text))
    .then(({ svg }) => {
      if (!pre.isConnected) return; // a newer run replaced the output
      const container = makeStructuredContainer('pb-output-render', 'mermaid', text);
      const body = document.createElement('div');
      body.className = 'pb-output-render-body';
      body.innerHTML = svg;
      container.appendChild(body);
      pre.replaceWith(container);
      attachSourceToggle(container, body, text, 'plaintext', outputEl);
    })
    .catch(() => { /* not a diagram after all: the text stays as it is */ });
}

function upgradeToEditor(pre, text, language, outputEl) {
  if (!(window.monaco && monaco.editor)) return;
  // Compact single-line JSON is pretty-printed for display, so there is
  // something to fold; Copy/Download still return the text as printed.
  let display = text;
  if (language === 'json' && text.trim().indexOf('\n') === -1) {
    try { display = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* show as printed */ }
  }
  const container = makeStructuredContainer('pb-output-monaco', language, text);
  pre.replaceWith(container);
  createOutputEditor(container, display, language, outputEl);
}

// Upgrades every qualifying <pre> in the output, and disposes editors whose
// containers a later run has thrown away.
function upgradeStructuredOutput(outputEl) {
  outputMonacoEditors = outputMonacoEditors.filter((entry) => {
    if (outputEl.contains(entry.container)) return true;
    entry.editor.dispose();
    return false;
  });
  // Rendered markdown is a document, not program output: leave its code
  // blocks alone.
  if (outputEl.classList.contains('markdown-body')) return;
  outputEl.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.pb-output-structured') || pre.dataset.pbPlain || pre.querySelector('code')) return;
    const text = pre.textContent || '';
    const kind = detectStructuredOutput(text);
    if (!kind) return;
    if (kind === 'svg' || kind === 'mermaid') {
      renderGraphicOutput(pre, text, kind, outputEl);
    } else {
      upgradeToEditor(pre, text, kind, outputEl);
    }
  });
}

// The output as plain text, with upgraded blocks contributing their raw
// program output instead of Monaco's rendered DOM.
function outputPlainText(outputEl) {
  if (!outputEl.querySelector('.pb-output-structured')) {
    return outputEl.innerText || outputEl.textContent || '';
  }
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.__pbOutputRaw != null) {
      return node.__pbOutputRaw.endsWith('\n') ? node.__pbOutputRaw : node.__pbOutputRaw + '\n';
    }
    if (node.tagName === 'BR') return '\n';
    let s = '';
    node.childNodes.forEach((c) => { s += walk(c); });
    const display = getComputedStyle(node).display;
    if (display === 'none') return '';
    if (display !== 'inline' && s && !s.endsWith('\n')) s += '\n';
    return s;
  };
  return walk(outputEl);
}

// The one structured block when it is the entire printed output (bar its
// "Output:" heading), so Download can name the file by what it holds.
function soleStructuredOutput(outputEl) {
  const containers = outputEl.querySelectorAll('.pb-output-structured');
  if (containers.length !== 1) return null;
  for (const pre of outputEl.querySelectorAll('pre')) {
    if ((pre.textContent || '').trim()) return null;
  }
  return containers[0];
}

(function initStructuredOutput() {
  const setup = () => {
    const outputEl = document.getElementById('output');
    if (!outputEl) return;
    let scheduled = false;
    const observer = new MutationObserver((mutations) => {
      // Monaco repaints its own DOM constantly; only mutations outside the
      // editors we created can introduce new <pre> blocks.
      if (mutations.every((m) => m.target.nodeType === Node.ELEMENT_NODE &&
                                 m.target.closest('.pb-output-monaco'))) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        upgradeStructuredOutput(outputEl);
      });
    });
    observer.observe(outputEl, { childList: true, subtree: true });
  };
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();

// WASM-Clang API Code
const WasmClangAPI = (function() {
  function sleep(ms) {
    return new Promise((resolve, _) => setTimeout(resolve, ms));
  }

  function readStr(u8, o, len = -1) {
    let str = '';
    let end = u8.length;
    if (len != -1)
      end = o + len;
    for (let i = o; i < end && u8[i] != 0; ++i)
      str += String.fromCharCode(u8[i]);
    return str;
  }

  class ProcExit extends Error {
    constructor(code) {
      super(`process exited with code ${code}.`);
      this.code = code;
    }
  }

  class NotImplemented extends Error {
    constructor(modname, fieldname) {
      super(`${modname}.${fieldname} not implemented.`);
    }
  }

  class AbortError extends Error {
    constructor(msg = 'abort') { super(msg); }
  }

  class AssertError extends Error {
    constructor(msg) { super(msg); }
  }

  function assert(cond) {
    if (!cond) {
      throw new AssertError('assertion failed.');
    }
  }

  function getInstance(module, imports) {
    return WebAssembly.instantiate(module, imports);
  }

  function getImportObject(obj, names) {
    const result = {};
    for (let name of names) {
      result[name] = obj[name].bind(obj);
    }
    return result;
  }

  const ESUCCESS = 0;

  class Memory {
    constructor(memory) {
      this.memory = memory;
      this.buffer = this.memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.u32 = new Uint32Array(this.buffer);
    }

    check() {
      if (this.buffer.byteLength === 0) {
        this.buffer = this.memory.buffer;
        this.u8 = new Uint8Array(this.buffer);
        this.u32 = new Uint32Array(this.buffer);
      }
    }

    read8(o) { return this.u8[o]; }
    read32(o) { return this.u32[o >> 2]; }
    write8(o, v) { this.u8[o] = v; }
    write32(o, v) { this.u32[o >> 2] = v; }
    write64(o, vlo, vhi = 0) { this.write32(o, vlo); this.write32(o + 4, vhi); }

    readStr(o, len) {
      return readStr(this.u8, o, len);
    }

    writeStr(o, str) {
      o += this.write(o, str);
      this.write8(o, 0);
      return str.length + 1;
    }

    write(o, buf) {
      if (buf instanceof ArrayBuffer) {
        return this.write(o, new Uint8Array(buf));
      } else if (typeof buf === 'string') {
        return this.write(o, buf.split('').map(x => x.charCodeAt(0)));
      } else {
        const dst = new Uint8Array(this.buffer, o, buf.length);
        dst.set(buf);
        return buf.length;
      }
    }
  }

  class MemFS {
    constructor(options) {
      const compileStreaming = options.compileStreaming;
      this.hostWrite = options.hostWrite;
      this.stdinStr = options.stdinStr || "";
      this.stdinStrPos = 0;
      this.memfsFilename = options.memfsFilename;

      this.hostMem_ = null;

      const env = getImportObject(
          this, [ 'abort', 'host_write', 'host_read', 'memfs_log', 'copy_in', 'copy_out' ]);

      this.ready = compileStreaming(this.memfsFilename)
                       .then(module => WebAssembly.instantiate(module, {env}))
                       .then(instance => {
                         this.instance = instance;
                         this.exports = instance.exports;
                         this.mem = new Memory(this.exports.memory);
                         this.exports.init();
                       })
    }

    set hostMem(mem) {
      this.hostMem_ = mem;
    }

    setStdinStr(str) {
      this.stdinStr = str;
      this.stdinStrPos = 0;
    }

    addDirectory(path) {
      this.mem.check();
      this.mem.write(this.exports.GetPathBuf(), path);
      this.exports.AddDirectoryNode(path.length);
    }

    addFile(path, contents) {
      const length =
          contents instanceof ArrayBuffer ? contents.byteLength : contents.length;
      this.mem.check();
      this.mem.write(this.exports.GetPathBuf(), path);
      const inode = this.exports.AddFileNode(path.length, length);
      const addr = this.exports.GetFileNodeAddress(inode);
      this.mem.check();
      this.mem.write(addr, contents);
    }

    getFileContents(path) {
      this.mem.check();
      this.mem.write(this.exports.GetPathBuf(), path);
      const inode = this.exports.FindNode(path.length);
      const addr = this.exports.GetFileNodeAddress(inode);
      const size = this.exports.GetFileNodeSize(inode);
      return new Uint8Array(this.mem.buffer, addr, size);
    }

    abort() { throw new AbortError(); }

    host_write(fd, iovs, iovs_len, nwritten_out) {
      this.hostMem_.check();
      assert(fd <= 2);
      let size = 0;
      let str = '';
      for (let i = 0; i < iovs_len; ++i) {
        const buf = this.hostMem_.read32(iovs);
        iovs += 4;
        const len = this.hostMem_.read32(iovs);
        iovs += 4;
        str += this.hostMem_.readStr(buf, len);
        size += len;
      }
      this.hostMem_.write32(nwritten_out, size);
      this.hostWrite(str);
      return ESUCCESS;
    }

    host_read(fd, iovs, iovs_len, nread) {
      this.hostMem_.check();
      assert(fd === 0);
      let size = 0;
      for (let i = 0; i < iovs_len; ++i) {
        const buf = this.hostMem_.read32(iovs);
        iovs += 4;
        const len = this.hostMem_.read32(iovs);
        iovs += 4;
        const lenToWrite = Math.min(len, (this.stdinStr.length - this.stdinStrPos));
        if(lenToWrite === 0){
          break;
        }
        this.hostMem_.write(buf, this.stdinStr.substr(this.stdinStrPos, lenToWrite));
        size += lenToWrite;
        this.stdinStrPos += lenToWrite;
        if(lenToWrite !== len){
          break;
        }
      }
      this.hostMem_.write32(nread, size);
      return ESUCCESS;
    }

    memfs_log(buf, len) {
      this.mem.check();
      console.log(this.mem.readStr(buf, len));
    }

    copy_out(clang_dst, memfs_src, size) {
      this.hostMem_.check();
      const dst = new Uint8Array(this.hostMem_.buffer, clang_dst, size);
      this.mem.check();
      const src = new Uint8Array(this.mem.buffer, memfs_src, size);
      dst.set(src);
    }

    copy_in(memfs_dst, clang_src, size) {
      this.mem.check();
      const dst = new Uint8Array(this.mem.buffer, memfs_dst, size);
      this.hostMem_.check();
      const src = new Uint8Array(this.hostMem_.buffer, clang_src, size);
      dst.set(src);
    }
  }

  const RAF_PROC_EXIT_CODE = 0xC0C0A;

  class App {
    constructor(module, memfs, name, ...args) {
      this.argv = [name, ...args];
      this.environ = {USER : 'alice'};
      this.memfs = memfs;
      this.allowRequestAnimationFrame = true;
      this.handles = new Map();
      this.nextHandle = 0;

      const env = getImportObject(this, []);

      const wasi_unstable = getImportObject(this, [
        'proc_exit', 'environ_sizes_get', 'environ_get', 'args_sizes_get',
        'args_get', 'random_get', 'clock_time_get', 'poll_oneoff'
      ]);

      Object.assign(wasi_unstable, this.memfs.exports);

      this.ready = getInstance(module, {wasi_unstable, env}).then(instance => {
        this.instance = instance;
        this.exports = this.instance.exports;
        this.mem = new Memory(this.exports.memory);
        this.memfs.hostMem = this.mem;
      });
    }

    async run() {
      await this.ready;
      try {
        this.exports._start();
      } catch (exn) {
        let writeStack = true;
        if (exn instanceof ProcExit) {
          if (exn.code === RAF_PROC_EXIT_CODE) {
            return true;
          }
          this.allowRequestAnimationFrame = false;
          if (exn.code == 0) {
            return false;
          }
          writeStack = false;
        }

        let msg = `Error: ${exn.message}`;
        if (writeStack) {
          msg = msg + `\n${exn.stack}`;
        }
        this.memfs.hostWrite(msg);

        throw exn;
      }
    }

    proc_exit(code) {
      throw new ProcExit(code);
    }

    environ_sizes_get(environ_count_out, environ_buf_size_out) {
      this.mem.check();
      let size = 0;
      const names = Object.getOwnPropertyNames(this.environ);
      for (const name of names) {
        const value = this.environ[name];
        size += name.length + value.length + 2;
      }
      this.mem.write64(environ_count_out, names.length);
      this.mem.write64(environ_buf_size_out, size);
      return ESUCCESS;
    }

    environ_get(environ_ptrs, environ_buf) {
      this.mem.check();
      const names = Object.getOwnPropertyNames(this.environ);
      for (const name of names) {
        this.mem.write32(environ_ptrs, environ_buf);
        environ_ptrs += 4;
        environ_buf +=
            this.mem.writeStr(environ_buf, `${name}=${this.environ[name]}`);
      }
      this.mem.write32(environ_ptrs, 0);
      return ESUCCESS;
    }

    args_sizes_get(argc_out, argv_buf_size_out) {
      this.mem.check();
      let size = 0;
      for (let arg of this.argv) {
        size += arg.length + 1;
      }
      this.mem.write64(argc_out, this.argv.length);
      this.mem.write64(argv_buf_size_out, size);
      return ESUCCESS;
    }

    args_get(argv_ptrs, argv_buf) {
      this.mem.check();
      for (let arg of this.argv) {
        this.mem.write32(argv_ptrs, argv_buf);
        argv_ptrs += 4;
        argv_buf += this.mem.writeStr(argv_buf, arg);
      }
      this.mem.write32(argv_ptrs, 0);
      return ESUCCESS;
    }

    random_get(buf, buf_len) {
      const data = new Uint8Array(this.mem.buffer, buf, buf_len);
      for (let i = 0; i < buf_len; ++i) {
        data[i] = (Math.random() * 256) | 0;
      }
    }

    clock_time_get(clock_id, precision, time_out) {
      throw new NotImplemented('wasi_unstable', 'clock_time_get');
    }

    poll_oneoff(in_ptr, out_ptr, nsubscriptions, nevents_out) {
      throw new NotImplemented('wasi_unstable', 'poll_oneoff');
    }
  }

  class Tar {
    constructor(buffer) {
      this.u8 = new Uint8Array(buffer);
      this.offset = 0;
    }

    readStr(len) {
      const result = readStr(this.u8, this.offset, len);
      this.offset += len;
      return result;
    }

    readOctal(len) {
      return parseInt(this.readStr(len), 8);
    }

    alignUp() {
      this.offset = (this.offset + 511) & ~511;
    }

    readEntry() {
      if (this.offset + 512 > this.u8.length) {
        return null;
      }

      const entry = {
        filename : this.readStr(100),
        mode : this.readOctal(8),
        owner : this.readOctal(8),
        group : this.readOctal(8),
        size : this.readOctal(12),
        mtim : this.readOctal(12),
        checksum : this.readOctal(8),
        type : this.readStr(1),
        linkname : this.readStr(100),
      };

      if (this.readStr(8) !== 'ustar  ') {
        return null;
      }

      entry.ownerName = this.readStr(32);
      entry.groupName = this.readStr(32);
      entry.devMajor = this.readStr(8);
      entry.devMinor = this.readStr(8);
      entry.filenamePrefix = this.readStr(155);
      this.alignUp();

      if (entry.type === '0') {
        entry.contents = this.u8.subarray(this.offset, this.offset + entry.size);
        this.offset += entry.size;
        this.alignUp();
      } else if (entry.type !== '5') {
        console.log('type', entry.type);
        assert(false);
      }
      return entry;
    }

    untar(memfs) {
      let entry;
      while (entry = this.readEntry()) {
        switch (entry.type) {
        case '0':
          memfs.addFile(entry.filename, entry.contents);
          break;
        case '5':
          memfs.addDirectory(entry.filename);
          break;
        }
      }
    }
  }

  class API {
    constructor(options) {
      this.moduleCache = {};
      this.readBuffer = options.readBuffer;
      this.compileStreaming = options.compileStreaming;
      this.hostWrite = options.hostWrite;
      this.clangFilename = options.clang || 'clang';
      this.lldFilename = options.lld || 'lld';
      this.sysrootFilename = options.sysroot || 'sysroot.tar';
      this.showTiming = options.showTiming || false;
      this.cdnUrl = options.cdnUrl || 'https://binji.github.io/wasm-clang/';

      this.clangCommonArgs = [
        '-disable-free',
        '-isysroot', '/',
        '-internal-isystem', '/include/c++/v1',
        '-internal-isystem', '/include',
        '-internal-isystem', '/lib/clang/8.0.1/include',
        '-ferror-limit', '19',
        '-fmessage-length', '80',
        '-fcolor-diagnostics',
      ];

      this.memfs = new MemFS({
        compileStreaming : this.compileStreaming,
        hostWrite : this.hostWrite,
        memfsFilename : this.cdnUrl + (options.memfs || 'memfs'),
      });
      this.ready = this.memfs.ready.then(
          () => { return this.untar(this.memfs, this.sysrootFilename); });
    }

    async compileStreaming(filename) {
        const response = await fetch(filename);
        return WebAssembly.compile(await response.arrayBuffer());
    }

    async readBuffer(filename) {
        const response = await fetch(filename);
        return response.arrayBuffer();
    }

    async getModule(name) {
      if (this.moduleCache[name]) return this.moduleCache[name];
      const module = await this.compileStreaming(name);
      this.moduleCache[name] = module;
      return module;
    }

    async untar(memfs, filename) {
      await this.memfs.ready;
      const tar = new Tar(await this.readBuffer(this.cdnUrl + filename));
      tar.untar(this.memfs);
    }

    async compile(options) {
      const input = options.input;
      const contents = options.contents;
      const obj = options.obj;
      const opt = options.opt || '2';
      const clangFlags = options.clangFlags || [];

      await this.ready;
      this.memfs.addFile(input, contents);
      const clang = await this.getModule(this.cdnUrl + this.clangFilename);
      return await this.run(clang, 'clang', '-cc1', '-emit-obj',
                            ...this.clangCommonArgs, ...clangFlags, '-O'+opt, '-o', obj, '-x',
                            'c++', input);
    }

    async link(obj, wasm) {
      const stackSize = 1024 * 1024;

      const libdir = 'lib/wasm32-wasi';
      const crt1 = `${libdir}/crt1.o`;
      await this.ready;
      const lld = await this.getModule(this.cdnUrl + this.lldFilename);
      return await this.run(
          lld, 'wasm-ld', '--no-threads',
          '--export-dynamic',
          '-z', `stack-size=${stackSize}`, `-L${libdir}`, crt1, obj, '-lc',
          '-lc++', '-lc++abi', '-o', wasm)
    }

    async run(module, ...args) {
      const app = new App(module, this.memfs, ...args);
      const stillRunning = await app.run();
      return stillRunning ? app : null;
    }

    async compileLinkRun(contents, options) {
      const input = `test.cc`;
      const obj = `test.o`;
      const wasm = `test.wasm`;
      await this.compile({input, contents, obj, clangFlags: options.clangFlags});
      await this.link(obj, wasm);

      const buffer = this.memfs.getFileContents(wasm);
      const testMod = await WebAssembly.compile(buffer);
      return await this.run(testMod, wasm);
    }

    async format(contents) {
      const input = 'input.cpp';
      const output = 'output.cpp';

      await this.ready;
      this.memfs.addFile(input, contents);

      // Try to load clang-format module
      let clangFormat;
      try {
        clangFormat = await this.getModule(this.cdnUrl + 'clang-format');
      } catch (e) {
        // If clang-format is not available, use clang with format flags
        console.log('clang-format binary not available, using alternative approach');
        throw new Error('clang-format WASM binary not available');
      }

      // Run clang-format
      await this.run(clangFormat, 'clang-format', '-style=LLVM', input);

      // Read the formatted output from stdout or the output file
      try {
        const formatted = this.memfs.getFileContents(output);
        return new TextDecoder().decode(formatted);
      } catch (e) {
        // If output file doesn't exist, the formatted code was written to stdout
        // which was captured by hostWrite
        throw new Error('Failed to read formatted output');
      }
    }

    setStdinStr(str) {
      this.memfs.setStdinStr(str);
    }
  }

  return API;
})();

// Run C++ code using wasm-clang
async function runCppCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Compiling C++ code...</div>';

    // Capture memory before execution (if available)
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;

    let compileOutput = '';
    let compileErrors = '';

    // Start compile timing
    const compileStartTime = performance.now();

    // Create API instance with output capture
    const api = new WasmClangAPI({
      compileStreaming: async (filename) => {
        const response = await fetch(filename);
        return WebAssembly.compile(await response.arrayBuffer());
      },
      readBuffer: async (filename) => {
        const response = await fetch(filename);
        return response.arrayBuffer();
      },
      hostWrite: (msg) => {
        compileOutput += msg;
        // Check for error patterns in compilation output
        if (msg.includes('error:') || msg.includes('Error:')) {
          compileErrors += msg;
        }
      }
    });

    // Wait for API to be ready
    await api.ready;

    // Custom input: attached files go into the program's filesystem, and the
    // Input tab text becomes its stdin.
    for (const f of getInputFiles()) {
      api.memfs.addFile(f.name, f.bytes);
    }
    api.setStdinStr(getStdinText());

    // Compile the code
    const input = 'test.cc';
    const obj = 'test.o';
    const wasm = 'test.wasm';

    try {
      await api.compile({input, contents: code, obj, clangFlags: []});
    } catch (compileError) {
      // Compilation failed
      const compileEndTime = performance.now();
      const compileTime = compileEndTime - compileStartTime;

      let errorOutput = '<div class="text-red-600 font-bold">Compilation Error:</div>';
      errorOutput += '<pre class="whitespace-pre-wrap">' + ansiToHtml(compileOutput || compileError.message) + '</pre>';

      outputEl.innerHTML = errorOutput;

      // Update metrics
      const metricsEl = document.getElementById("outputMetrics");
      if (metricsEl) {
        metricsEl.textContent = `🔨 Compile: ${compileTime.toFixed(2)} ms`;
      }

      // Reset UI state
      executionState.isRunning = false;
      const runButton = document.getElementById("runButton");
      const cancelButton = document.getElementById("cancelButton");
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
      return;
    }

    const compileEndTime = performance.now();
    const compileTime = compileEndTime - compileStartTime;

    // Check for compilation errors in output
    if (compileErrors) {
      let errorOutput = '<div class="text-red-600 font-bold">Compilation Error:</div>';
      errorOutput += '<pre class="whitespace-pre-wrap">' + ansiToHtml(compileErrors) + '</pre>';

      outputEl.innerHTML = errorOutput;

      // Update metrics
      const metricsEl = document.getElementById("outputMetrics");
      if (metricsEl) {
        metricsEl.textContent = `🔨 Compile: ${compileTime.toFixed(2)} ms`;
      }

      // Reset UI state
      executionState.isRunning = false;
      const runButton = document.getElementById("runButton");
      const cancelButton = document.getElementById("cancelButton");
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
      return;
    }

    // Link the object file
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Linking...</div>';

    let linkOutput = '';
    const linkStartTime = performance.now();

    // Reset hostWrite to capture link output
    api.memfs.hostWrite = (msg) => {
      linkOutput += msg;
    };

    try {
      await api.link(obj, wasm);
    } catch (linkError) {
      const linkEndTime = performance.now();
      const linkTime = linkEndTime - linkStartTime;

      let errorOutput = '<div class="text-red-600 font-bold">Linking Error:</div>';
      errorOutput += '<pre class="whitespace-pre-wrap">' + ansiToHtml(linkOutput || linkError.message) + '</pre>';

      outputEl.innerHTML = errorOutput;

      // Update metrics
      const metricsEl = document.getElementById("outputMetrics");
      if (metricsEl) {
        metricsEl.textContent = `🔨 Compile: ${compileTime.toFixed(2)} ms | 🔗 Link: ${linkTime.toFixed(2)} ms`;
      }

      // Reset UI state
      executionState.isRunning = false;
      const runButton = document.getElementById("runButton");
      const cancelButton = document.getElementById("cancelButton");
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
      return;
    }

    const linkEndTime = performance.now();
    const linkTime = linkEndTime - linkStartTime;

    // Validate WASM file was created successfully
    const buffer = api.memfs.getFileContents(wasm);

    // Check for WASM magic bytes: 0x00 0x61 0x73 0x6D ("\0asm")
    if (buffer.length < 4 || buffer[0] !== 0x00 || buffer[1] !== 0x61 || buffer[2] !== 0x73 || buffer[3] !== 0x6D) {
      // Linking failed - WASM file is invalid
      let errorOutput = '<div class="text-red-600 font-bold">Linking Error:</div>';

      // Try to read the error message from the file
      const errorText = new TextDecoder().decode(buffer);
      errorOutput += '<pre class="whitespace-pre-wrap">' + ansiToHtml(linkOutput || errorText || 'Linking failed - invalid WASM output') + '</pre>';

      outputEl.innerHTML = errorOutput;

      // Update metrics
      const metricsEl = document.getElementById("outputMetrics");
      if (metricsEl) {
        metricsEl.textContent = `🔨 Compile: ${compileTime.toFixed(2)} ms | 🔗 Link: ${linkTime.toFixed(2)} ms`;
      }

      // Reset UI state
      executionState.isRunning = false;
      const runButton = document.getElementById("runButton");
      const cancelButton = document.getElementById("cancelButton");
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
      return;
    }

    // Check if execution was cancelled
    if (executionState.shouldCancel) {
      return;
    }

    // Run the compiled code
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Running code...</div>';

    let runOutput = '';
    let runErrors = '';

    // Start execution timing
    const execStartTime = performance.now();

    const testMod = await WebAssembly.compile(buffer);

    // Capture stdout and stderr from the running WASM program
    api.memfs.hostWrite = (msg) => {
      runOutput += msg;
    };

    try {
      await api.run(testMod, wasm);
    } catch (runError) {
      if (runError.code !== 0 && runError.message) {
        runErrors = runError.message;
      }
    }

    const execEndTime = performance.now();
    const execTime = execEndTime - execStartTime;

    // Check if execution was cancelled
    if (executionState.shouldCancel) {
      return;
    }

    // Capture memory after execution (if available)
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryUsed = (memoryBefore !== null && memoryAfter !== null)
      ? memoryAfter - memoryBefore
      : null;

    // Display output
    let output = '';
    if (runErrors) {
      output = `<div class="text-red-600 font-bold">Runtime Error:</div><pre class="whitespace-pre-wrap">${escapeHtml(runErrors)}</pre>`;
    } else {
      if (runOutput) {
        output += `<div class="text-green-600 font-bold">Output:</div><pre class="whitespace-pre-wrap">${escapeHtml(runOutput)}</pre>`;
      } else {
        output = '<div class="text-gray-600">Code executed successfully with no output.</div>';
      }
    }

    outputEl.innerHTML = output;

    // Update metrics in panel header
    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      let metricsText = `🔨 Compile: ${compileTime.toFixed(2)} ms | 🔗 Link: ${linkTime.toFixed(2)} ms | ⏱ Exec: ${execTime.toFixed(2)} ms`;
      if (memoryUsed !== null) {
        const memoryMB = (Math.abs(memoryUsed) / 1024 / 1024).toFixed(2);
        metricsText += ` | 💾 ${memoryUsed >= 0 ? '+' : ''}${memoryMB} MB`;
      }
      metricsEl.textContent = metricsText;
    }

  } catch (err) {
    // Check if execution was cancelled
    if (executionState.shouldCancel) {
      return;
    }

    console.error('wasm-clang execution error:', err);
    outputEl.innerHTML = `<div class="text-red-600 font-bold">Execution Error:</div><pre class="whitespace-pre-wrap">${escapeHtml(err.toString())}</pre>`;
  } finally {
    // Reset UI state
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// MiniZinc execution function
async function runMiniZincCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Initializing MiniZinc...</div>';

    // Get MiniZinc instance (lazy initialization - only initializes once)
    const MiniZinc = await getMiniZinc();

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Solving model...</div>';

    // Capture memory before execution (if available)
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // Create a new model
    const model = new MiniZinc.Model();

    // Add the MiniZinc code
    model.addString(code);

    // The Input tab provides the model's data: a JSON object (keys become
    // the model's parameters) or a .dzn snippet (e.g. "n = 5;").
    const dataText = getStdinText();
    if (dataText.trim()) {
      let jsonData = null;
      try {
        const parsed = JSON.parse(dataText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          jsonData = parsed;
        }
      } catch (e) { /* not JSON; treat it as dzn */ }
      if (jsonData) {
        model.addJson(jsonData);
      } else {
        model.addDznString(dataText);
      }
    }

    // Solve the model
    const solve = model.solve({
      options: {
        solver: 'gecode',
        'time-limit': 30000,
        statistics: true,
        'all-solutions': false
      }
    });

    let solutionCount = 0;
    let output = '';
    let stats = null;

    // Listen for solutions
    solve.on('solution', (solution) => {
      solutionCount++;
      if (solution.output) {
        if (solution.output.default && solution.output.default.trim()) {
          // The model's own output statement
          output += '<pre class="whitespace-pre-wrap">' + escapeHtml(solution.output.default) + '</pre>';
        } else if (solution.output.json) {
          // Format JSON output nicely
          output += `<div class="mb-2"><strong>Solution ${solutionCount}:</strong></div>`;
          output += '<pre class="bg-gray-100 dark:bg-gray-800 p-2 rounded">' +
                    escapeHtml(JSON.stringify(solution.output.json, null, 2)) + '</pre>';
        } else {
          output += `<div class="mb-2"><strong>Solution ${solutionCount}:</strong></div>`;
          output += '<pre class="bg-gray-100 dark:bg-gray-800 p-2 rounded">' +
                    escapeHtml(solution.output.raw || solution.output.toString()) + '</pre>';
        }
      }
    });

    // Listen for statistics
    solve.on('statistics', (statistics) => {
      stats = statistics;
    });

    // Wait for solving to complete
    const result = await solve;

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Check if cancelled
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
      return;
    }

    // Display results
    if (output) {
      outputEl.innerHTML = output;
    } else if (result.status === 'SATISFIED' || result.status === 'OPTIMAL_SOLUTION' || result.status === 'ALL_SOLUTIONS') {
      outputEl.innerHTML = '<div class="text-green-600">Model satisfied (no output statement)</div>';
    } else if (result.status === 'UNSATISFIABLE') {
      outputEl.innerHTML = '<div class="text-red-600">Model is unsatisfiable</div>';
    } else if (result.status === 'UNKNOWN') {
      outputEl.innerHTML = '<div class="text-yellow-600">Solver returned unknown status</div>';
    } else {
      outputEl.innerHTML = '<div class="text-gray-600">Solving completed with status: ' + escapeHtml(result.status) + '</div>';
    }

    // Display metrics
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryDelta = (memoryBefore !== null && memoryAfter !== null)
      ? ((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)
      : 'N/A';

    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      let metricsHtml = `Solve time: ${executionTime.toFixed(2)}ms | Memory: ${memoryDelta}MB | Solutions: ${solutionCount} | Status: ${result.status}`;

      if (stats) {
        metricsHtml += ` | ${JSON.stringify(stats)}`;
      }

      metricsEl.textContent = metricsHtml;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('MiniZinc execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    // Reset UI state
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// TLA+ runs in a Web Worker so the heavy model-checking never blocks the main
// thread (the check is one synchronous WASM call exploring up to 100k states).
let tlaWorker = null;
let tlaPendingReject = null;

function getTlaWorker() {
  if (tlaWorker === null) {
    tlaWorker = new Worker('/static/js/tla-worker.js', { type: 'module' });
  }
  return tlaWorker;
}

// Terminate the running TLA+ worker (used by Cancel). It is recreated lazily on
// the next run, which also re-initializes the WASM module.
function terminateTlaWorker() {
  if (tlaWorker) {
    tlaWorker.terminate();
    tlaWorker = null;
  }
  if (tlaPendingReject) {
    const reject = tlaPendingReject;
    tlaPendingReject = null;
    reject(new Error('cancelled'));
  }
}

// Parse an inline CONFIG block from TLA+ code.
// Convention: after the module-ending "====", a line matching
// /^----\s*CONFIG\s*----/ starts the cfg section (optionally ended by "====").
function parseTlaCfg(code) {
  const cfgPattern = /^----\s*CONFIG\s*----.*$/m;
  const match = code.match(cfgPattern);
  if (!match) return { spec: code, cfg: null };

  const cfgStart = match.index;
  const spec = code.slice(0, cfgStart).trimEnd();
  let cfg = code.slice(cfgStart + match[0].length);
  // Strip optional trailing "===="
  cfg = cfg.replace(/^([\s\S]*?)====\s*$/, '$1').trim();
  return { spec, cfg };
}

// TLA+ model checker execution function
async function runTlaCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading TLA+ model checker...</div>';

    const worker = getTlaWorker();

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Checking specification...</div>';

    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    const { spec, cfg } = parseTlaCfg(code);
    const options = JSON.stringify({
      max_states: 100000,
      max_depth: 100,
      allow_deadlock: false,
      export_dot: false
    });

    // Run the check off the main thread; the UI (spinner, Cancel) stays responsive.
    const resultJson = await new Promise((resolve, reject) => {
      tlaPendingReject = reject;
      worker.onmessage = (ev) => {
        tlaPendingReject = null;
        if (ev.data && ev.data.ok) resolve(ev.data.resultJson);
        else reject(new Error((ev.data && ev.data.error) || 'TLA+ check failed'));
      };
      worker.onerror = (ev) => {
        tlaPendingReject = null;
        reject(new Error(ev.message || 'TLA+ worker error'));
      };
      worker.postMessage({ spec, cfg, options });
    });
    const result = JSON.parse(resultJson);

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
      return;
    }

    let html = '';

    if (result.success) {
      html += '<div class="text-green-600 font-bold mb-2">Model checking passed</div>';
      html += '<div class="mb-1">States explored: ' + escapeHtml(String(result.states_explored)) + '</div>';
    } else {
      html += '<div class="text-red-600 font-bold mb-2">Model checking failed: ' + escapeHtml(result.error_type || 'Unknown error') + '</div>';
      html += '<div class="mb-2">' + escapeHtml(result.error_message || '') + '</div>';
      html += '<div class="mb-1">States explored: ' + escapeHtml(String(result.states_explored)) + '</div>';

      if (result.trace && result.trace.length > 0) {
        html += '<div class="mt-2 font-bold">Counterexample trace:</div>';
        for (let i = 0; i < result.trace.length; i++) {
          const label = result.trace.length > 1 && i === result.trace.length - 1 ? 'Cycle' : 'Trace';
          html += '<pre class="bg-gray-100 dark:bg-gray-800 p-2 rounded mt-1 text-sm overflow-x-auto"><strong>' +
                  escapeHtml(label) + ':</strong>\n' + escapeHtml(result.trace[i]) + '</pre>';
        }
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="mt-2 text-yellow-600 font-bold">Warnings:</div>';
      for (const warning of result.warnings) {
        html += '<div class="text-yellow-600">' + escapeHtml(warning) + '</div>';
      }
    }

    outputEl.innerHTML = html;

    // Display metrics
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryDelta = (memoryBefore !== null && memoryAfter !== null)
      ? ((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)
      : 'N/A';

    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      metricsEl.textContent = `Check time: ${executionTime.toFixed(2)}ms | Memory: ${memoryDelta}MB | States: ${result.states_explored} | ${result.success ? 'PASSED' : result.error_type}`;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('TLA+ execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Lazy initialization for Picat (Emscripten module factory)
let picatFactoryPromise = null;

async function getPicatFactory() {
  if (picatFactoryPromise === null) {
    picatFactoryPromise = import('/static/wasm/picat/picat.mjs').then((m) => m.default);
  }
  return picatFactoryPromise;
}

// Picat execution function
async function runPicatCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading Picat...</div>';

    const createPicat = await getPicatFactory();

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Running Picat program...</div>';

    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // A Picat program runs main/0 to completion and the runtime exits, so
    // create a fresh instance per run. The factory import is cached above
    // and the .wasm fetch hits the browser cache after the first run.
    let stdout = '';
    let stderr = '';
    // The Input tab text is served to the runtime byte by byte as stdin.
    const stdinBytes = new TextEncoder().encode(getStdinText());
    let stdinPos = 0;
    const mod = await createPicat({
      noInitialRun: true,
      stdin: () => (stdinPos < stdinBytes.length ? stdinBytes[stdinPos++] : null),
      print: (s) => { stdout += s + '\n'; },
      printErr: (s) => { stderr += s + '\n'; },
      locateFile: () => '/static/wasm/picat/picat.wasm',
    });

    mod.FS.writeFile('main.pi', code);
    for (const f of getInputFiles()) {
      mod.FS.writeFile(f.name, f.bytes);
    }

    let exitCode = 0;
    try {
      exitCode = mod.callMain(['main.pi']);
    } catch (e) {
      // halt/1 and fatal errors surface as an ExitStatus throw
      if (e && e.name === 'ExitStatus') {
        exitCode = e.status;
      } else {
        throw e;
      }
    }

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
      return;
    }

    let html = '';
    if (stdout) {
      html += '<pre class="whitespace-pre-wrap">' + escapeHtml(stdout) + '</pre>';
    }
    if (stderr) {
      html += '<div class="text-red-600 font-bold mt-2">Stderr:</div>' +
              '<pre class="whitespace-pre-wrap text-red-600">' + escapeHtml(stderr) + '</pre>';
    }
    if (!stdout && !stderr) {
      html = '<div class="text-gray-600">Program finished with no output.</div>';
    }
    if (exitCode !== 0) {
      html += '<div class="text-red-600 mt-2">Exit code: ' + escapeHtml(String(exitCode)) + '</div>';
    }
    outputEl.innerHTML = html;

    // Display metrics
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryDelta = (memoryBefore !== null && memoryAfter !== null)
      ? ((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)
      : 'N/A';

    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      metricsEl.textContent = `Execution time: ${executionTime.toFixed(2)}ms | Memory: ${memoryDelta}MB | Exit code: ${exitCode}`;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('Picat execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Lazy initialization for the OCaml toplevel (a js_of_ocaml build vendored
// in static/wasm/ocaml; see the BUILD.md there).
let ocamlInitPromise = null;

function getOCamlToplevel() {
  if (ocamlInitPromise === null) {
    ocamlInitPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/static/wasm/ocaml/toplevel.js';
      script.onload = () => {
        if (window.pbinOcaml) {
          resolve(window.pbinOcaml);
        } else {
          reject(new Error('OCaml toplevel failed to initialize'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load the OCaml toplevel'));
      document.head.appendChild(script);
    });
  }
  return ocamlInitPromise;
}

// OCaml execution function
async function runOCamlCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading OCaml toplevel...</div>';

    const ocaml = await getOCamlToplevel();

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Running OCaml program...</div>';

    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // Each run starts a fresh toplevel session, so a paste behaves like a
    // standalone program rather than a REPL with leftover definitions.
    ocaml.reset();

    let stdout = '';
    let stderr = '';
    ocaml.setStdout((s) => { stdout += s; });
    ocaml.setStderr((s) => { stderr += s; });

    // The toplevel only executes a phrase once it sees ";;", which
    // file-style OCaml omits; add a final one if the paste has none.
    let source = code;
    if (!/;;\s*$/.test(source)) source += '\n;;';

    // Values, types, and compile errors, as the toplevel would print them.
    const feedback = ocaml.execute(source);

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
      return;
    }

    let html = '';
    if (stdout) {
      html += '<div class="text-green-600 font-bold">Output:</div>' +
              '<pre class="whitespace-pre-wrap">' + escapeHtml(stdout) + '</pre>';
    }
    if (stderr) {
      html += '<div class="text-red-600 font-bold mt-2">Errors:</div>' +
              '<pre class="whitespace-pre-wrap text-red-600">' + escapeHtml(stderr) + '</pre>';
    }
    if (feedback && feedback.trim()) {
      html += '<div class="text-blue-600 font-bold mt-2">Toplevel:</div>' +
              '<pre class="whitespace-pre-wrap text-gray-600">' + escapeHtml(feedback) + '</pre>';
    }
    if (!html) {
      html = '<div class="text-gray-600">Program finished with no output.</div>';
    }
    outputEl.innerHTML = html;

    // Display metrics
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryDelta = (memoryBefore !== null && memoryAfter !== null)
      ? ((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)
      : 'N/A';

    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      metricsEl.textContent = `Execution time: ${executionTime.toFixed(2)}ms | Memory: ${memoryDelta}MB | OCaml ${ocaml.version()}`;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('OCaml execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Lazy initialization for AutoLISP (acadlisp)
let acadlispInitPromise = null;
let acadlispEngine = null;

async function getAcadlisp() {
  if (acadlispInitPromise === null) {
    acadlispInitPromise = (async () => {
      // Load the acadlisp WebAssembly module from jsDelivr CDN
      const jsUrl = 'https://cdn.jsdelivr.net/gh/holg/acadlisp@main/dist/acadlisp-1ccf28dd8ba26df6.js';
      const wasmUrl = 'https://cdn.jsdelivr.net/gh/holg/acadlisp@main/dist/acadlisp-1ccf28dd8ba26df6_bg.wasm';

      // Import the acadlisp module
      const module = await import(jsUrl);

      // Initialize with the WASM URL
      await module.default(wasmUrl);

      // Create and return the engine
      acadlispEngine = new module.WasmEngine();
      return { engine: acadlispEngine, module };
    })();
  }
  return acadlispInitPromise;
}

// AutoLISP execution function using acadlisp
async function runAutoLispCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading AutoLISP interpreter...</div>';

    // Get or initialize the acadlisp engine
    const { engine } = await getAcadlisp();

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Executing AutoLISP code...</div>';

    // Capture memory before execution (if available)
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // Clear any previous entities
    engine.clear();

    // Evaluate the AutoLISP code
    let evalResult = '';
    try {
      evalResult = engine.eval(code);
    } catch (evalError) {
      outputEl.innerHTML = '<div class="text-red-600 font-bold">AutoLISP Error:</div>' +
                          '<pre class="whitespace-pre-wrap">' + escapeHtml(evalError.message || evalError.toString()) + '</pre>';
      return;
    }

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Check if execution was cancelled
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
      return;
    }

    // Get the SVG output (the drawing)
    let svg = '';
    try {
      svg = engine.get_entities_svg();
    } catch (e) {
      console.log('No SVG entities:', e);
    }

    // Get any text output (from PRINC/PRINT commands)
    let textOutput = '';
    try {
      textOutput = engine.get_output();
    } catch (e) {
      console.log('No text output:', e);
    }

    // Capture memory after execution (if available)
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryDelta = (memoryBefore !== null && memoryAfter !== null)
      ? ((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)
      : 'N/A';

    // Build the output HTML
    let outputHtml = '';

    // Display text output if any
    if (textOutput && textOutput.trim()) {
      outputHtml += '<div class="text-green-600 font-bold">Output:</div>';
      outputHtml += '<pre class="whitespace-pre-wrap mb-4">' + escapeHtml(textOutput) + '</pre>';
    }

    // Display the evaluation result if meaningful
    if (evalResult && evalResult !== 'null' && evalResult !== 'nil') {
      outputHtml += '<div class="text-blue-600 font-bold">Result:</div>';
      outputHtml += '<pre class="whitespace-pre-wrap mb-4">' + escapeHtml(evalResult) + '</pre>';
    }

    // Display the SVG drawing
    if (svg && svg.trim() && svg.includes('<svg')) {
      outputHtml += '<div class="text-purple-600 font-bold mb-2">Drawing:</div>';
      outputHtml += '<div class="bg-white border rounded p-2" style="max-width: 100%; overflow: auto;">' + svg + '</div>';
    }

    if (!outputHtml) {
      outputHtml = '<div class="text-gray-600">Code executed successfully with no output.</div>';
    }

    outputEl.innerHTML = outputHtml;

    // Update metrics
    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      let entityCount = 0;
      try {
        entityCount = engine.entity_count();
      } catch (e) {}
      metricsEl.textContent = `⏱ ${executionTime.toFixed(2)} ms | 💾 ${memoryDelta} MB | 📐 ${entityCount} entities`;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('AutoLISP execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    // Reset UI state
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Scheme execution function using BiwaScheme
async function runSchemeCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading BiwaScheme interpreter...</div>';

    // Dynamically load BiwaScheme if not already loaded
    if (typeof BiwaScheme === 'undefined') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/biwascheme@0.8.0/release/biwascheme-min.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load BiwaScheme library'));
        document.head.appendChild(script);
      });
    }

    // Check if code is empty or whitespace-only
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      outputEl.innerHTML = '<div class="text-gray-600">No code to execute.</div>';
      executionState.isRunning = false;
      const runButton = document.getElementById("runButton");
      const cancelButton = document.getElementById("cancelButton");
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
      return;
    }

    // Remove comments and check if there's actual code
    const codeWithoutComments = code.split('\n')
      .map(line => {
        const commentIndex = line.indexOf(';');
        return commentIndex >= 0 ? line.substring(0, commentIndex) : line;
      })
      .join('\n')
      .trim();

    if (codeWithoutComments.length === 0) {
      outputEl.innerHTML = '<div class="text-gray-600">No executable code found (only comments).</div>';
      executionState.isRunning = false;
      const runButton = document.getElementById("runButton");
      const cancelButton = document.getElementById("cancelButton");
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
      return;
    }

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Running Scheme code...</div>';

    // Capture memory before execution (if available)
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // Capture output
    let output = '';
    let hasError = false;
    let errorMessage = '';

    // Capture everything written to the current output port: display, write,
    // print and newline all go through it.
    const originalPort = BiwaScheme.Port.current_output;
    BiwaScheme.Port.current_output = new BiwaScheme.Port.CustomOutput((str) => {
      output += str;
    });

    // The Input tab is served to (read-line): one line per call, then the
    // eof object.
    const stdinLines = getStdinText().split('\n');
    if (stdinLines.length && stdinLines[stdinLines.length - 1] === '') stdinLines.pop();
    let stdinPos = 0;
    const originalInput = BiwaScheme.Port.current_input;
    BiwaScheme.Port.current_input = new BiwaScheme.Port.CustomInput((callback) => {
      callback(stdinPos < stdinLines.length ? stdinLines[stdinPos++] : BiwaScheme.eof);
    });

    try {
      // Execute the Scheme code and capture the result with timeout
      const timeoutMs = 30000; // 30 second timeout
      let timeoutId;
      const result = await Promise.race([
        new Promise((resolve) => {
          // BiwaScheme reports errors through this callback and then never
          // calls the evaluate callback, so finish the run from here too.
          const onError = (e) => {
            hasError = true;
            errorMessage = (e && e.message) || String(e);
            resolve(undefined);
          };
          const biwa = new BiwaScheme.Interpreter(onError);
          try {
            biwa.evaluate(code, resolve);
          } catch (e) {
            onError(e);
          }
        }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Execution timeout (30 seconds)')), timeoutMs);
        })
      ]);
      clearTimeout(timeoutId);

      BiwaScheme.Port.current_output = originalPort;
      BiwaScheme.Port.current_input = originalInput;

      const endTime = performance.now();
      const executionTime = endTime - startTime;

      // Check if execution was cancelled
      if (executionState.shouldCancel) {
        outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
        return;
      }

      // Capture memory after execution (if available)
      const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
      const memoryDelta = (memoryBefore !== null && memoryAfter !== null)
        ? ((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)
        : 'N/A';

      // Display output
      if (hasError) {
        // Keep whatever was printed before the error.
        let errorHtml = '';
        if (output.length > 0) {
          errorHtml += '<div class="text-green-600 font-bold">Output:</div>';
          errorHtml += '<pre class="whitespace-pre-wrap">' + escapeHtml(output) + '</pre>';
        }
        outputEl.innerHTML = errorHtml + '<div class="text-red-600 font-bold">Error:</div>' +
                            '<pre class="whitespace-pre-wrap">' + escapeHtml(errorMessage) + '</pre>';
      } else {
        let outputHtml = '';

        // Display anything the program printed
        if (output.length > 0) {
          outputHtml += '<div class="text-green-600 font-bold">Output:</div>';
          outputHtml += '<pre class="whitespace-pre-wrap">' + escapeHtml(output) + '</pre>';
        }

        // Display the final result if it's not undefined
        if (result !== undefined && result !== null && result !== BiwaScheme.undef && result.toString() !== "#<undef>") {
          if (output.length > 0) {
            outputHtml += '<div class="text-blue-600 font-bold mt-2">Result:</div>';
          } else {
            outputHtml += '<div class="text-green-600 font-bold">Result:</div>';
          }
          outputHtml += '<pre class="whitespace-pre-wrap">' + escapeHtml(BiwaScheme.to_write(result)) + '</pre>';
        }

        if (!outputHtml) {
          outputHtml = '<div class="text-gray-600">Code executed successfully with no output.</div>';
        }

        outputEl.innerHTML = outputHtml;
      }

      // Update metrics
      const metricsEl = document.getElementById("outputMetrics");
      if (metricsEl) {
        metricsEl.textContent = `⏱ ${executionTime.toFixed(2)} ms | 💾 ${memoryDelta} MB`;
      }

    } catch (evalError) {
      // Restore the ports in case of error
      BiwaScheme.Port.current_output = originalPort;
      BiwaScheme.Port.current_input = originalInput;
      throw evalError;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('Scheme execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    // Reset UI state
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Clojure runs in a Web Worker (static/js/clojure-worker.js) on SCI, the
// Small Clojure Interpreter, via Scittle — the same engine as tryclojure.org.
// Each run gets a fresh worker (so a paste always evaluates from a clean
// slate), but the worker is kept alive afterwards: the editor support in
// clojure-lsp.js queries it for the docstrings, arglists and definition
// lines of the vars the run defined.
let clojureWorker = null;
let clojurePendingReject = null;
let clojureQueryId = 0;

function terminateClojureWorker() {
  if (clojureWorker) {
    clojureWorker.terminate();
    clojureWorker = null;
  }
  if (clojurePendingReject) {
    const reject = clojurePendingReject;
    clojurePendingReject = null;
    reject(new Error('cancelled'));
  }
}

// One-shot queries against the last run's SCI context, for clojure-lsp.js:
// pbinClojureMeta('my-fn') resolves to {found, doc, arglists, line, macro}
// or null; pbinClojurePublics() to the names `user` defines. Both resolve
// null/[] when no run has happened yet (no worker is spawned for them).
function clojureQuery(message, replyType, emptyValue) {
  if (!clojureWorker || clojurePendingReject) return Promise.resolve(emptyValue);
  const worker = clojureWorker;
  const id = ++clojureQueryId;
  return new Promise((resolve) => {
    const onMessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type !== replyType || msg.id !== id) return;
      worker.removeEventListener('message', onMessage);
      resolve(msg);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ ...message, id });
    // The worker was terminated or replaced mid-query: give up quietly.
    setTimeout(() => {
      worker.removeEventListener('message', onMessage);
      resolve(emptyValue);
    }, 2000);
  });
}

async function runClojureCode(code, outputEl) {
  const runButton = document.getElementById("runButton");
  const cancelButton = document.getElementById("cancelButton");
  const metricsEl = document.getElementById("outputMetrics");

  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading Clojure runtime (SCI)...</div>';

    // A fresh interpreter per run: re-running a paste after deleting a def
    // must not see the stale one.
    terminateClojureWorker();
    clojureWorker = new Worker('/static/js/clojure-worker.js');
    const worker = clojureWorker;

    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    const result = await new Promise((resolve, reject) => {
      clojurePendingReject = reject;
      worker.onmessage = (ev) => {
        const msg = ev.data || {};
        if (msg.type !== 'result') return; // 'ready' and query replies
        clojurePendingReject = null;
        resolve(msg);
      };
      worker.onerror = (err) => {
        clojurePendingReject = null;
        reject(new Error((err && err.message) || 'Failed to load the Clojure runtime'));
      };
      executionState.timeoutId = setTimeout(() => {
        executionState.timeoutId = null;
        clojurePendingReject = null;
        terminateClojureWorker();
        reject(new Error('Execution timeout (30 seconds)'));
      }, 30000);
      worker.postMessage({ type: 'run', code: code, stdin: getStdinText() });
    });

    if (executionState.timeoutId) {
      clearTimeout(executionState.timeoutId);
      executionState.timeoutId = null;
    }
    if (executionState.shouldCancel) return;

    const executionTime = performance.now() - startTime;
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryDelta = (memoryBefore !== null && memoryAfter !== null)
      ? ((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)
      : 'N/A';

    let outputHtml = '';
    if (result.output) {
      outputHtml += '<div class="text-green-600 font-bold">Output:</div>';
      outputHtml += '<pre class="whitespace-pre-wrap">' + escapeHtml(result.output) + '</pre>';
    }
    if (result.ok) {
      // The value of the last form, REPL-style, when there is one.
      if (result.resultStr !== null && result.resultStr !== undefined) {
        outputHtml += '<div class="' + (result.output ? 'text-blue-600 font-bold mt-2' : 'text-green-600 font-bold') + '">Result:</div>';
        outputHtml += '<pre class="whitespace-pre-wrap">' + escapeHtml(result.resultStr) + '</pre>';
      }
      if (!outputHtml) {
        outputHtml = '<div class="text-gray-600">Code executed successfully with no output.</div>';
      }
    } else {
      const err = result.error || {};
      let message = err.message || 'Evaluation failed';
      if (err.line !== null && err.line !== undefined) {
        message += ' (line ' + err.line + (err.column ? ', column ' + err.column : '') + ')';
      }
      outputHtml += '<div class="text-red-600 font-bold">' +
        (err.phase === 'parse' ? 'Syntax Error:' : 'Error:') + '</div>' +
        '<pre class="whitespace-pre-wrap">' + escapeHtml(message) + '</pre>';
    }
    outputEl.innerHTML = outputHtml;

    // Tell the editor support about the run so it can mark the failing line
    // (and refresh completions with the vars the run defined).
    try {
      window.dispatchEvent(new CustomEvent('pbin-clojure-run', {
        detail: { ok: result.ok, error: result.ok ? null : result.error }
      }));
    } catch (e) { /* no listeners, or CustomEvent unavailable */ }

    if (metricsEl) {
      metricsEl.textContent = `⏱ ${executionTime.toFixed(2)} ms | 💾 ${memoryDelta} MB`;
    }
  } catch (error) {
    if (executionState.timeoutId) {
      clearTimeout(executionState.timeoutId);
      executionState.timeoutId = null;
    }
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('Clojure execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600 font-bold">Execution Error:</div>' +
        '<pre class="whitespace-pre-wrap">' + escapeHtml(error.message || String(error)) + '</pre>';
    }
  } finally {
    executionState.isRunning = false;
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Markdown rendering function with GitHub Flavored Markdown support
async function runMarkdownCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Rendering markdown...</div>';

    // Check if marked and DOMPurify are available
    if (typeof marked === 'undefined') {
      throw new Error('Marked.js library is not loaded');
    }
    if (typeof DOMPurify === 'undefined') {
      throw new Error('DOMPurify library is not loaded');
    }

    // Capture memory before execution (if available)
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // Configure marked with GitHub Flavored Markdown
    marked.setOptions({
      gfm: true,              // Enable GitHub Flavored Markdown
      breaks: true,           // Convert \n to <br> in paragraphs
      headerIds: true,        // Add IDs to headers
      mangle: false,          // Don't escape autolinked email addresses
      pedantic: false,        // Don't use original markdown.pl parsing
      sanitize: false,        // Don't sanitize (we'll use DOMPurify)
      smartLists: true,       // Use smarter list behavior
      smartypants: false,     // Don't use "smart" typographic punctuation
    });

    // Parse markdown to HTML
    const rawHtml = marked.parse(code);

    // Sanitize the HTML to prevent XSS attacks
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'hr',
        'strong', 'em', 'del', 'ins', 'mark', 'code', 'pre',
        'a', 'img',
        'ul', 'ol', 'li',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'blockquote',
        'input', // For task lists
        'div', 'span'
      ],
      ALLOWED_ATTR: [
        'href', 'src', 'alt', 'title',
        'type', 'checked', 'disabled', // For checkboxes in task lists
        'align', // For table alignment
        'id', 'class' // For styling
      ],
      ALLOW_DATA_ATTR: false
    });

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Check if execution was cancelled
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Rendering cancelled</div>';
      return;
    }

    // Render the markdown HTML
    outputEl.innerHTML = cleanHtml;

    // Add markdown-body class for GitHub styling
    outputEl.classList.add('markdown-body');

    // Capture memory after execution (if available)
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryUsed = (memoryBefore !== null && memoryAfter !== null)
      ? memoryAfter - memoryBefore
      : null;

    // Update metrics in panel header
    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      let metricsText = `⏱ Render: ${executionTime.toFixed(2)} ms`;
      if (memoryUsed !== null) {
        const memoryMB = (Math.abs(memoryUsed) / 1024 / 1024).toFixed(2);
        metricsText += ` | 💾 ${memoryUsed >= 0 ? '+' : ''}${memoryMB} MB`;
      }
      metricsEl.textContent = metricsText;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Rendering cancelled</div>';
    } else {
      console.error('Markdown rendering error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    // Reset UI state
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// React/JSX execution function
async function runReactCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Transforming JSX...</div>';

    // Check if React, ReactDOM, and Babel are available
    if (typeof React === 'undefined') {
      throw new Error('React is not loaded');
    }
    if (typeof ReactDOM === 'undefined') {
      throw new Error('ReactDOM is not loaded');
    }
    if (typeof Babel === 'undefined') {
      throw new Error('Babel is not loaded');
    }

    // Capture memory before execution (if available)
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // This runner evaluates a function with the UMD React globals in scope.
    // The automatic JSX runtime emits ESM imports that new Function cannot
    // parse, so select classic explicitly rather than relying on Babel defaults.
    const transformed = Babel.transform(code, {
      presets: [['react', { runtime: 'classic' }]],
      filename: 'component.jsx'
    });

    const transformedCode = transformed.code;

    // Create a container div for the React component
    outputEl.innerHTML = '<div id="react-root" class="w-full h-full"></div>';
    const reactRoot = document.getElementById('react-root');

    // Execute the transformed code in a safe context
    // The code should either export a component or render directly
    try {
      // Create a function that has React and ReactDOM in scope
      const componentFunction = new Function('React', 'ReactDOM', 'rootElement', `
        ${transformedCode}

        // Try to render automatically if there's a default export or App component
        if (typeof App !== 'undefined') {
          ReactDOM.render(React.createElement(App), rootElement);
        } else if (typeof Component !== 'undefined') {
          ReactDOM.render(React.createElement(Component), rootElement);
        }
      `);

      // Execute the function
      componentFunction(React, ReactDOM, reactRoot);

      const endTime = performance.now();
      const executionTime = endTime - startTime;

      // Check if execution was cancelled
      if (executionState.shouldCancel) {
        outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
        return;
      }

      // Capture memory after execution (if available)
      const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
      const memoryUsed = (memoryBefore !== null && memoryAfter !== null)
        ? memoryAfter - memoryBefore
        : null;

      // Update metrics in panel header
      const metricsEl = document.getElementById("outputMetrics");
      if (metricsEl) {
        let metricsText = `⏱ Render: ${executionTime.toFixed(2)} ms`;
        if (memoryUsed !== null) {
          const memoryMB = (Math.abs(memoryUsed) / 1024 / 1024).toFixed(2);
          metricsText += ` | 💾 ${memoryUsed >= 0 ? '+' : ''}${memoryMB} MB`;
        }
        metricsEl.textContent = metricsText;
      }

    } catch (renderError) {
      console.error('React render error:', renderError);
      outputEl.innerHTML = '<div class="text-red-600 font-bold">Render Error:</div>' +
                          '<pre class="whitespace-pre-wrap">' + escapeHtml(renderError.toString()) + '</pre>' +
                          '<div class="mt-4 text-sm text-gray-600">Tip: Make sure your code exports a component as "App" or "Component", or uses ReactDOM.render() directly.</div>';
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('JSX execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    // Reset UI state
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Shell execution function using Wasmer SDK
async function runShellCode(code, outputEl) {
  try {
    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Initializing Wasmer for shell execution...</div>';

    // Dynamically import Wasmer SDK
    const { init, Wasmer } = await import('https://unpkg.com/@wasmer/sdk@0.9.0/dist/index.mjs');

    // Initialize Wasmer
    await init();

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading bash package...</div>';

    // Capture memory before execution (if available)
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    // Load bash package from Wasmer registry
    const pkg = await Wasmer.fromRegistry("sharrattj/bash");

    outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Running shell script...</div>';

    // Create a temporary script file
    const scriptContent = code;

    // Run bash with the script as an argument
    const runOptions = { args: ["-c", scriptContent] };

    // The Input tab text is the script's stdin (so `read` works), and
    // attached files are mounted as the working directory. Mounting over "/"
    // would clobber the bash package's own files, so they live in /work.
    const stdinText = getStdinText();
    if (stdinText) runOptions.stdin = stdinText;
    const inputFiles = getInputFiles();
    if (inputFiles.length > 0) {
      const dir = {};
      for (const f of inputFiles) dir[f.name] = f.bytes;
      runOptions.mount = { "/work": dir };
      runOptions.cwd = "/work";
    }

    const instance = await pkg.entrypoint.run(runOptions);

    // Wait for execution to complete
    const output = await instance.wait();

    const endTime = performance.now();
    const executionTime = endTime - startTime;

    // Check if execution was cancelled
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
      return;
    }

    // Capture memory after execution (if available)
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryUsed = (memoryBefore !== null && memoryAfter !== null)
      ? memoryAfter - memoryBefore
      : null;

    // Display output
    let outputHtml = '';

    // The exit code is not shown: this bash build reports 45 for every
    // script that prints, whatever the script's real status.

    if (output.stdout) {
      outputHtml += '<div class="text-green-600 font-bold">Output:</div>';
      outputHtml += '<pre class="whitespace-pre-wrap">' + ansiToHtml(output.stdout) + '</pre>';
    }

    if (output.stderr) {
      outputHtml += '<div class="text-orange-600 font-bold">Stderr:</div>';
      outputHtml += '<pre class="whitespace-pre-wrap">' + ansiToHtml(output.stderr) + '</pre>';
    }

    if (!output.stdout && !output.stderr) {
      outputHtml = '<div class="text-gray-600">Shell script executed successfully with no output.</div>';
    }

    outputEl.innerHTML = outputHtml;

    // Update metrics
    const metricsEl = document.getElementById("outputMetrics");
    if (metricsEl) {
      let metricsText = `⏱ ${executionTime.toFixed(2)} ms`;
      if (memoryUsed !== null) {
        const memoryMB = (Math.abs(memoryUsed) / 1024 / 1024).toFixed(2);
        metricsText += ` | 💾 ${memoryUsed >= 0 ? '+' : ''}${memoryMB} MB`;
      }
      metricsText += ` | Exit Code: ${output.code}`;
      metricsEl.textContent = metricsText;
    }

  } catch (error) {
    if (executionState.shouldCancel) {
      outputEl.innerHTML = '<div class="text-orange-600 font-bold">Execution cancelled</div>';
    } else {
      console.error('Shell execution error:', error);
      outputEl.innerHTML = '<div class="text-red-600"><strong>Error:</strong> ' +
                          escapeHtml(error.message || error.toString()) + '</div>';
    }
  } finally {
    // Reset UI state
    executionState.isRunning = false;
    const runButton = document.getElementById("runButton");
    const cancelButton = document.getElementById("cancelButton");
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Main runCode function
// Python runs on Pyodide (CPython compiled to WebAssembly) in a Web Worker
// (static/js/pyodide-worker.js), so the UI stays responsive and Cancel can
// terminate a runaway program. Pyodide ships binary wheels for the scientific
// stack (numpy, scipy, pandas, ...): the worker downloads whatever the
// program imports before running it, and micropip is available for
// pure-Python PyPI packages.
let pyodideWorker = null;
let pyodidePendingReject = null;

function getPyodideWorker() {
  if (pyodideWorker === null) {
    pyodideWorker = new Worker('/static/js/pyodide-worker.js');
  }
  return pyodideWorker;
}

// Terminate the Python worker (used by Cancel and the execution timeout). It
// is recreated lazily on the next run, which reloads the interpreter.
function terminatePyodideWorker() {
  if (pyodideWorker) {
    pyodideWorker.terminate();
    pyodideWorker = null;
  }
  // A debug session's tracer dies with the worker; tear down its panel.
  if (window.PbinDebug) window.PbinDebug.sessionEnded();
  if (pyodidePendingReject) {
    const reject = pyodidePendingReject;
    pyodidePendingReject = null;
    reject(new Error('cancelled'));
  }
}

// JavaScript debugger runs (static/js/js-debug-worker.js): plain runs stay
// on the sandboxed QuickJS/WASI runtime below, but QuickJS exposes no
// pause/inspect hooks, so "run in debugger" executes the paste as
// Babel-instrumented JavaScript in this dedicated worker instead — same
// pause protocol as the Pyodide debugger. The worker (and Babel, fetched
// from the CDN on first use) is kept across runs; Stop terminates it, which
// also unblocks an Atomics.wait pause.
let jsDebugWorker = null;
let jsDebugPendingReject = null;

function getJsDebugWorker() {
  if (jsDebugWorker === null) {
    jsDebugWorker = new Worker('/static/js/js-debug-worker.js');
  }
  return jsDebugWorker;
}

function terminateJsDebugWorker() {
  if (jsDebugWorker) {
    jsDebugWorker.terminate();
    jsDebugWorker = null;
  }
  if (window.PbinDebug) window.PbinDebug.sessionEnded();
  if (jsDebugPendingReject) {
    const reject = jsDebugPendingReject;
    jsDebugPendingReject = null;
    reject(new Error('cancelled'));
  }
}

// The paste's TypeScript as plain JavaScript with every statement kept on
// its original line: Babel's typescript preset with retainLines, run in
// the debug worker (which already holds the pinned Babel bundle).
// Line-preserving output means QuickJS runtime errors report *source* line
// numbers, with no source-map bookkeeping. Kept as the one seam for type
// stripping: swapping in another stripper (say SWC's wasm build) means
// replacing this function.
function transpileTypeScript(code) {
  return new Promise((resolve, reject) => {
    const worker = getJsDebugWorker();
    jsDebugPendingReject = reject; // Cancel terminates the worker and rejects
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      jsDebugPendingReject = null;
      if (msg.type === 'transpiled') resolve(msg.code);
      else reject(new Error(msg.error || 'TypeScript transpile failed'));
    };
    worker.onerror = (ev) => {
      jsDebugPendingReject = null;
      reject(new Error(ev.message || 'TypeScript transpile failed'));
    };
    worker.postMessage({ transpile: true, code });
  });
}

// The '@opentelemetry/api' module a JavaScript/TypeScript paste can import
// to create spans (static/js/otel-shim.js): the shim factory plus an
// ES-module footer that prints each finished trace as a sentinel line on
// stdout — the only channel out of the WASI sandbox — which
// PbinTraceView.extract strips back out of the output and renders as a span
// waterfall. Fetched once per page and cached; only runs whose code mentions
// the module pay for it. The sentinel literal mirrors PbinTraceView.SENTINEL
// (trace-view.js may not be loaded yet when this builds).
let otelModuleSourcePromise = null;
function getOtelModuleSource() {
  if (otelModuleSourcePromise === null) {
    otelModuleSourcePromise = fetch('/static/js/otel-shim.js')
      .then((r) => {
        if (!r.ok) throw new Error('fetching otel-shim.js failed: HTTP ' + r.status);
        return r.text();
      })
      .then((shim) => shim + '\n' + [
        'const __pbOtelApi = __pbOtelCreate(',
        "  (json) => console.log('__PBIN_OTEL_TRACE__' + json),",
        '  () => performance.now()',
        ');',
        'export const trace = __pbOtelApi.trace;',
        'export const context = __pbOtelApi.context;',
        'export const SpanStatusCode = __pbOtelApi.SpanStatusCode;',
        'export const SpanKind = __pbOtelApi.SpanKind;',
        'export const ROOT_CONTEXT = __pbOtelApi.ROOT_CONTEXT;',
        'export default __pbOtelApi;',
      ].join('\n'))
      .catch((err) => {
        otelModuleSourcePromise = null; // a later run may retry
        throw err;
      });
  }
  return otelModuleSourcePromise;
}

// ---- URL module imports (QuickJS runs) --------------------------------------
// Deno-style https:// imports for JavaScript/TypeScript pastes:
//
//   import camelCase from 'https://esm.sh/camelcase@8.0.0';
//
// The sandbox itself stays offline — like Deno, the module graph is resolved
// and fetched BEFORE execution, here on the page (allowlisted module CDNs
// only, so a shared paste can't make a viewer's browser fetch arbitrary
// URLs), and mirrored into the program's virtual filesystem under the exact
// paths QuickJS's module loader will open:
//
//   - an https:// specifier is opened literally, so the module lives at
//     '/https://host/path?query';
//   - a CDN module's absolute-path import ('/pkg@1.0.0/x.mjs') is opened
//     from the root, so it lives at that path;
//   - its relative imports resolve against the importing module's own path,
//     which mirrors the URL structure, so they land where QuickJS looks.
//
// Such runs start from a /pbin-main wrapper that imports a small web-globals
// prelude (qjs-web-globals.js: Blob, TextEncoder, URL, timers — CDN modules
// reference these at eval time) before /program, which keeps /program's line
// numbers intact for error reporting. Fetched sources are cached for the
// page's lifetime, so re-runs are offline too.

const URL_IMPORT_HOSTS = ['esm.sh', 'cdn.jsdelivr.net', 'unpkg.com'];
const URL_IMPORT_MAX_MODULES = 600;
const URL_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

const moduleTextCache = new Map(); // absolute URL -> Promise<string>
function fetchModuleText(url) {
  if (!moduleTextCache.has(url)) {
    const promise = fetch(url).then((r) => {
      if (!r.ok) throw new Error('fetching module ' + url + ' failed: HTTP ' + r.status);
      return r.text();
    }).catch((err) => {
      moduleTextCache.delete(url); // a later run may retry
      throw err;
    });
    moduleTextCache.set(url, promise);
  }
  return moduleTextCache.get(url);
}

// Import/export specifiers in a module's source. The clause between the
// keyword and `from` is limited to binding-ish characters so the match can't
// swallow unrelated code between two statements; CDN output is
// machine-generated and regular, and for the paste itself an over-match only
// costs a redundant fetch from an allowlisted host (unused filesystem
// entries are never executed).
const MODULE_SPEC_RE = /(?:^|[\s;})])(?:import|export)\s*(?:[\w*\s{},$]*?from\s*)?["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gm;
function moduleSpecifiers(source) {
  const specs = [];
  let m;
  MODULE_SPEC_RE.lastIndex = 0;
  while ((m = MODULE_SPEC_RE.exec(source))) specs.push(m[1] || m[2]);
  return specs;
}

function assertAllowedModuleHost(url) {
  if (url.protocol === 'https:' && URL_IMPORT_HOSTS.includes(url.hostname)) return;
  throw new Error('URL imports are limited to ' + URL_IMPORT_HOSTS.join(', ') +
    " — can't load " + url.href);
}

// './x' / '../x' against the directory of a virtual-filesystem key, the way
// QuickJS normalizes relative module names.
function resolveRelativeKey(importerKey, spec) {
  const parts = importerKey.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    else if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/') || '/';
}

// The {virtualPath: source} map for every module reachable from the paste's
// https:// imports, or null when it has none.
async function collectUrlModules(code) {
  const roots = [];
  for (const spec of moduleSpecifiers(code)) {
    if (/^https:\/\//.test(spec)) roots.push(spec);
  }
  if (!roots.length) return null;

  const files = Object.create(null);   // virtual path -> source
  const sourceUrl = Object.create(null); // virtual path -> URL it came from
  let totalBytes = 0;
  const queue = roots.map((spec) => ({ key: '/' + spec, url: new URL(spec) }));
  while (queue.length) {
    const { key, url } = queue.shift();
    if (key in files) {
      // Two hosts can in principle claim the same absolute path; refuse the
      // ambiguity rather than let one shadow the other.
      if (sourceUrl[key].href !== url.href) {
        throw new Error('conflicting module imports: ' + sourceUrl[key].href + ' and ' +
          url.href + ' both resolve to ' + key);
      }
      continue;
    }
    assertAllowedModuleHost(url);
    if (Object.keys(files).length >= URL_IMPORT_MAX_MODULES) {
      throw new Error('URL import graph exceeds ' + URL_IMPORT_MAX_MODULES + ' modules');
    }
    const source = await fetchModuleText(url.href);
    totalBytes += source.length;
    if (totalBytes > URL_IMPORT_MAX_BYTES) {
      throw new Error('URL import graph exceeds ' + (URL_IMPORT_MAX_BYTES >> 20) + ' MB');
    }
    files[key] = source;
    sourceUrl[key] = url;
    for (const spec of moduleSpecifiers(source)) {
      if (/^https:\/\//.test(spec)) {
        queue.push({ key: '/' + spec, url: new URL(spec) });
      } else if (spec.startsWith('/')) {
        queue.push({ key: spec, url: new URL(spec, url) });
      } else if (spec.startsWith('./') || spec.startsWith('../')) {
        queue.push({ key: resolveRelativeKey(key, spec), url: new URL(spec, url) });
      } else if (spec.startsWith('node:')) {
        throw new Error('module ' + url.href + " imports the Node builtin '" + spec +
          "', which the QuickJS sandbox can't provide");
      }
      // Bare specifiers ('std', 'os', '@opentelemetry/api',
      // 'pbin/effect-tracing') resolve against what the runner itself serves.
    }
  }
  return files;
}

// Support files served alongside URL imports, fetched once and cached.
const staticTextCache = new Map();
function fetchStaticText(path) {
  if (!staticTextCache.has(path)) {
    const promise = fetch(path).then((r) => {
      if (!r.ok) throw new Error('fetching ' + path + ' failed: HTTP ' + r.status);
      return r.text();
    }).catch((err) => {
      staticTextCache.delete(path);
      throw err;
    });
    staticTextCache.set(path, promise);
  }
  return staticTextCache.get(path);
}

// Only this exact built-in specifier opts into the pinned same-origin Effect
// graph. Arbitrary bare/relative imports do not become network requests; URL
// imports retain their existing separate allowlist and resource limits.
const BUNDLED_EFFECT_ID = 'pbin/effect@3.12.0';
const BUNDLED_EFFECT_PATH = '/static/vendor/effect/3.12.0/modules.json';
let bundledEffectModulesPromise = null;
function getBundledEffectModules() {
  if (bundledEffectModulesPromise === null) {
    bundledEffectModulesPromise = fetchStaticText(BUNDLED_EFFECT_PATH).then((text) => {
      if (text.length > URL_IMPORT_MAX_BYTES) throw new Error('bundled Effect graph exceeds size limit');
      const bundle = JSON.parse(text);
      if (bundle.format !== 'pbin-effect-vfs-1' || bundle.version !== '3.12.0' ||
          bundle.entry !== '/' + BUNDLED_EFFECT_ID || !bundle.files ||
          typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
        throw new Error('invalid bundled Effect graph');
      }
      const entries = Object.entries(bundle.files);
      if (!entries.length || entries.length > URL_IMPORT_MAX_MODULES ||
          typeof bundle.files[bundle.entry] !== 'string') throw new Error('incomplete bundled Effect graph');
      const files = Object.create(null);
      for (const [path, source] of entries) {
        if (typeof source !== 'string' || (path !== bundle.entry &&
            (!/^\/pbin\/vendor\/effect\/3\.12\.0\/[A-Za-z0-9_./-]+\.js$/.test(path) ||
             path.split('/').slice(1).some(part => !part || part === '..' || part === '.')))) {
          throw new Error('invalid bundled Effect module path: ' + path);
        }
        files[path] = source;
      }
      return files;
    }).catch((error) => {
      bundledEffectModulesPromise = null;
      staticTextCache.delete(BUNDLED_EFFECT_PATH);
      throw error;
    });
  }
  return bundledEffectModulesPromise;
}

// A JavaScript or TypeScript run under the debugger; dbg is the session
// PbinDebug prepared. No timeout: the run is expected to sit paused
// indefinitely.
async function runJavaScriptDebugCode(code, outputEl, dbg) {
  const runButton = document.getElementById("runButton");
  const cancelButton = document.getElementById("cancelButton");
  const metricsEl = document.getElementById("outputMetrics");
  const spinner = (text) =>
    '<div class="text-gray-600 flex items-center"><span class="spinner"></span>' + escapeHtml(text) + '</div>';

  try {
    outputEl.innerHTML = spinner('Loading JavaScript debugger...');
    const worker = getJsDebugWorker();
    const startTime = performance.now();

    dbg.attachOutput(outputEl);
    const result = await new Promise((resolve, reject) => {
      jsDebugPendingReject = reject;
      worker.onmessage = (ev) => {
        const msg = ev.data || {};
        if (dbg.handleMessage(msg)) return;
        if (msg.type === 'status') {
          if (!executionState.shouldCancel) outputEl.innerHTML = spinner(msg.text);
          return;
        }
        jsDebugPendingReject = null;
        if (msg.type === 'result') resolve(msg);
        else reject(new Error(msg.error || 'JavaScript execution failed'));
      };
      worker.onerror = (ev) => {
        jsDebugPendingReject = null;
        reject(new Error(ev.message || 'JavaScript debug worker error'));
      };
      worker.postMessage({ code, stdin: getStdinText(), lang: dbg.lang, debug: dbg.workerConfig });
    });

    if (executionState.shouldCancel) {
      return;
    }

    const executionTime = performance.now() - startTime;
    // Traces the paste emitted (otel-shim.js) come back on the result
    // message — the worker collects them instead of printing sentinel lines,
    // so the live output stream stays clean while the run is paused.
    let otelTraces = [];
    if (window.PbinTraceView && Array.isArray(result.otelTraces)) {
      for (const json of result.otelTraces) {
        try {
          const payload = JSON.parse(json);
          if (payload && payload.pbin === 'otel-trace' && Array.isArray(payload.spans)) otelTraces.push(payload);
        } catch (e) { /* skip a malformed payload */ }
      }
    }
    let output = '';
    if (result.stdout) {
      output += `<div class="text-green-600 font-bold">Output:</div><pre class="whitespace-pre-wrap">${escapeHtml(result.stdout)}</pre>`;
    }
    if (result.stderr) {
      output += `<div class="text-orange-600 font-bold">Stderr:</div><pre class="whitespace-pre-wrap">${escapeHtml(result.stderr)}</pre>`;
    }
    if (!result.stdout && !result.stderr) {
      output = otelTraces.length
        ? '<div class="text-gray-600">No printed output — the run\'s spans are in the trace tab.</div>'
        : '<div class="text-gray-600">Code executed successfully with no output.</div>';
    }
    if (result.exitCode !== 0) {
      output += `<div class="text-red-600 mt-2">Exit code: ${result.exitCode}</div>`;
    }
    outputEl.innerHTML = output;
    if (otelTraces.length) PbinTraceView.render(outputEl, otelTraces);

    if (metricsEl) {
      metricsEl.textContent = `⏱ ${executionTime.toFixed(2)} ms`;
    }
  } catch (err) {
    if (executionState.shouldCancel) {
      return;
    }
    console.error('JavaScript debug execution error:', err);
    const errText = (err && err.message) || String(err);
    outputEl.innerHTML = `<div class="text-red-600 font-bold">Execution Error:</div><pre class="whitespace-pre-wrap">${escapeHtml(errText)}</pre>`;
  } finally {
    dbg.end();
    executionState.isRunning = false;
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

async function runPythonCode(code, outputEl) {
  const runButton = document.getElementById("runButton");
  const cancelButton = document.getElementById("cancelButton");
  const metricsEl = document.getElementById("outputMetrics");
  const spinner = (text) =>
    '<div class="text-gray-600 flex items-center"><span class="spinner"></span>' + escapeHtml(text) + '</div>';

  // With Run set to the debugger (static/js/debug.js), the run goes through
  // the worker's sys.settrace debugger: it can pause, step and inspect, so
  // the 30-second timeout is skipped — Stop still terminates the worker.
  const dbg = (window.PbinDebug && window.PbinDebug.prepareRun()) || null;

  try {
    outputEl.innerHTML = spinner('Loading Python runtime (Pyodide)...');

    const worker = getPyodideWorker();
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;
    const startTime = performance.now();

    if (dbg) dbg.attachOutput(outputEl);
    const result = await new Promise((resolve, reject) => {
      pyodidePendingReject = reject;
      worker.onmessage = (ev) => {
        const msg = ev.data || {};
        if (dbg && dbg.handleMessage(msg)) return;
        if (msg.type === 'status') {
          if (!executionState.shouldCancel) outputEl.innerHTML = spinner(msg.text);
          // The 30-second timeout covers the program itself, not the
          // interpreter/package downloads (cached after the first run).
          if (msg.text === 'Running code...' && executionState.timeoutId === null && !dbg) {
            executionState.timeoutId = setTimeout(() => {
              executionState.timeoutId = null;
              const pendingReject = pyodidePendingReject;
              pyodidePendingReject = null;
              if (pyodideWorker) {
                pyodideWorker.terminate();
                pyodideWorker = null;
              }
              if (pendingReject) pendingReject(new Error('Execution timeout (30 seconds)'));
            }, 30000);
          }
          return;
        }
        pyodidePendingReject = null;
        if (msg.type === 'result') resolve(msg);
        else reject(new Error(msg.error || 'Python execution failed'));
      };
      worker.onerror = (ev) => {
        pyodidePendingReject = null;
        reject(new Error(ev.message || 'Python worker error'));
      };
      worker.postMessage({ code, stdin: getStdinText(), files: getInputFiles(), debug: dbg ? dbg.workerConfig : null });
    });

    if (executionState.timeoutId) {
      clearTimeout(executionState.timeoutId);
      executionState.timeoutId = null;
    }

    if (executionState.shouldCancel) {
      return;
    }

    const executionTime = performance.now() - startTime;
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
    const memoryUsed = (memoryBefore !== null && memoryAfter !== null)
      ? memoryAfter - memoryBefore
      : null;

    let output = '';
    if (result.stdout) {
      output += `<div class="text-green-600 font-bold">Output:</div><pre class="whitespace-pre-wrap">${escapeHtml(result.stdout)}</pre>`;
    }
    if (result.stderr) {
      output += `<div class="text-orange-600 font-bold">Stderr:</div><pre class="whitespace-pre-wrap">${escapeHtml(result.stderr)}</pre>`;
    }
    if (!result.stdout && !result.stderr) {
      output = '<div class="text-gray-600">Code executed successfully with no output.</div>';
    }
    if (result.exitCode !== 0) {
      output += `<div class="text-red-600 mt-2">Exit code: ${result.exitCode}</div>`;
    }
    outputEl.innerHTML = output;

    renderRunFiles(outputEl, result.files.map((f) => ({ name: f.name, content: f.bytes })));

    if (metricsEl) {
      let metricsText = `⏱ ${executionTime.toFixed(2)} ms`;
      if (memoryUsed !== null) {
        const memoryMB = (Math.abs(memoryUsed) / 1024 / 1024).toFixed(2);
        metricsText += ` | 💾 ${memoryUsed >= 0 ? '+' : ''}${memoryMB} MB`;
      }
      metricsEl.textContent = metricsText;
    }
  } catch (err) {
    if (executionState.timeoutId) {
      clearTimeout(executionState.timeoutId);
      executionState.timeoutId = null;
    }

    if (executionState.shouldCancel) {
      return;
    }

    console.error('Pyodide execution error:', err);
    const errText = (err && err.message) || String(err);
    outputEl.innerHTML = `<div class="text-red-600 font-bold">Execution Error:</div><pre class="whitespace-pre-wrap">${escapeHtml(errText)}</pre>`;
  } finally {
    if (dbg) dbg.end();
    executionState.isRunning = false;
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

async function runCode(getValueFn, languageValue) {
  // Prevent multiple simultaneous executions
  if (executionState.isRunning) {
    return;
  }

  // Both mutable: a TypeScript paste is transpiled below and then runs as
  // JavaScript.
  let code = getValueFn ? getValueFn() : (window.getValue ? window.getValue() : '');
  let lang = languageValue || (document.getElementById("language") ? document.getElementById("language").value : '');
  const outputEl = document.getElementById("output");

  if (!outputEl) {
    console.error('Output element not found');
    return;
  }

  // Clear previous output, and the trace tab along with it: the old run's
  // spans no longer describe what this output shows.
  outputEl.innerHTML = '';
  if (window.PbinTraceView) PbinTraceView.clear();

  // Remove markdown-body class if it exists
  outputEl.classList.remove('markdown-body');

  // Clear metrics
  const metricsEl = document.getElementById("outputMetrics");
  if (metricsEl) {
    metricsEl.textContent = '';
  }

  // Set execution state
  executionState.isRunning = true;
  executionState.shouldCancel = false;

  // Update UI
  const runButton = document.getElementById("runButton");
  const cancelButton = document.getElementById("cancelButton");
  if (runButton) runButton.disabled = true;
  if (cancelButton) cancelButton.classList.remove("hidden");

  // Handle JSX/React code
  if (lang === 'jsx') {
    await runReactCode(code, outputEl);
    return;
  }

  // Handle Markdown with GitHub Flavored Markdown
  if (lang === 'markdown') {
    await runMarkdownCode(code, outputEl);
    return;
  }

  if (lang === "mermaid") {
    // Render Mermaid diagram using v10+ API
    if (typeof mermaid !== 'undefined') {
      mermaid.render('theGraph', code)
        .then(({svg}) => {
          if (!executionState.shouldCancel) {
            outputEl.innerHTML = svg;
          }
        })
        .catch((err) => {
          if (!executionState.shouldCancel) {
            outputEl.innerText = "Mermaid render error: " + err;
          }
        })
        .finally(() => {
          // Reset UI state
          executionState.isRunning = false;
          if (runButton) runButton.disabled = false;
          if (cancelButton) cancelButton.classList.add("hidden");
        });
    } else {
      outputEl.innerHTML = '<div class="text-yellow-600">Mermaid library not loaded</div>';
      executionState.isRunning = false;
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
    }
    return;
  }

  // Handle C++ code with wasm-clang
  if (lang === 'cpp' || lang === 'c') {
    await runCppCode(code, outputEl);
    return;
  }

  // Handle MiniZinc code
  if (lang === 'minizinc') {
    await runMiniZincCode(code, outputEl);
    return;
  }

  // Handle Scheme code
  if (lang === 'scheme') {
    await runSchemeCode(code, outputEl);
    return;
  }

  // Handle Clojure code (SCI in a worker)
  if (lang === 'clojure') {
    await runClojureCode(code, outputEl);
    return;
  }

  // Handle Shell code
  if (lang === 'shell') {
    await runShellCode(code, outputEl);
    return;
  }

  // Handle AutoLISP code
  if (lang === 'autolisp') {
    await runAutoLispCode(code, outputEl);
    return;
  }

  // Handle TLA+ code
  if (lang === 'tlaplus') {
    await runTlaCode(code, outputEl);
    return;
  }

  // Handle Picat code
  if (lang === 'picat') {
    await runPicatCode(code, outputEl);
    return;
  }

  // Handle OCaml code
  if (lang === 'ocaml') {
    await runOCamlCode(code, outputEl);
    return;
  }

  // Handle Python code (Pyodide worker)
  if (lang === 'python') {
    await runPythonCode(code, outputEl);
    return;
  }

  // JavaScript/TypeScript with Run set to "run in debugger": the
  // instrumented debug worker instead of QuickJS (which has no pause
  // hooks). The worker strips TypeScript's types itself.
  if (lang === 'javascript' || lang === 'typescript') {
    const jsDbg = (window.PbinDebug && window.PbinDebug.prepareRun()) || null;
    if (jsDbg) {
      await runJavaScriptDebugCode(code, outputEl, jsDbg);
      return;
    }
  }

  // Plain TypeScript runs: strip the types (line-preservingly, so runtime
  // errors cite source lines), then run the result exactly like a
  // JavaScript paste (QuickJS below).
  if (lang === 'typescript') {
    try {
      outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Compiling TypeScript...</div>';
      code = await transpileTypeScript(code);
      lang = 'javascript';
    } catch (err) {
      outputEl.innerHTML = '<div class="text-red-600 font-bold">TypeScript Error:</div><pre class="whitespace-pre-wrap">' +
        escapeHtml((err && err.message) || String(err)) + '</pre>';
      executionState.isRunning = false;
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
      return;
    }
  }

  // Map Monaco language IDs to Runno runtime definitions. These mirror what
  // @runno/runtime's headlessRunCode sets up, but we drive the WASI host
  // ourselves because the headless API never sends stdin EOF — a program
  // doing read-to-end on stdin would hang forever.
  const runnoLanguageMap = {
    'ruby': {
      binaryURL: 'https://runno.dev/langs/ruby-3.2.0.wasm',
      binaryName: 'ruby',
      args: ['-r', '/ruby-3.2.0/.rubyopts.rb', '/program'],
      baseFSURL: 'https://runno.dev/langs/ruby-3.2.0.tar.gz'
    },
    'javascript': {
      // quickjs-ng's WASI build, vendored (see static/wasm/quickjs/BUILD.md):
      // a current QuickJS, so ES2025 iterator helpers (.map/.filter/.flatMap/…
      // on generators) work — runno.dev's wasmedge_quickjs predates them.
      binaryURL: '/static/wasm/quickjs/qjs-wasi.wasm',
      binaryName: 'qjs',
      // -m: always a module, as on the old runtime — strict mode and
      // top-level await regardless of whether the paste has imports.
      args: ['-m', '/program'],
      // quickjs-ng names its runtime modules qjs:std and qjs:os; pastes and
      // the starters import the classic bare 'std'/'os', which the module
      // loader resolves as file paths. These shims bridge the two.
      extraFS: {
        '/std': "export * from 'qjs:std';\n",
        '/os': "export * from 'qjs:os';\n",
      }
    }
  };

  const runnoRuntime = runnoLanguageMap[lang];

  if (runnoRuntime) {
    // Use Runno for supported languages
    try {
      // URL module imports resolve before the run (and before the execution
      // timeout starts counting): the graph is mirrored into the filesystem
      // below and QuickJS then executes it entirely offline.
      let urlModules = null;
      let bundledModules = null;
      if (lang === 'javascript' && moduleSpecifiers(code).includes(BUNDLED_EFFECT_ID)) {
        outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Loading bundled Effect...</div>';
        bundledModules = await getBundledEffectModules();
      }
      if (lang === 'javascript' && code.indexOf('https://') !== -1) {
        outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Fetching modules...</div>';
        urlModules = await collectUrlModules(code);
      }
      const wantsEffectTracing = lang === 'javascript' && code.indexOf('pbin/effect-tracing') !== -1;

      outputEl.innerHTML = '<div class="text-gray-600 flex items-center"><span class="spinner"></span>Running code...</div>';

      const [{ WASIWorkerHost }, { fetchWASIFS }] = await Promise.all([
        import('https://unpkg.com/@runno/wasi@0.6.1/dist/wasi.js'),
        import('https://unpkg.com/@runno/runtime@0.6.1/dist/runtime.js')
      ]);

      // Capture memory before execution (if available)
      const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : null;

      // Start timing
      const startTime = performance.now();

      // Create timeout promise (30 seconds)
      const timeoutPromise = new Promise((_, reject) => {
        executionState.timeoutId = setTimeout(() => {
          reject(new Error('Execution timeout (30 seconds)'));
        }, 30000);
      });

      // Build the program's filesystem: the code at /program plus the
      // attached input files, readable by name from the working directory.
      const now = new Date();
      const timestamps = { access: now, modification: now, change: now };
      const runFS = {
        '/program': { path: 'program', content: code, mode: 'string', timestamps },
      };
      for (const f of getInputFiles()) {
        runFS['/' + f.name] = { path: f.name, content: f.bytes, mode: 'binary', timestamps };
      }
      // The runtime's own support files (the quickjs module shims) win over
      // same-named attachments: imports must keep resolving.
      for (const [path, content] of Object.entries(runnoRuntime.extraFS || {})) {
        runFS[path] = { path: path.slice(1), content, mode: 'string', timestamps };
      }
      // The tracing module joins the filesystem only when the paste can
      // import it (see getOtelModuleSource above). The Effect adapter
      // (effect-tracing.js) imports it too.
      if (lang === 'javascript' && (code.indexOf('@opentelemetry/api') !== -1 || wantsEffectTracing)) {
        runFS['/@opentelemetry/api'] = {
          path: '@opentelemetry/api',
          content: await getOtelModuleSource(),
          mode: 'string',
          timestamps,
        };
      }
      if (wantsEffectTracing) {
        runFS['/pbin/effect-tracing'] = {
          path: 'pbin/effect-tracing',
          content: await fetchStaticText('/static/js/effect-tracing.js'),
          mode: 'string',
          timestamps,
        };
      }
      // The mirrored URL-import graph, plus the wrapper main that loads the
      // web-globals prelude ahead of the program (see collectUrlModules).
      if (urlModules || bundledModules) {
        for (const path of Object.keys(bundledModules || {})) {
          if (urlModules && path in urlModules) throw new Error('URL import conflicts with bundled Effect module: ' + path);
        }
        for (const [path, content] of Object.entries({ ...urlModules, ...bundledModules })) {
          runFS[path] = { path: path.slice(1), content, mode: 'string', timestamps };
        }
        runFS['/pbin-globals'] = {
          path: 'pbin-globals',
          content: await fetchStaticText('/static/js/qjs-web-globals.js'),
          mode: 'string',
          timestamps,
        };
        runFS['/pbin-main'] = {
          path: 'pbin-main',
          content: "import '/pbin-globals';\nimport '/program';\n",
          mode: 'string',
          timestamps,
        };
      }
      const stdinText = getStdinText();

      // The language's own filesystem (stdlib and such) sits underneath.
      let fullFS = runFS;
      if (runnoRuntime.baseFSURL) {
        const baseFS = await fetchWASIFS(runnoRuntime.baseFSURL);
        fullFS = { ...runFS, ...baseFS };
      }

      let stdoutStr = '';
      let stderrStr = '';
      // Resolve the binary URL against the page: the host fetches it from
      // inside a worker whose own base URL is the CDN the host loads from,
      // which would misresolve the self-hosted quickjs path.
      const binaryURL = new URL(runnoRuntime.binaryURL, window.location.href).toString();
      // URL and bundled imports start from the wrapper main so the
      // web-globals prelude evaluates before any user import.
      const runArgs = (urlModules || bundledModules)
        ? runnoRuntime.args.map((a) => (a === '/program' ? '/pbin-main' : a))
        : runnoRuntime.args;
      const host = new WASIWorkerHost(binaryURL, {
        args: [runnoRuntime.binaryName, ...runArgs],
        env: {},
        fs: fullFS,
        stdout: (s) => { stdoutStr += s; },
        stderr: (s) => { stderrStr += s; },
      });

      // Feed stdin concurrently with the run (each push waits for the
      // program to drain the shared buffer, which holds 8 KB) and close the
      // stream so read-to-end terminates.
      (async () => {
        try {
          for (let i = 0; i < stdinText.length; i += 2000) {
            await host.pushStdin(stdinText.slice(i, i + 2000));
          }
          await host.pushEOF();
        } catch (e) { /* the worker was killed or crashed; the run reports it */ }
      })();

      let result;
      try {
        const hostResult = await Promise.race([host.start(), timeoutPromise]);
        result = {
          stdout: stdoutStr,
          stderr: stderrStr,
          exitCode: hostResult.exitCode,
          fs: { ...fullFS, ...hostResult.fs },
        };
      } catch (err) {
        host.kill();
        throw err;
      }

      // Clear timeout if execution finished before timeout
      if (executionState.timeoutId) {
        clearTimeout(executionState.timeoutId);
        executionState.timeoutId = null;
      }

      // Check if execution was cancelled
      if (executionState.shouldCancel) {
        return;
      }

      // End timing
      const endTime = performance.now();
      const executionTime = endTime - startTime;

      // Capture memory after execution (if available)
      const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : null;
      const memoryUsed = (memoryBefore !== null && memoryAfter !== null)
        ? memoryAfter - memoryBefore
        : null;

      // Traces the paste emitted (otel-shim.js) ride stdout as sentinel
      // lines; strip them out of the text and render them as span
      // waterfalls after it.
      let stdoutText = result.stdout;
      let otelTraces = [];
      if (window.PbinTraceView) {
        const extracted = PbinTraceView.extract(result.stdout);
        stdoutText = extracted.text;
        otelTraces = extracted.traces;
      }

      // Display output (failures to start the runtime throw and are
      // reported by the catch below)
      let output = '';
      {
        if (stdoutText) {
          output += `<div class="text-green-600 font-bold">Output:</div><pre class="whitespace-pre-wrap">${escapeHtml(stdoutText)}</pre>`;
        }
        if (result.stderr) {
          output += `<div class="text-orange-600 font-bold">Stderr:</div><pre class="whitespace-pre-wrap">${escapeHtml(result.stderr)}</pre>`;
        }
        if (!stdoutText && !result.stderr) {
          output = otelTraces.length
            ? '<div class="text-gray-600">No printed output — the run\'s spans are in the trace tab.</div>'
            : '<div class="text-gray-600">Code executed successfully with no output.</div>';
        }
        if (result.exitCode !== 0) {
          output += `<div class="text-red-600 mt-2">Exit code: ${result.exitCode}</div>`;
        }
      }

      outputEl.innerHTML = output;
      if (otelTraces.length) PbinTraceView.render(outputEl, otelTraces);

      // Files the program created in its working directory, offered as
      // downloads. The runtime's own files (stdlib and such) all live in
      // subdirectories, so only root-level additions count.
      const createdFiles = [];
      if (result.fs) {
        for (const [path, file] of Object.entries(result.fs)) {
          if (runFS[path]) continue; // the program itself and attached inputs
          const parts = path.split('/').filter(Boolean);
          if (parts.length !== 1) continue;
          createdFiles.push({ name: parts[0], content: file.content });
        }
      }
      renderRunFiles(outputEl, createdFiles);

      // Update metrics in panel header
      if (metricsEl) {
        let metricsText = `⏱ ${executionTime.toFixed(2)} ms`;
        if (memoryUsed !== null) {
          const memoryMB = (Math.abs(memoryUsed) / 1024 / 1024).toFixed(2);
          metricsText += ` | 💾 ${memoryUsed >= 0 ? '+' : ''}${memoryMB} MB`;
        }
        metricsEl.textContent = metricsText;
      }
    } catch (err) {
      // Clear timeout on error
      if (executionState.timeoutId) {
        clearTimeout(executionState.timeoutId);
        executionState.timeoutId = null;
      }

      // Check if execution was cancelled
      if (executionState.shouldCancel) {
        return;
      }

      console.error('Runno execution error:', err);
      // The worker host can reject with plain objects, whose toString is
      // the unhelpful [object Object].
      const errText = (err && err.message) ||
        (err && typeof err === 'object' && String(err) === '[object Object]' ? JSON.stringify(err) : String(err));
      outputEl.innerHTML = `<div class="text-red-600 font-bold">Execution Error:</div><pre class="whitespace-pre-wrap">${escapeHtml(errText)}</pre>`;
    } finally {
      // Reset UI state
      executionState.isRunning = false;
      if (runButton) runButton.disabled = false;
      if (cancelButton) cancelButton.classList.add("hidden");
    }
  } else {
    outputEl.innerHTML = `<div class="text-yellow-600">Code execution not supported for language: ${lang}</div><div class="text-gray-600 mt-2">Supported languages: Python, Ruby, C, C++, JavaScript, TypeScript, JSX/React, Shell, Scheme, Clojure, OCaml, MiniZinc, Mermaid, Markdown, AutoLISP</div>`;
    // Reset UI state for unsupported language
    executionState.isRunning = false;
    if (runButton) runButton.disabled = false;
    if (cancelButton) cancelButton.classList.add("hidden");
  }
}

// Export functions to window object for backwards compatibility
if (typeof window !== 'undefined') {
  window.runCode = runCode;
  window.cancelExecution = cancelExecution;
  window.downloadOutput = downloadOutput;
  window.pbinDownloadRunFile = downloadRunFile;
  window.pbinOutputText = function () {
    const outputEl = document.getElementById('output');
    return outputEl ? outputPlainText(outputEl) : '';
  };
  window.WasmClangAPI = WasmClangAPI;
  window.runCppCode = runCppCode;
  window.runMiniZincCode = runMiniZincCode;
  window.runSchemeCode = runSchemeCode;
  window.runClojureCode = runClojureCode;
  // Live introspection of the last Clojure run's context (clojure-lsp.js).
  window.pbinClojureMeta = function (sym) {
    return clojureQuery({ type: 'meta', sym: sym }, 'meta', null)
      .then(function (m) { return m && m.found ? m : null; });
  };
  window.pbinClojurePublics = function () {
    return clojureQuery({ type: 'publics' }, 'publics', { names: [] })
      .then(function (m) { return (m && m.names) || []; });
  };
  window.runShellCode = runShellCode;
  window.runPythonCode = runPythonCode;
  window.runReactCode = runReactCode;
  window.runMarkdownCode = runMarkdownCode;
  window.runAutoLispCode = runAutoLispCode;
  window.runOCamlCode = runOCamlCode;
  window.escapeHtml = escapeHtml;
  window.ansiToHtml = ansiToHtml;
}
