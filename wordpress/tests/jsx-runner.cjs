// Socket-free runner contract. Babel/React are doubles here; the unchanged
// runners.spec.js JSX cases exercise the real CDN compiler and React in Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

(async () => {
  const template = read('wordpress/pbin/templates/paste.php');
  const babelUrl = template.match(/<script src="([^"]+@babel\/standalone[^\"]*)"/)[1];
  assert.match(babelUrl, /@babel\/standalone@\d+\.\d+\.\d+\/babel\.min\.js$/,
    'the JSX compiler must use an exact version, not a moving CDN default');
  const workerUrl = read('wordpress/pbin/static/js/js-debug-worker.js')
    .match(/const BABEL_URL = '([^']+)'/)[1];
  assert.equal(babelUrl, workerUrl, 'keep the page and debug worker on the same pinned Babel');

  const context = vm.createContext({ window: {}, console: { error() {} }, performance: { now: () => 1 } });
  vm.runInContext(read('wordpress/pbin/static/js/code-runner.js'), context);
  const output = { innerHTML: '' };
  const reactRoot = { textContent: '' };
  const runButton = { disabled: true };
  const cancelButton = { classList: { add(name) { assert.equal(name, 'hidden'); } } };
  const metrics = { textContent: '' };
  context.document = {
    getElementById(id) {
      return { 'react-root': reactRoot, runButton, cancelButton, outputMetrics: metrics }[id] || null;
    },
    createElement() {
      return {
        textContent: '',
        get innerHTML() { return this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); },
      };
    },
  };
  context.React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type(props || {});
      return children.flat().join('');
    },
    useState: initial => [initial, () => {}],
    Fragment: Symbol('fragment'),
  };
  context.ReactDOM = { render: (element, target) => { target.textContent = element; } };

  let compiled, options;
  context.Babel = {
    transform(code, opts) {
      options = opts;
      // Model the incompatible automatic-runtime output so this test fails
      // even if the CDN pin masks an accidental removal of the explicit option.
      if (opts.presets[0][1]?.runtime !== 'classic') {
        return { code: 'import { jsx } from "react/jsx-runtime";' };
      }
      return { code: compiled };
    },
  };
  async function run(js) {
    compiled = js;
    reactRoot.textContent = '';
    runButton.disabled = true;
    vm.runInContext('executionState.isRunning = true', context);
    await context.window.runReactCode('<App />', output);
    assert.equal(options.filename, 'component.jsx');
    assert.equal(options.presets[0][0], 'react');
    assert.equal(options.presets[0][1].runtime, 'classic');
    assert.equal(runButton.disabled, false);
    assert.equal(vm.runInContext('executionState.isRunning', context), false);
  }

  await run('function App() { return React.createElement("h1", null, "Hello, World!"); }');
  assert.equal(reactRoot.textContent, 'Hello, World!');
  assert.match(metrics.textContent, /Render:/);
  await run('function App() { const [n] = React.useState(41); return React.createElement("p", null, "count is ", n + 1); }');
  assert.equal(reactRoot.textContent, 'count is 42', 'a second run uses the supplied React global');
  await run('function Component() { return React.createElement(React.Fragment, null, "one", "two"); }');
  assert.equal(reactRoot.textContent, 'onetwo');
  await run('ReactDOM.render(React.createElement("p", null, "direct"), rootElement);');
  assert.equal(reactRoot.textContent, 'direct');
  await run('function App() { return oops.y; }');
  assert.match(output.innerHTML, /Render Error:[\s\S]*oops/);
  await run('function App() { return React.createElement("p", null, "recovered"); }');
  assert.equal(reactRoot.textContent, 'recovered', 'a failed run must not prevent the next run');
  console.log('PASS: JSX classic-runtime contract, compiler pin, render paths, repeated runs and error recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });
