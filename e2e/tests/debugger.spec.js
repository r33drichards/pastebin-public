// Python debugger: breakpoints pause the run with stack, variables, watches,
// eval, editable variables and a step-back history. The debugger needs
// cross-origin isolation (SharedArrayBuffer); the server sets COOP/COEP on
// every response, so this doubles as a check on that.
const { test, expect } = require('@playwright/test');
const { openRoom, setCode } = require('./helpers');

const PROGRAM = [
  'def add(a, b):',
  '    total = a + b',
  '    return total',
  '',
  'print("before")',
  'x = add(2, 3)',
  'print("x =", x)',
].join('\n');

function varRow(page, name) {
  return page
    .locator('#pbDbgVars .pb-debug-var')
    .filter({ has: page.locator('.pb-debug-var-name', { hasText: new RegExp('^' + name + '$') }) });
}

test('breakpoint pauses, inspects, watches, edits a variable, steps and resumes', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await openRoom(page, 'python');
  await setCode(page, PROGRAM);

  // The debug tab is always available on a Python paste; a breakpoint inside
  // add() renders a glyph in the gutter. Switch Run to debugger mode so it
  // pauses there.
  await expect(page.locator('#paneTabDebug')).toBeVisible();
  await page.evaluate(() => {
    window.PbinPyDebug.toggleBreakpoint(2);
    window.PbinPyDebug.setRunMode('debug');
  });
  await expect(page.locator('.pb-bp')).toHaveCount(1);

  await page.click('#runButton');

  // Paused at the breakpoint: the debug tab is brought on screen; prints
  // before the pause already streamed into the (now background) output doc.
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 2', { timeout: 180_000 });
  await expect(page.locator('#pbDebug')).toBeVisible();
  await expect(page.locator('#output')).toContainText('before');

  // The paused frame's variables and stack.
  await expect(page.locator('#pbDbgFrames')).toContainText('add');
  await expect(varRow(page, 'a')).toContainText('2');
  await expect(varRow(page, 'b')).toContainText('3');

  // A watch expression evaluates in the paused frame, and is editable in
  // place: click it, retype, Enter.
  await page.fill('#pbDbgWatchInput', 'a * 100');
  await page.press('#pbDbgWatchInput', 'Enter');
  await expect(page.locator('#pbDbgWatches')).toContainText('200');
  await page.locator('#pbDbgWatches .pb-debug-var-name').first().click();
  await page.fill('#pbDbgWatches .pb-debug-var-edit', 'a * b');
  await page.press('#pbDbgWatches .pb-debug-var-edit', 'Enter');
  await expect(page.locator('#pbDbgWatches')).toContainText('6');

  // The watch value can be copied to the clipboard.
  await page.locator('#pbDbgWatches .pb-debug-copy').first().click();
  await expect(page.locator('#pbDbgWatches .pb-debug-copy.is-ok')).toHaveCount(1);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  if (clip !== null) expect(clip).toBe('6');

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
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3');
  await expect(varRow(page, 'total')).toContainText('43');

  // Step back browses the recorded history read-only, forward returns live.
  await page.click('#pbDbgBack');
  await expect(page.locator('#pbDebugStatus')).toContainText('history');
  await expect(page.locator('#pbDbgEvalInput')).toBeDisabled();
  await page.click('#pbDbgFwd');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3');

  // Continue to the end: the mutation shows up in the program's output, and
  // the debug tab drops back to the idle breakpoint list.
  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('x = 43', { timeout: 60_000 });
  await expect(page.locator('#pbDebugStatus')).toContainText('Run is set to the debugger');
});

test('conditional breakpoints pause when truthy; disabled ones are skipped', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, ['total = 0', 'for i in range(10):', '    total = total + i', 'print(total)'].join('\n'));

  await page.evaluate(() => {
    window.PbinPyDebug.toggleBreakpoint(1);
    window.PbinPyDebug.toggleBreakpoint(3, 'i == 7');
    window.PbinPyDebug.setRunMode('debug');
    window.pbinSelectTab('debug');
  });

  // The idle debug tab lists both breakpoints; disable the one at line 1.
  await expect(page.locator('#pbDebug')).toBeVisible();
  await expect(page.locator('#pbDbgBps li')).toHaveCount(2);
  await expect(page.locator('#pbDbgBps')).toContainText('when i == 7');
  await page.locator('#pbDbgBps li').first().locator('input[type=checkbox]').uncheck();

  await page.click('#runButton');

  // The first pause is the conditional one: i == 7, total = 0+1+...+6.
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3', { timeout: 180_000 });
  await expect(varRow(page, 'i')).toContainText('7');
  await expect(varRow(page, 'total')).toContainText('21');

  // The condition is true only once; continue runs to the end.
  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('45', { timeout: 60_000 });
});

