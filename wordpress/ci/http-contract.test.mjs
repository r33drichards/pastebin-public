// Supplement, rather than rewrite, the upstream black-box HTTP contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.PBIN_ACCEPTANCE_URL;
if (!base) throw new Error('PBIN_ACCEPTANCE_URL is required');
const request = (path, options = {}) => fetch(new URL(path, base), { redirect: 'manual', ...options });

test('packaged assets retain MIME, isolation and no traversal', async () => {
  for (const [path, mime] of [
    ['/static/js/code-runner.js', /javascript/],
    ['/static/js/pyodide-worker.js', /javascript/],
    ['/static/css/app.css', /text\/css/],
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), mime, path);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await request('/static/not-present.wasm')).status, 404);
  // Encode the slash too: URL() normalizes an encoded '..' segment followed
  // by a literal slash before fetch can send it. Target existing non-static JS
  // so the containment guard, not just an extension filter, must reject it.
  const traversal = '/static/%2e%2e%2ftools/single-user-editor.js';
  assert.equal(new URL(traversal, base).pathname, traversal);
  assert.equal((await request(traversal)).status, 404);
});

test('unsupported API methods retain the legacy redirect contract without mutating documents', async () => {
  const created = await request('/paste', { method: 'POST', body: new URLSearchParams({text: 'retain me', lang: 'text'}) });
  const location = created.headers.get('location');
  const id = new URL(location, base).searchParams.get('id');
  for (const path of ['/paste', '/snapshot', '/diff']) {
    const response = await request(path + '?id=' + id, { method: 'DELETE' });
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get('location'), '/');
  }
  assert.equal(await (await request(location + '.txt')).text(), 'retain me');
});

test('single-user mode needs no collaboration endpoint and preserves Go as a language', async () => {
  assert.equal((await request('/collab')).status, 501);
  const created = await request('/?lang=go');
  assert.equal(created.status, 303);
  const page = await request(created.headers.get('location'));
  const html = await page.text();
  assert.match(html, /id="saveStatus"/);
  assert.doesNotMatch(html, /<script[^>]+src=["'][^"']*collab\.js/);
  // A retained language choice is not a claim that its runner is complete.
  assert.match(html, /value="go"/);
});
