'use strict';

// Same-origin VM contexts deliberately share one Storage object, like two tabs.
// This is functional namespacing, not an origin/security boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plugin = path.resolve(__dirname, '../pbin');
const source = fs.readFileSync(path.join(plugin, 'static/js/storage.js'), 'utf8');
const values = new Map();
const localStorage = {
  getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  setItem(key, value) { values.set(String(key), String(value)); },
  removeItem(key) { values.delete(String(key)); }
};
function tab(prefix) {
  const window = { localStorage };
  if (prefix !== undefined) window.pbinStoragePrefix = prefix;
  const context = vm.createContext({ window });
  vm.runInContext(source, context, { filename: 'storage.js' });
  assert(Object.isFrozen(window.pbinStorage));
  return window;
}

const production = tab();
const explicitProduction = tab('');
const a = tab('pbin:pr_101:');
const b = tab('pbin:pr_202:');
const keys = [
  'pbin-theme', 'wordWrapEnabled', 'pbin-clock', 'pbin-ai-completions',
  'pbin-autorun', 'pbin-split', 'pbin-groups', 'pbin-stdin-same-paste-id',
  'pbin-breakpoints-same-paste-id'
];
for (const key of keys) {
  localStorage.setItem(key, `legacy:${key}`);
  assert.equal(production.pbinStorage.getItem(key), `legacy:${key}`);
  assert.equal(explicitProduction.pbinStorage.getItem(key), `legacy:${key}`);
  assert.equal(a.pbinStorage.getItem(key), null);
  assert.equal(b.pbinStorage.getItem(key), null);
  a.pbinStorage.setItem(key, `a:${key}`);
  b.pbinStorage.setItem(key, `b:${key}`);
  assert.equal(a.pbinStorage.getItem(key), `a:${key}`);
  assert.equal(b.pbinStorage.getItem(key), `b:${key}`);
  assert.equal(production.pbinStorage.getItem(key), `legacy:${key}`);
  assert.equal(tab('pbin:pr_101:').pbinStorage.getItem(key), `a:${key}`);
  a.pbinStorage.removeItem(key);
  assert.equal(a.pbinStorage.getItem(key), null);
  assert.equal(b.pbinStorage.getItem(key), `b:${key}`);
  assert.equal(production.pbinStorage.getItem(key), `legacy:${key}`);
}
production.pbinStorage.setItem('production-write', false);
assert.equal(localStorage.getItem('production-write'), 'false');
assert.equal(explicitProduction.pbinStorage.getItem('production-write'), 'false');
production.pbinStorage.removeItem('production-write');
assert.equal(localStorage.getItem('production-write'), null);
a.pbinStorage.setItem('coercion', 42);
assert.equal(a.pbinStorage.getItem('coercion'), '42');
assert.equal(localStorage.getItem('coercion'), null);
// A later mutation of the global prefix must not change a tab's captured scope.
a.pbinStoragePrefix = 'pbin:pr_202:';
a.pbinStorage.setItem('captured-prefix', 'a');
assert.equal(b.pbinStorage.getItem('captured-prefix'), null);
assert.equal(localStorage.getItem('pbin:pr_101:captured-prefix'), 'a');

// Fail if a first-party template/script bypasses the storage adapter.
const firstParty = [
  ...fs.readdirSync(path.join(plugin, 'templates')).filter(f => f.endsWith('.php')).map(f => path.join(plugin, 'templates', f)),
  ...fs.readdirSync(path.join(plugin, 'static/js')).filter(f => /\.(?:js|mjs)$/.test(f) && f !== 'storage.js').map(f => path.join(plugin, 'static/js', f))
];
for (const file of firstParty) {
  const text = fs.readFileSync(file, 'utf8');
  assert(!/\blocalStorage\s*(?:\.|\[)/.test(text), `${file} bypasses tenant storage`);
  if (file.endsWith('.php')) {
    const prefix = text.indexOf('window.pbinStoragePrefix');
    const adapter = text.indexOf('/static/js/storage.js');
    const theme = text.indexOf('js/theme.js');
    assert(prefix >= 0 && adapter > prefix && theme > adapter, `${file} must set scope/load storage before theme`);
  }
}

console.log(`PASS: shared-localStorage A/B isolation, persistence, deletion, prefix capture, ${keys.length} preference keys, production legacy compatibility, ${firstParty.length} first-party source checks`);
console.log('Scope: Node VM/Storage mock; not a browser end-to-end or security-isolation test.');