test('enable/disable all and delete all breakpoints', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, ['a = 1', 'b = 2', 'c = 3', 'print(a, b, c)'].join('\n'));

  // Reveal the debugger as a split so the code editor (and its gutter) stays
  // visible next to the debug controls.
  await page.evaluate(() => {
    window.PbinPyDebug.toggleBreakpoint(1);
    window.PbinPyDebug.toggleBreakpoint(2);
    window.PbinPyDebug.toggleBreakpoint(3);
    window.pbinRevealDebug();
  });
  await expect(page.locator('#pbDbgBps li')).toHaveCount(3);
  await expect(page.locator('.pb-bp')).toHaveCount(3);

  // Disable all: every checkbox clears and the gutter dots go hollow.
  await page.click('#pbDbgBpsToggle');
  await expect(page.locator('#pbDbgBps input:checked')).toHaveCount(0);
  await expect(page.locator('.pb-bp--off')).toHaveCount(3);

  // Enable all: every checkbox and dot comes back.
  await page.click('#pbDbgBpsToggle');
  await expect(page.locator('#pbDbgBps input:checked')).toHaveCount(3);
  await expect(page.locator('.pb-bp--off')).toHaveCount(0);

  // Delete all: the list and the gutter dots are cleared.
  await page.click('#pbDbgBpsClear');
  await expect(page.locator('#pbDbgBps li.pb-debug-bp')).toHaveCount(0);
  await expect(page.locator('.pb-bp')).toHaveCount(0);
});

test('the Run-mode toggle sticks: debugger vs plain', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, ['x = 1', 'y = x + 1', 'print("done", y)'].join('\n'));

  // Pick "run in debugger" from the caret menu; the button reflects the mode.
  await expect(page.locator('#runMenuButton')).toBeVisible();
  await page.click('#runMenuButton');
  await page.click('#runMenu [data-mode="debug"]');
  await expect(page.locator('#runButtonLabel')).toHaveText('Debug');

  // Pressing Run now debugs; with no breakpoints it pauses at the first line.
  await page.click('#runButton');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 1', { timeout: 180_000 });
  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('done 2', { timeout: 60_000 });

  // The mode sticks: pressing Run again debugs without touching the menu.
  await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
  await page.click('#runButton');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 1', { timeout: 60_000 });
  await page.click('#pbDbgStop');

  // Switch back to plain run: Run ignores a breakpoint and completes.
  await page.click('#runMenuButton');
  await page.click('#runMenu [data-mode="plain"]');
  await expect(page.locator('#runButtonLabel')).toHaveText('Run');
  await page.evaluate(() => { document.getElementById('output').innerHTML = ''; window.PbinPyDebug.toggleBreakpoint(2); });
  await page.click('#runButton');
  await expect(page.locator('#output')).toContainText('done 2', { timeout: 60_000 });
});

test('complex objects expand in the variables pane', async ({ page }) => {
  await openRoom(page, 'python');
  // Attributes are class-level here (instance __dict__ stays empty) and there
  // is a method — expansion must still surface the data attributes and skip
  // the method.
  await setCode(page, [
    'class Hand:',
    '    cards = ["AS", "KD", "3D"]',
    '    rank = 7',
    '    def score(self):',
    '        return self.rank',
    'h = Hand()',
    'print("done")',
  ].join('\n'));

  await page.evaluate(() => {
    window.PbinPyDebug.toggleBreakpoint(7);
    window.PbinPyDebug.setRunMode('debug');
  });
  await page.click('#runButton');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 7', { timeout: 180_000 });

  // h is a Hand object; its repr alone is opaque, but it is expandable.
  const hRow = page.locator('#pbDbgVars .pb-debug-var').filter({
    has: page.locator('.pb-debug-var-name', { hasText: /^h$/ }),
  });
  await expect(hRow).toContainText('Hand');
  await hRow.locator('.pb-debug-twisty.is-toggle').click();

  // Its data attributes appear (cards, rank); the method is skipped.
  await expect(page.locator('#pbDbgVars')).toContainText('cards');
  await expect(page.locator('#pbDbgVars')).toContainText('rank');
  await expect(page.locator('#pbDbgVars')).not.toContainText('score');

  // The cards list expands further to its items.
  const cardsRow = page.locator('#pbDbgVars .pb-debug-var').filter({
    has: page.locator('.pb-debug-var-name', { hasText: /^cards$/ }),
  });
  await cardsRow.locator('.pb-debug-twisty.is-toggle').click();
  await expect(page.locator('#pbDbgVars')).toContainText("'AS'");
  await expect(page.locator('#pbDbgVars')).toContainText("'KD'");

  await page.click('#pbDbgStop');
});

