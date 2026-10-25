// Run only in the disposable fixture configured with the canonical /paste mount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const base = process.env.PBIN_ACCEPTANCE_URL;
assert.equal(new URL(base).hostname, '127.0.0.1', 'never test writes against a public site');
assert.equal(process.env.PBIN_TEST_BASE_PATH, '/paste');
const request = (route, options = {}) => fetch(new URL(route, base), { redirect: 'manual', ...options });
const form = data => new URLSearchParams(data);

test('canonical /paste creates, edits and snapshots without /paste/paste or external redirects', async () => {
  const created = await request('/paste?lang=lean');
  assert.equal(created.status, 303);
  const location = created.headers.get('location');
  assert.match(location, /^\/paste\?id=[a-f0-9-]+$/);
  const id = new URL(location, base).searchParams.get('id');
  let response = await request(location);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="language" value="lean"/);
  assert.ok(html.includes('/paste/static/js/code-runner.js'));
  assert.ok(!html.includes('/paste/paste'), 'generated editor URLs must be canonical');
  response = await request('/paste', {method: 'PUT', body: form({id, text: 'canonical λ 😀', lang: 'go', title: 'Canonical route'})});
  assert.equal(response.status, 200);
  response = await request(`/paste?id=${id}.txt`);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'canonical λ 😀');
  response = await request(`/pbin-wp-test/paste?id=${id}.txt`);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'canonical λ 😀');
  response = await request('/paste/snapshot', {method: 'POST', headers: {Accept: 'application/json'}, body: form({id, name: 'canonical checkpoint'})});
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.match(snapshot.url, /^\/paste\/snapshot\?id=/);
  assert.equal(await (await request(snapshot.url + '.txt')).text(), 'canonical λ 😀');
  response = await request(`/pbin-wp-test/snapshot?id=${snapshot.id}.txt`);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'canonical λ 😀');
  response = await request(`/paste/snapshots?id=${id}`);
  assert.equal(response.status, 200); assert.ok((await response.text()).includes(snapshot.id));
  response = await request('/paste', {method: 'POST', body: form({text: 'POST canonical', lang: 'text'})});
  assert.equal(response.status, 301); assert.match(response.headers.get('location'), /^\/paste\?id=/);
  const head = await request('/paste', {method: 'HEAD'});
  assert.equal(head.status, 200); assert.equal(head.headers.get('location'), null);
});

test('canonical mount leaves normal WordPress pages, login and query REST API intact', async () => {
  const home = await request('/');
  assert.equal(home.status, 200); assert.equal(home.headers.get('location'), null);
  assert.equal(home.headers.get('cross-origin-embedder-policy'), null);
  const login = await request('/wp-login.php');
  assert.equal(login.status, 200); assert.ok((await login.text()).includes('loginform'));
  const rest = await request('/?rest_route=/');
  assert.equal(rest.status, 200); assert.ok(Array.isArray((await rest.json()).namespaces));
  const health = await request('/paste/health');
  assert.equal(health.status, 200); assert.equal(await health.text(), 'OK');
  assert.equal((await request('/pbin-wp-test/health')).status, 200);
});
