// JavaScript/TypeScript debugger: the same panel as the Python one
// (static/js/debug.js), driven by the Babel-instrumented debug worker
// (static/js/js-debug-worker.js) instead of QuickJS. The debugger needs
// cross-origin isolation (SharedArrayBuffer), so this doubles as a check
// that the worker blocks and resumes correctly. Babel (~3 MB) comes from
// jsDelivr on the first debug run, hence the generous timeouts.
const { test, expect } = require('@playwright/test');
const { openRoom, setCode } = require('./helpers');

const PROGRAM = [
  'function add(a, b) {',
  '  const total = a + b;',
  '  return total;',
  '}',
  '',
  "console.log('before');",
  'const x = add(2, 3);',
  "console.log('x =', x);",
].join('\n');

function varRow(page, name) {
  return page
    .locator('#pbDbgVars .pb-debug-var')
    .filter({ has: page.locator('.pb-debug-var-name', { hasText: new RegExp('^' + name + '$') }) });
}

test('breakpoint pauses a JavaScript run, inspects, watches, edits a variable, steps and resumes', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, PROGRAM);

  // The debug tab is available on JavaScript pastes too; a breakpoint
  // inside add() plus Run in debugger mode pauses there.
  await expect(page.locator('#paneTabDebug')).toBeVisible();
  await page.evaluate(() => {
    window.PbinDebug.toggleBreakpoint(2);
    window.PbinDebug.setRunMode('debug');
  });
  await expect(page.locator('.pb-bp')).toHaveCount(1);

  await page.click('#runButton');

  // Paused at the breakpoint; prints before the pause already streamed.
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 2', { timeout: 180_000 });
  await expect(page.locator('#pbDebug')).toBeVisible();
  await expect(page.locator('#output')).toContainText('before');

  // The paused frame's variables and stack.
  await expect(page.locator('#pbDbgFrames')).toContainText('add');
  await expect(varRow(page, 'a')).toContainText('2');
  await expect(varRow(page, 'b')).toContainText('3');

  // A watch expression evaluates in the paused frame and is editable in
  // place.
  await page.fill('#pbDbgWatchInput', 'a * 100');
  await page.press('#pbDbgWatchInput', 'Enter');
  await expect(page.locator('#pbDbgWatches')).toContainText('200');
  await page.locator('#pbDbgWatches .pb-debug-var-name').first().click();
  await page.fill('#pbDbgWatches .pb-debug-var-edit', 'a * b');
  await page.press('#pbDbgWatches .pb-debug-var-edit', 'Enter');
  await expect(page.locator('#pbDbgWatches')).toContainText('6');

  // Evaluate an expression in the paused frame.
  await page.fill('#pbDbgEvalInput', 'a * 10 + b');
  await page.press('#pbDbgEvalInput', 'Enter');
  await expect(page.locator('#pbDbgEvalLog')).toContainText('23');

  // Rewrite a variable by clicking its value: a = 40, the watch follows.
  await varRow(page, 'a').locator('.pb-debug-var-value').click();
  await page.fill('.pb-debug-var-edit', '40');
  await page.press('.pb-debug-var-edit', 'Enter');
  await expect(varRow(page, 'a')).toContainText('40');
  await expect(page.locator('#pbDbgWatches')).toContainText('120');

  // Step over: total picks up the rewritten value.
  await page.click('#pbDbgOver');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3', { timeout: 30_000 });
  await expect(varRow(page, 'total')).toContainText('43');

  // Continue to the end; the final print reflects the edit.
  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('x = 43', { timeout: 60_000 });
});

test('conditional breakpoint pauses only when the condition holds', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, [
    'let hits = 0;',
    'for (let i = 0; i < 20; i++) {',
    '  hits = hits + 1;',
    '}',
    "console.log('hits', hits);",
  ].join('\n'));

  await page.evaluate(() => {
    window.PbinDebug.toggleBreakpoint(3, 'i === 7');
    window.PbinDebug.setRunMode('debug');
  });
  await page.click('#runButton');

  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3', { timeout: 180_000 });
  await expect(varRow(page, 'i')).toContainText('7');
  await expect(varRow(page, 'hits')).toContainText('7');

  // The condition holds only once; continuing runs to the end.
  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('hits 20', { timeout: 60_000 });
});

test('debugger mode with no breakpoints pauses on the first line, and history steps back', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, [
    'const a = 1;',
    'const b = a + 1;',
    "console.log('b =', b);",
  ].join('\n'));

  await page.evaluate(() => { window.PbinDebug.setRunMode('debug'); });
  await page.click('#runButton');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 1', { timeout: 180_000 });

  // Two steps forward, then browse the recorded history backwards.
  await page.click('#pbDbgOver');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 2', { timeout: 30_000 });
  await page.click('#pbDbgOver');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3', { timeout: 30_000 });

  await page.click('#pbDbgBack');
  await expect(page.locator('#pbDebugStatus')).toContainText('history', { timeout: 30_000 });
  await expect(page.locator('#pbDebugStatus')).toContainText('read-only');
  await page.click('#pbDbgFwd');

  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('b = 2', { timeout: 60_000 });
});