test('an expanded value stays expanded across a continue', async ({ page }) => {
  await openRoom(page, 'python');
  // The breakpoint is hit once per loop iteration; d is a fresh dict each
  // time, so its expand ref changes, but the opened tree must stay open.
  await setCode(page, [
    'for i in range(3):',
    '    d = {"a": i, "b": i * 10}',
    '    print(i)',
    'print("done")',
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
  // First iteration (i = 0): the expanded dict shows b = 0.
  await expect(page.locator('#pbDbgVars')).toContainText("'b'");

  // Continue to the next iteration; the tree reopens on its own (no click),
  // now showing the new value b = 10 — which only appears if the children
  // were re-fetched automatically.
  await page.click('#pbDbgContinue');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 3', { timeout: 30_000 });
  // The disclosure stays open (▾), without re-clicking.
  await expect(dRow.locator('.pb-debug-twisty')).toHaveText('▾');
  await expect(page.locator('#pbDbgVars')).toContainText('10');

  await page.click('#pbDbgStop');
});

test('pause on exceptions stops at the raise site with the stack live', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, [
    'def boom(x):',
    '    return x.pop()',  // AttributeError: 'NoneType' has no 'pop'
    '',
    'def run():',
    '    return boom(None)',
    '',
    'print("start")',
    'run()',
  ].join('\n'));

  // No breakpoints — just the exception toggle.
  await page.evaluate(() => {
    window.PbinDebug.setRunMode('debug');
    window.PbinDebug.setPauseOnException(true);
  });
  await expect(page.locator('#pbDbgPauseExc')).toBeChecked();
  await page.click('#runButton');

  // Pauses at the raise site (line 2, inside boom), not at entry.
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 2', { timeout: 180_000 });
  await expect(page.locator('#pbDebug')).toContainText('Exception');
  // The stack is live: boom called by run, and x is visible as None.
  await expect(page.locator('#pbDbgFrames')).toContainText('boom');
  await expect(page.locator('#pbDbgFrames')).toContainText('run');
  const xRow = page.locator('#pbDbgVars .pb-debug-var').filter({
    has: page.locator('.pb-debug-var-name', { hasText: /^x$/ }),
  });
  await expect(xRow).toContainText('None');

  // Continuing lets the exception propagate and the program finishes.
  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('AttributeError', { timeout: 60_000 });
});

test('pause on exceptions skips StopIteration from normal loops', async ({ page }) => {
  await openRoom(page, 'python');
  // A plain for-loop ends by raising StopIteration internally; the toggle
  // must not pause on it. A real error afterwards still pauses.
  await setCode(page, [
    'total = 0',
    'for i in range(3):',
    '    total += i',
    'print(total)',
    'raise ValueError("done")',
  ].join('\n'));

  await page.evaluate(() => {
    window.PbinDebug.setRunMode('debug');
    window.PbinDebug.setPauseOnException(true);
  });
  await page.click('#runButton');

  // The first (and only) pause is the ValueError on line 5, not the loop.
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 5', { timeout: 180_000 });
  await expect(page.locator('#pbDebug')).toContainText('ValueError');
  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('ValueError', { timeout: 60_000 });
});

test('restart re-runs the debug session from the start', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, ['x = 1', 'y = 2', 'print(x, y)'].join('\n'));
  await page.evaluate(() => {
    window.PbinPyDebug.toggleBreakpoint(1);
    window.PbinPyDebug.setRunMode('debug');
  });
  await page.click('#runButton');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 1', { timeout: 180_000 });

  // Advance past the start, then restart: it returns to line 1 in a fresh run.
  await page.click('#pbDbgOver');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 2');
  await page.click('#pbDbgRestart');
  await expect(page.locator('#pbDebugStatus')).toContainText('paused at line 1', { timeout: 60_000 });

  await page.click('#pbDbgContinue');
  await expect(page.locator('#output')).toContainText('1 2', { timeout: 60_000 });
});

test('the debug tab is always visible on a Python paste', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, 'print("plain")');
  // Visible with no breakpoints, and a plain run (the default) just produces
  // output.
  await expect(page.locator('#paneTabDebug')).toBeVisible();
  await page.click('#runButton');
  await expect(page.locator('#output')).toContainText('plain', { timeout: 180_000 });
  await expect(page.locator('#paneTabDebug')).toBeVisible();
});
