// Socket-free regression using the real pinned Effect graph and checked-in
// QuickJS WASM. Node's WASI host replaces only the browser worker transport;
// hosted Chromium remains authoritative for HTTP, TypeScript and waterfall UI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { WASI } = require('node:wasi');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const vendor = 'wordpress/pbin/static/vendor/effect/3.12.0/';
const asset = '/static/vendor/effect/3.12.0/modules.json';
const entry = '/pbin/effect@3.12.0';
const prefix = '/pbin/vendor/effect/3.12.0/';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function executeWasi(wasm, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pbin-effect-wasi-'));
  let stdout, stderr;
  try {
    for (const [key, file] of Object.entries(options.fs)) {
      const target = path.join(directory, key);
      assert.ok(target.startsWith(directory + path.sep), 'WASI fixture must stay inside its temp directory');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    stdout = fs.openSync(path.join(directory, 'stdout.txt'), 'w');
    stderr = fs.openSync(path.join(directory, 'stderr.txt'), 'w');
    const wasi = new WASI({ version: 'preview1', args: Array.from(options.args), env: {},
      preopens: { '/': directory }, stdout, stderr, returnOnExit: true });
    const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject());
    const exitCode = wasi.start(instance);
    options.stdout(fs.readFileSync(path.join(directory, 'stdout.txt'), 'utf8'));
    options.stderr(fs.readFileSync(path.join(directory, 'stderr.txt'), 'utf8'));
    return { exitCode, fs: {} };
  } finally {
    if (stdout !== undefined) fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function harness(wasm) {
  const requests = [], responses = new Map(), runs = [], traces = [], errors = [];
  const output = { innerHTML: '', classList: { remove() {} } };
  const context = vm.createContext({ window: { location: { href: 'https://pbin.invalid/' } },
    URL, performance, setTimeout, clearTimeout, MutationObserver: class { observe() {} disconnect() {} }, console: { error: e => errors.push(e) },
    document: {
      getElementById: id => id === 'output' ? output : null,
      createElement: () => ({ textContent: '', get innerHTML() {
        return this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      } }),
    },
    fetch: async url => {
      requests.push(url);
      const body = responses.has(url) ? responses.get(url) :
        (url.startsWith('/static/') ? read('wordpress/pbin' + url) : undefined);
      assert.notEqual(body, undefined, `unexpected network dependency: ${url}`);
      return typeof body === 'number' ? { ok: false, status: body } : { ok: true, text: async () => body };
    },
  });
  class WASIWorkerHost {
    constructor(url, options) {
      assert.equal(url, 'https://pbin.invalid/static/wasm/quickjs/qjs-wasi.wasm');
      this.options = options;
      runs.push(options);
    }
    async pushStdin() { throw new Error('this starter does not use stdin'); }
    async pushEOF() {}
    async start() { return executeWasi(wasm, this.options); }
    kill() { throw new Error('unexpected runtime timeout'); }
  }
  const imports = new Map([
    ['https://unpkg.com/@runno/wasi@0.6.1/dist/wasi.js', { WASIWorkerHost }],
    ['https://unpkg.com/@runno/runtime@0.6.1/dist/runtime.js', {
      fetchWASIFS: () => { throw new Error('unexpected runtime filesystem download'); },
    }],
  ]);
  for (const file of ['hello-world.js', 'trace-view.js', 'code-runner.js']) {
    vm.runInContext(read('wordpress/pbin/static/js/' + file), context, {
      importModuleDynamically: async spec => {
        const exports = imports.get(spec);
        assert.ok(exports, `unexpected host import: ${spec}`);
        const mod = new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
        await mod.link(() => {});
        await mod.evaluate();
        return mod;
      },
    });
  }
  context.PbinTraceView = context.window.PbinTraceView;
  context.PbinTraceView.clear = () => { traces.length = 0; };
  context.PbinTraceView.render = (_element, payloads) => { traces.push(...payloads); };
  return { context, requests, responses, runs, output, traces, errors };
}

(async () => {
  const bundleText = read(vendor + 'modules.json');
  const bundle = JSON.parse(bundleText);
  const provenance = JSON.parse(read(vendor + 'provenance.json'));
  assert.equal(provenance.generatedFiles['modules.json'], sha256(bundleText));
  assert.equal(provenance.generatedFiles.LICENSE, sha256(read(vendor + 'LICENSE')));
  assert.equal(provenance.upstreamModuleCount, 151);
  const sourceHashes = new Map(provenance.upstreamFiles.map(file => [file.path, file.sha256]));
  assert.equal(sourceHashes.size, 151);
  assert.equal(Object.keys(bundle.files).length, 152);
  for (const [key, source] of Object.entries(bundle.files)) {
    if (key !== entry) assert.equal(sourceHashes.get('dist/esm/' + key.slice(prefix.length)), sha256(source));
    assert.doesNotMatch(source, /\b(?:import|require)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/);
    const mod = new vm.SourceTextModule(source, { identifier: key });
    for (const spec of mod.dependencySpecifiers) {
      assert.ok(spec.startsWith('.') || spec.startsWith(prefix), 'no external/bare dependency in bundled graph');
      const resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(key), spec)) : spec;
      assert.equal(typeof bundle.files[resolved], 'string', `missing transitive module: ${resolved}`);
    }
  }
  assert.ok(!Object.keys(bundle.files).some(key => /Arbitrary|fast-check/.test(key)));

  const wasm = await WebAssembly.compile(fs.readFileSync(path.join(root, 'wordpress/pbin/static/wasm/quickjs/qjs-wasi.wasm')));
  const h = await harness(wasm);
  const javascript = h.context.window.PbinEffectTracing.javascript;
  const typescript = h.context.window.PbinEffectTracing.typescript;
  assert.equal(typescript.replace(/: (?:string|number)\b/g, ''), javascript);
  assert.deepEqual(Array.from(h.context.moduleSpecifiers(javascript)), ['pbin/effect@3.12.0', 'pbin/effect-tracing']);
  for (let run = 0; run < 2; run++) {
    await h.context.window.runCode(() => javascript, 'javascript');
    assert.match(h.output.innerHTML, /total: 45/);
    assert.doesNotMatch(h.output.innerHTML, /Execution Error|Exit code:|Stderr:/);
    assert.equal(h.errors.length, 0);
    assert.deepEqual(Array.from(h.runs[run].args), ['qjs', '-m', '/pbin-main']);
    assert.equal(h.runs[run].fs['/pbin-globals'].content, read('wordpress/pbin/static/js/qjs-web-globals.js'));
    assert.equal(h.traces.length, 1);
    const spans = h.traces[0].spans;
    assert.equal(spans.length, 13);
    const parent = spans.find(span => span.name === 'process-order');
    assert.ok(parent && parent.parentSpanId === null);
    for (const sku of ['SKU-1001', 'SKU-1002', 'SKU-1003']) {
      const fetch = spans.find(span => span.name === 'fetch-price ' + sku);
      assert.equal(fetch.parentSpanId, parent.spanId);
      for (const action of ['lookup', 'score']) {
        assert.equal(spans.find(span => span.name === action + ' ' + sku).parentSpanId, fetch.spanId);
      }
    }
    const failures = spans.filter(span => span.name === 'reserve-stock');
    assert.equal(failures.length, 2);
    for (const span of failures) {
      assert.equal(span.parentSpanId, parent.spanId);
      assert.equal(span.status.code, 2);
      assert.match(span.status.message, /inventory service unavailable/);
    }
  }
  assert.equal(h.requests.filter(url => url === asset).length, 1, 're-runs reuse the first-party bundle');
  assert.ok(h.requests.every(url => url.startsWith('/static/')), 'starter must not fetch any CDN module');

  const missing = await harness(wasm);
  const incomplete = JSON.parse(bundleText);
  delete incomplete.files[prefix + 'internal/core.js'];
  missing.responses.set(asset, JSON.stringify(incomplete));
  await missing.context.window.runCode(() => javascript, 'javascript');
  assert.match(missing.output.innerHTML, /Exit code: [1-9]/);
  assert.match(missing.output.innerHTML, /core\.js/);
  assert.doesNotMatch(missing.output.innerHTML, /total: 45/);

  const retry = await harness(wasm);
  retry.responses.set(asset, 500);
  await assert.rejects(retry.context.getBundledEffectModules(), /HTTP 500/);
  retry.responses.delete(asset);
  await retry.context.getBundledEffectModules();
  assert.equal(retry.requests.filter(url => url === asset).length, 2);
  const invalid = await harness(wasm);
  invalid.responses.set(asset, JSON.stringify({ ...bundle, files: { ...bundle.files, '/program': 'bad' } }));
  await assert.rejects(invalid.context.getBundledEffectModules(), /invalid bundled Effect module path/);

  const beforeRefusal = h.requests.length;
  await assert.rejects(h.context.collectUrlModules("import 'https://example.com/evil.mjs';"), /URL imports are limited to/);
  assert.equal(h.requests.length, beforeRefusal);
  h.responses.set('https://esm.sh/transitive-test', "export * from 'https://example.com/evil.mjs';");
  await assert.rejects(h.context.collectUrlModules("import 'https://esm.sh/transitive-test';"), /URL imports are limited to/);
  h.responses.set('https://esm.sh/node-test', "import 'node:fs';");
  await assert.rejects(h.context.collectUrlModules("import 'https://esm.sh/node-test';"), /Node builtin 'node:fs'/);
  console.log('PASS: real bundled Effect + QuickJS WASM, 13 parented spans, failure/retry, provenance, missing dependencies and unchanged URL safety (socket-free, not Chromium proof)');
})().catch(error => { console.error(error); process.exitCode = 1; });
