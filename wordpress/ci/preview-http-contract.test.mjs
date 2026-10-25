// Disposable real-WordPress MU-loader, immutable assets, data, upgrade/rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../..');
const work = process.env.PBIN_WP_FIXTURE;
const base = process.env.PBIN_ACCEPTANCE_URL;
assert.ok(work && path.basename(work).startsWith('pbin-wp-ci.'));
assert.equal(new URL(base).hostname, '127.0.0.1');
const fixture = JSON.parse(fs.readFileSync(path.join(work, 'previews.json'), 'utf8'));
assert.equal(fixture.root, path.join(work, 'previews'));
const mount = n => `/previews/pr-${n}`;
const request = (route, options = {}) => fetch(new URL(route, base), { redirect: 'manual', ...options });
const form = data => new URLSearchParams(data);
function registry(...args) {
  return JSON.parse(execFileSync('python3', [path.join(root, 'wordpress/tools/preview_registry.py'), '--root', fixture.root, ...args], {encoding: 'utf8'}));
}
async function health(n, revision) {
  const r = await request(mount(n) + '/health');
  assert.equal(r.status, 200); assert.equal(await r.text(), 'OK');
  assert.equal(r.headers.get('x-pbin-instance'), `pr_${n}`);
  assert.equal(r.headers.get('x-pbin-revision'), revision);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  return r;
}
async function create(n, text) {
  const r = await request(mount(n) + '/paste', {method: 'POST', body: form({text, lang: 'javascript'})});
  assert.equal(r.status, 301);
  const location = r.headers.get('location');
  assert.ok(location.startsWith(mount(n) + '/paste?'));
  return new URL(location, base).searchParams.get('id');
}
const raw = (n, id) => request(mount(n) + '/paste?id=' + id + '.txt');

test('two real HTTP previews interleave, upgrade one, and roll back without cross-talk', async () => {
  await health(fixture.a, fixture.revision);
  await health(fixture.b, fixture.revision);
  const a = await create(fixture.a, 'A original λ 😀');
  const b = await create(fixture.b, 'B unchanged λ 😀');
  const snapshotResponse = await request(mount(fixture.a) + '/snapshot', {
    method: 'POST', headers: {Accept: 'application/json'}, body: form({id: a, name: 'A saved checkpoint'}),
  });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.ok(snapshot.url.startsWith(mount(fixture.a) + '/snapshot?'));
  const update = await request(mount(fixture.a) + '/paste', {
    method: 'PUT', body: form({id: a, text: 'A updated', lang: 'python', title: 'A title'}),
  });
  assert.equal(update.status, 200);
  assert.equal(await (await raw(fixture.a, a)).text(), 'A updated');
  assert.equal(await (await raw(fixture.b, b)).text(), 'B unchanged λ 😀');
  assert.equal(await (await request(snapshot.url + '.txt')).text(), 'A original λ 😀');
  const crossPaste = await raw(fixture.b, a);
  assert.equal(crossPaste.status, 404, 'other tenant paste ID must be denied');
  assert.equal((await request(mount(fixture.b) + '/snapshot?id=' + snapshot.id)).status, 404);
  const html = await (await request(mount(fixture.a) + '/paste?id=' + a)).text();
  const assetPath = mount(fixture.a) + '/_releases/' + fixture.revision + '/static/css/app.css';
  assert.ok(html.includes(assetPath), 'rendered URLs must pin release assets');
  const assetResponse = await request(assetPath);
  assert.match(assetResponse.headers.get('cache-control'), /immutable/);
  const originalCSS = await assetResponse.text();
  assert.ok(originalCSS.length > 1000);
  assert.equal((await request(mount(fixture.a) + '/static/css/app.css')).status, 404);

  registry('install', '--pr', String(fixture.a), '--artifact', fixture.upgrade_artifact,
    '--sha256', fixture.upgrade_sha256, '--revision', fixture.upgrade_revision, '--expected-active', fixture.revision);
  const upgraded = await health(fixture.a, fixture.upgrade_revision);
  assert.equal(upgraded.headers.get('x-pbin-ci-fixture'), 'upgraded');
  const unchanged = await health(fixture.b, fixture.revision);
  assert.equal(unchanged.headers.get('x-pbin-ci-fixture'), null);
  assert.equal(await (await raw(fixture.a, a)).text(), 'A updated');
  assert.equal(await (await raw(fixture.b, b)).text(), 'B unchanged λ 😀');
  assert.equal(await (await request(assetPath)).text(), originalCSS, 'old asset URL must keep old bytes');
  const upgradedCSS = await (await request(assetPath.replace(fixture.revision, fixture.upgrade_revision))).text();
  assert.notEqual(upgradedCSS, originalCSS, 'upgrade fixture must have observably different asset bytes');
  assert.ok(upgradedCSS.includes('Synthetic CI upgrade'));
  const updatedHtml = await (await request(mount(fixture.a) + '/paste?id=' + a)).text();
  assert.ok(updatedHtml.includes('/_releases/' + fixture.upgrade_revision + '/static/'));

  registry('rollback', '--pr', String(fixture.a), '--revision', fixture.revision, '--expected-active', fixture.upgrade_revision);
  const rolledBack = await health(fixture.a, fixture.revision);
  assert.equal(rolledBack.headers.get('x-pbin-ci-fixture'), null);
  await health(fixture.b, fixture.revision);
  assert.equal(await (await raw(fixture.a, a)).text(), 'A updated');
  assert.equal(await (await raw(fixture.b, b)).text(), 'B unchanged λ 😀');
  assert.equal((await request('/previews/pr-999999/health')).status, 404);
  const normal = await request('/health');
  assert.equal(normal.status, 200); assert.equal(normal.headers.get('x-pbin-instance'), null);
  for (const route of ['/wp-admin/', '/wp-login.php', '/wp-json/']) {
    const response = await request(route);
    assert.equal(response.headers.get('x-pbin-instance'), null, route);
    assert.equal(response.headers.get('x-pbin-ci-fixture'), null, route);
  }
});
