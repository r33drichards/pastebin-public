// Disposable real-WordPress MU-loader, immutable assets, data, upgrade/rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
function rejectStale(...args) {
  const result = spawnSync('python3', [path.join(root, 'wordpress/tools/preview_registry.py'), '--root', fixture.root, ...args], {encoding: 'utf8'});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Tenant state changed/);
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

  const installed = registry('install', '--pr', String(fixture.a), '--artifact', fixture.upgrade_artifact,
    '--sha256', fixture.upgrade_sha256, '--revision', fixture.upgrade_revision, '--expected-token', fixture.a_token);
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

  const reverted = registry('rollback', '--pr', String(fixture.a), '--revision', fixture.revision, '--expected-token', installed.state_token);
  assert.notEqual(reverted.state_token, fixture.a_token, 'A -> B -> A must not restore an old state token');
  const rolledBack = await health(fixture.a, fixture.revision);
  assert.equal(rolledBack.headers.get('x-pbin-ci-fixture'), null);
  await health(fixture.b, fixture.revision);
  assert.equal(await (await raw(fixture.a, a)).text(), 'A updated');
  assert.equal(await (await raw(fixture.b, b)).text(), 'B unchanged λ 😀');
  // A stale intent cannot win after ABA or after a close, even if active SHA
  // happens to match its original value. Preserve data across explicit reopening.
  const staleInstall = token => rejectStale('install', '--pr', String(fixture.a),
    '--artifact', fixture.upgrade_artifact, '--sha256', fixture.upgrade_sha256,
    '--revision', fixture.upgrade_revision, '--expected-token', token);
  staleInstall(fixture.a_token);
  const retired = registry('retire', '--pr', String(fixture.a), '--expected-token', reverted.state_token);
  assert.equal(retired.enabled, false);
  staleInstall(reverted.state_token);
  rejectStale('rollback', '--pr', String(fixture.a), '--revision', fixture.revision,
    '--expected-token', reverted.state_token);
  assert.equal((await request(mount(fixture.a) + '/health')).status, 404);
  assert.equal((await request(assetPath)).status, 404, 'disabled preview must not serve retained assets');
  await health(fixture.b, fixture.revision);
  // This is an explicit new test intent, not an automatic retry with a fresh token.
  registry('rollback', '--pr', String(fixture.a), '--revision', fixture.revision,
    '--expected-token', retired.state_token);
  await health(fixture.a, fixture.revision);
  assert.equal(await (await raw(fixture.a, a)).text(), 'A updated');
  assert.equal(await (await raw(fixture.b, b)).text(), 'B unchanged λ 😀');
  const neverInstalled = 910103;
  const tombstone = registry('retire', '--pr', String(neverInstalled), '--expected-token', 'none');
  assert.equal(tombstone.active, null);
  rejectStale('install', '--pr', String(neverInstalled), '--artifact', fixture.upgrade_artifact,
    '--sha256', fixture.upgrade_sha256, '--revision', fixture.upgrade_revision, '--expected-token', 'none');
  assert.equal((await request(mount(neverInstalled) + '/health')).status, 404);
  const state = registry('status').registry;
  assert.equal(state.version, 2);
  assert.equal(state.tenants[`pr-${fixture.b}`].state_token, fixture.b_token, 'B state must remain untouched');
  assert.equal((await request('/previews/pr-999999/health')).status, 404);
  const normal = await request('/health');
  assert.equal(normal.status, 200); assert.equal(normal.headers.get('x-pbin-instance'), null);
  for (const route of ['/wp-admin/', '/wp-login.php', '/wp-json/']) {
    const response = await request(route);
    assert.equal(response.headers.get('x-pbin-instance'), null, route);
    assert.equal(response.headers.get('x-pbin-ci-fixture'), null, route);
  }
});
