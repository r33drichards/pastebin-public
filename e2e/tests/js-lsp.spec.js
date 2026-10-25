// JavaScript/TypeScript language features from Monaco's built-in
// TypeScript worker, as configured in templates/paste.html: type-checked
// diagnostics (checkJs for plain JavaScript), completions, navigation,
// rename, inlay hints, and the QuickJS 'std'/'os' ambient module typings.
const { test, expect } = require('@playwright/test');
const { openRoom, setCode, getCode } = require('./helpers');

// A function defined on line 1 and called on line 5.
const GREET = 'function greet(name) {\n  return "hi " + name;\n}\n\nconsole.log(greet("world"));\n';

async function setCursor(page, lang, lineNumber, column) {
  await page.evaluate(([langId, line, col]) => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel() && e.getModel().getLanguageId() === langId);
    editor.setPosition({ lineNumber: line, column: col });
    editor.focus();
  }, [lang, lineNumber, column]);
}

async function triggerEditorAction(page, lang, action) {
  await page.evaluate(([langId, id]) => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel() && e.getModel().getLanguageId() === langId);
    editor.focus();
    editor.trigger('test', id, null);
  }, [lang, action]);
}

function waitForMarker(page, owner, pattern) {
  return page.waitForFunction(([markerOwner, text]) => {
    const model = window.monaco.editor.getModels()[0];
    return window.monaco.editor
      .getModelMarkers({ owner: markerOwner, resource: model.uri })
      .some((m) => m.message.includes(text));
  }, [owner, pattern], { timeout: 60_000 });
}

test('checkJs reports a type error in plain JavaScript', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, 'let n = 1;\nn.toUpperCase();\n');
  await waitForMarker(page, 'javascript', "'toUpperCase' does not exist on type 'number'");
});

test('TypeScript reports a type error as a marker', async ({ page }) => {
  await openRoom(page, 'typescript');
  await setCode(page, "const n: number = 'not a number';\n");
  await waitForMarker(page, 'typescript', 'not assignable');
});

test("the QuickJS 'std' module typings keep the stdin starter clean", async ({ page }) => {
  await openRoom(page, 'typescript');
  // First a known error, so we only read "no markers" after the checker
  // has demonstrably run on this paste.
  await setCode(page, "const n: number = 'nope';\n");
  await waitForMarker(page, 'typescript', 'not assignable');
  await setCode(page, "import * as std from 'std';\nconst line: string | null = std.in.getline();\nconsole.log(line);\n");
  await page.waitForFunction(() => {
    const model = window.monaco.editor.getModels()[0];
    const markers = window.monaco.editor.getModelMarkers({ owner: 'typescript', resource: model.uri });
    return markers.filter((m) => m.severity === window.monaco.MarkerSeverity.Error).length === 0;
  }, null, { timeout: 60_000 });
});

test('the ES2025 iterator helper typings keep a generator pipeline clean', async ({ page }) => {
  await openRoom(page, 'typescript');
  // First a known error, so we only read "no markers" after the checker
  // has demonstrably run on this paste.
  await setCode(page, "const n: number = 'nope';\n");
  await waitForMarker(page, 'typescript', 'not assignable');
  // Monaco's bundled TypeScript 5.4 predates the iterator helpers the
  // quickjs-ng runtime executes; the extra lib in paste.html supplies them.
  await setCode(page, [
    'function* nums(n: number) {',
    '  for (let i = 0; i < n; i++) yield i;',
    '}',
    'const evens: number[] = nums(10).filter((x) => x % 2 === 0).toArray();',
    'const doubled: number[] = nums(5).flatMap((x) => [x, x]).take(4).toArray();',
    'console.log(evens, doubled, nums(4).map((x) => x + 1).reduce((a, b) => a + b, 0));',
  ].join('\n'));
  await page.waitForFunction(() => {
    const model = window.monaco.editor.getModels()[0];
    const markers = window.monaco.editor.getModelMarkers({ owner: 'typescript', resource: model.uri });
    return markers.filter((m) => m.severity === window.monaco.MarkerSeverity.Error).length === 0;
  }, null, { timeout: 60_000 });
});

test('completions suggest object members', async ({ page }) => {
  await openRoom(page, 'javascript');
  await page.click('#monacoContainer');
  await page.keyboard.type('JSON.par');
  await page.keyboard.press('Control+Space');
  await expect
    .poll(
      () => page.$$eval('.suggest-widget .monaco-list-row .label-name', (els) =>
        els.map((el) => el.textContent.trim())
      ),
      { timeout: 60_000 }
    )
    .toContain('parse');
});

test('go to definition jumps from a call to the function', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, GREET);
  // Cursor on "greet" in the call on line 5, then F12.
  await setCursor(page, 'javascript', 5, 15);
  await triggerEditorAction(page, 'javascript', 'editor.action.revealDefinition');
  await expect
    .poll(
      () => page.evaluate(() => {
        const editor = window.monaco.editor
          .getEditors()
          .find((e) => e.getModel() && e.getModel().getLanguageId() === 'javascript');
        return editor.getPosition().lineNumber;
      }),
      { timeout: 60_000 }
    )
    .toBe(1);
});

test('F2 rename updates every occurrence', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, GREET);
  await setCursor(page, 'javascript', 5, 15);
  await triggerEditorAction(page, 'javascript', 'editor.action.rename');
  const renameInput = page.locator('.monaco-editor .rename-box input');
  await renameInput.waitFor({ state: 'visible', timeout: 60_000 });
  await expect(renameInput).toBeFocused({ timeout: 10_000 });
  await page.keyboard.type('salute');
  await page.keyboard.press('Enter');
  await expect.poll(() => getCode(page), { timeout: 30_000 }).toContain('function salute(name)');
  expect(await getCode(page)).toContain('console.log(salute("world"));');
});

test('inlay hints show inferred types in TypeScript', async ({ page }) => {
  await openRoom(page, 'typescript');
  await setCode(page, 'function twice(n: number) {\n  return n * 2;\n}\nconst answer = twice(21);\n');
  // The rendered view gains a ": number" hint on `answer` that is not in
  // the text.
  // Monaco renders hints with non-breaking spaces, so match loosely.
  await expect
    .poll(
      () => page.evaluate(() => document.querySelector('.monaco-editor .view-lines').innerText),
      { timeout: 60_000 }
    )
    .toMatch(/answer:\s*number/);
  expect(await getCode(page)).not.toMatch(/answer:\s*number/);
});

test('markers are cleared when switching away from javascript', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, 'let n = 1;\nn.toUpperCase();\n');
  await waitForMarker(page, 'javascript', 'toUpperCase');
  await page.selectOption('#languageSelect', 'lua');
  await page.waitForFunction(() => {
    return window.monaco.editor.getModelMarkers({ owner: 'javascript' }).length === 0;
  }, null, { timeout: 10_000 });
});
