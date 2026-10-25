// Socket-free import-graph contract. These CDN responses are deliberately
// doubles, not vendored Effect or a browser/runtime result. The unchanged
// url-imports.spec.js assertions exercise real Effect, QuickJS and its traces.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const effectRoot = 'https://esm.sh/effect@3.12.0';
const names = ['Effect', 'Tracer', 'Layer', 'Cause'];
const imports = names.map(name => `${effectRoot}/${name}?target=es2022`);
const shared = `${effectRoot}/es2022/shared.mjs`;
const arbitrary = `${effectRoot}/es2022/Arbitrary.mjs`;

function harness() {
  const responses = new Map();
  const requests = [];
  for (const name of names) {
    responses.set(`${effectRoot}/${name}?target=es2022`,
      `export * from '/effect@3.12.0/es2022/${name}.mjs';`);
    responses.set(`${effectRoot}/es2022/${name}.mjs`,
      `import './shared.mjs'; export const fixture = true;`);
  }
  responses.set(shared, 'export const fixture = true;');
  // Model the observed failure: the umbrella re-export eagerly reaches an
  // unrelated Arbitrary module whose CDN build returns HTTP 500.
  responses.set(`${effectRoot}?bundle`,
    `export * from '/effect@3.12.0/es2022/Arbitrary.mjs';`);
  responses.set(arbitrary, 500);
  const context = vm.createContext({ window: {}, URL, fetch: async url => {
    requests.push(url);
    assert.ok(responses.has(url), `unexpected network dependency: ${url}`);
    const body = responses.get(url);
    return typeof body === 'number'
      ? { ok: false, status: body }
      : { ok: true, text: async () => body };
  } });
  vm.runInContext(read('wordpress/pbin/static/js/hello-world.js'), context);
  vm.runInContext(read('wordpress/pbin/static/js/code-runner.js'), context);
  return { context, responses, requests };
}

(async () => {
  for (const language of ['javascript', 'typescript']) {
    const { context, requests } = harness();
    const code = context.window.PbinEffectTracing[language];
    const files = await context.collectUrlModules(code);
    assert.deepEqual(Array.from(context.moduleSpecifiers(code)),
      [...imports, 'pbin/effect-tracing'], `${language} must import only public Effect subpaths`);
    assert.equal(Object.keys(files).length, 9);
    assert.equal(requests.filter(url => url === shared).length, 1,
      'all four entrypoints must share one transitive module identity');
    assert.ok(!requests.includes(arbitrary), 'unrelated umbrella exports must not be fetched');
    assert.ok(!requests.includes(`${effectRoot}?bundle`));
    const firstRequestCount = requests.length;
    await context.collectUrlModules(code);
    assert.equal(requests.length, firstRequestCount, 're-running uses the page cache');
    assert.match(code, /makeEffectTracing\(\{ Tracer, Layer, Cause \}\)/);
    assert.match(code, /Effect\.provide\(TracingLive\)/);
    assert.match(code, /concurrency: 3/);
    assert.match(code, /Effect\.retry\(\{ times: 1 \}\)/);
    assert.match(code, /Effect\.catchAll\(\(\) => Effect\.void\)/);
  }

  const { context, responses, requests } = harness();
  const javascript = context.window.PbinEffectTracing.javascript;
  const typescript = context.window.PbinEffectTracing.typescript;
  assert.equal(typescript.replace(/: (?:string|number)\b/g, ''), javascript,
    'both starter programs retain identical behavior apart from type annotations');

  await assert.rejects(context.collectUrlModules(
    `import { Effect } from '${effectRoot}?bundle';`), /Arbitrary\.mjs failed: HTTP 500/,
  'the fixture must reproduce the old umbrella-import failure');

  // A broken *required* dependency is still fatal, not skipped or swallowed.
  responses.set(shared, 500);
  await assert.rejects(context.collectUrlModules(javascript), /shared\.mjs failed: HTTP 500/);
  responses.set(shared, 'export const recovered = true;');
  await context.collectUrlModules(javascript);
  assert.equal(requests.filter(url => url === shared).length, 2,
    'a failed required fetch is evicted so a later run may retry');

  const beforeRefusal = requests.length;
  await assert.rejects(context.collectUrlModules(
    "import 'https://example.com/evil.mjs';"), /URL imports are limited to/);
  assert.equal(requests.length, beforeRefusal, 'disallowed roots are refused before fetch');
  responses.set('https://esm.sh/transitive-test',
    "export * from 'https://example.com/evil.mjs';");
  await assert.rejects(context.collectUrlModules(
    "import 'https://esm.sh/transitive-test';"), /URL imports are limited to/);
  assert.ok(!requests.includes('https://example.com/evil.mjs'));
  responses.set('https://esm.sh/node-test', "import 'node:fs';");
  await assert.rejects(context.collectUrlModules(
    "import 'https://esm.sh/node-test';"), /Node builtin 'node:fs'/);

  console.log('PASS: JS/TS Effect subpath graph, shared identity, cache/retry and import-safety contracts (CDN doubles, not browser proof)');
})().catch(error => { console.error(error); process.exitCode = 1; });