test('an expanded object stays expanded across a continue', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, [
    'for (let i = 0; i < 3; i++) {',
    '  const d = { a: i, b: i * 10 };',
    '  console.log(i);',
    '}',
    "console.log('done');",
  ].join('\n'));

  await page.evaluate(() => {
    window.PbinDebug.toggleBreakpoint(3);
    window.PbinDebug.setRunMode('debug');
  });
  await page.click('#runButton');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3', { timeout: 180_000 });

  const dRow = page.locator('#pbDbgVars .pb-debug-var').filter({
    has: page.locator('.pb-debug-var-name', { hasText: /^d$/ }),
  });
  await dRow.locator('.pb-debug-twisty.is-toggle').click();
  await expect(page.locator('#pbDbgVars')).toContainText('a');
  await expect(page.locator('#pbDbgVars')).toContainText('b');

  // Continue to the next iteration; the tree reopens on its own.
  await page.click('#pbDbgContinue');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3', { timeout: 30_000 });
  const bRow = page.locator('#pbDbgVars .pb-debug-var').filter({
    has: page.locator('.pb-debug-var-name', { hasText: /^b$/ }),
  });
  await expect(bRow).toContainText('10');
  await expect(dRow.locator('.pb-debug-twisty')).toHaveText('▾');

  await page.click('#pbDbgStop');
});

test('pause on exceptions stops at the throw site with the stack live', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, [
    'function boom(x) {',
    '  return x.pop();',  // TypeError: cannot read properties of undefined
    '}',
    'function run() {',
    '  return boom(undefined);',
    '}',
    "console.log('start');",
    'run();',
  ].join('\n'));

  await page.evaluate(() => {
    window.PbinDebug.setRunMode('debug');
    window.PbinDebug.setPauseOnException(true);
  });
  await expect(page.locator('#pbDbgPauseExc')).toBeChecked();
  await page.click('#runButton');

  // Pauses at the throw site (line 2, inside boom), stack still live.
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 2', { timeout: 180_000 });
  await expect(page.locator('#pbDebug')).toContainText('Exception');
  await expect(page.locator('#pbDbgFrames')).toContainText('boom');
  await expect(page.locator('#pbDbgFrames')).toContainText('run');
  const xRow = page.locator('#pbDbgVars .pb-debug-var').filter({
    has: page.locator('.pb-debug-var-name', { hasText: /^x$/ }),
  });
  await expect(xRow).toContainText('undefined');

  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('TypeError', { timeout: 60_000 });
});

test('the pause-on-exception toggle persists per paste', async ({ page }) => {
  const url = await openRoom(page, 'javascript');
  await page.evaluate(() => window.PbinDebug.setPauseOnException(true));
  await expect(page.locator('#pbDbgPauseExc')).toBeChecked();
  // Reload: the choice is remembered (localStorage, like breakpoints).
  await page.goto(url);
  await expect(page.locator('#pbDbgPauseExc')).toBeChecked({ timeout: 30_000 });
});

test('a TypeScript paste runs under the debugger with its types stripped', async ({ page }) => {
  await openRoom(page, 'typescript');
  // The idle debug UI is offered on TypeScript pastes: the debug tab and
  // the Run caret (the run-mode toggle) are both visible.
  await expect(page.locator('#paneTabDebug')).toBeVisible();
  await expect(page.locator('#runMenuButton')).toBeVisible();
  await setCode(page, [
    'interface Point { x: number; y: number }',
    'function mag(p: Point): number {',
    '  const m = Math.sqrt(p.x * p.x + p.y * p.y);',
    '  return m;',
    '}',
    'const p: Point = { x: 3, y: 4 };',
    "console.log('mag', mag(p));",
  ].join('\n'));

  await page.evaluate(() => {
    window.PbinDebug.toggleBreakpoint(4);
    window.PbinDebug.setRunMode('debug');
  });
  await page.click('#runButton');

  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 4', { timeout: 180_000 });
  await expect(varRow(page, 'm')).toContainText('5');

  // The frame's eval thunk sees the typed parameter as a plain object.
  await page.fill('#pbDbgEvalInput', 'p.x + p.y');
  await page.press('#pbDbgEvalInput', 'Enter');
  await expect(page.locator('#pbDbgEvalLog')).toContainText('7');

  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('mag 5', { timeout: 60_000 });
});
