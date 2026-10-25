// Python language server: basedpyright running in a web worker
// (static/js/pyright-lsp.js). The ~3 MB worker download comes from jsDelivr,
// so these tests allow generous timeouts.
const { test, expect } = require('@playwright/test');
const { openRoom, setCode, getCode } = require('./helpers');

async function waitForPyright(page) {
  await page.waitForFunction(
    () => window.PbinPyright.session && window.PbinPyright.session.state === 'ready',
    null, { timeout: 120_000 }
  );
}

// A function defined on line 1 and called on line 5.
const GREET = 'def greet(name):\n    return "hi " + name\n\n\nprint(greet("world"))\n';

async function setCursor(page, lineNumber, column) {
  await page.evaluate(([line, col]) => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel() && e.getModel().getLanguageId() === 'python');
    editor.setPosition({ lineNumber: line, column: col });
    editor.focus();
  }, [lineNumber, column]);
}

async function triggerEditorAction(page, action) {
  await page.evaluate((id) => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel() && e.getModel().getLanguageId() === 'python');
    editor.focus();
    editor.trigger('test', id, null);
  }, action);
}

test('pyright reports a type error as a marker', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, 'x: int = "not an int"\n');
  await page.waitForFunction(() => {
    const model = window.monaco.editor.getModels()[0];
    return window.monaco.editor
      .getModelMarkers({ owner: 'basedpyright', resource: model.uri })
      .some((m) => m.message.includes('not assignable'));
  }, null, { timeout: 60_000 });
});

test('pyright suggests module members', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await page.click('#monacoContainer');
  await page.keyboard.type('import os\nos.pa');
  await page.keyboard.press('Control+Space');
  await expect
    .poll(
      () => page.$$eval('.suggest-widget .monaco-list-row .label-name', (els) =>
        els.map((el) => el.textContent.trim())
      ),
      { timeout: 30_000 }
    )
    .toContain('path');
});

test('go to definition jumps from a call to the def', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, GREET);
  // Cursor on "greet" in the call on line 5, then F12.
  await setCursor(page, 5, 9);
  await triggerEditorAction(page, 'editor.action.revealDefinition');
  await expect
    .poll(
      () => page.evaluate(() => {
        const editor = window.monaco.editor
          .getEditors()
          .find((e) => e.getModel() && e.getModel().getLanguageId() === 'python');
        const pos = editor.getPosition();
        return { line: pos.lineNumber, column: pos.column };
      }),
      { timeout: 30_000 }
    )
    .toEqual({ line: 1, column: 5 });
});

test('F2 rename updates every occurrence', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, GREET);
  await setCursor(page, 5, 9);
  await triggerEditorAction(page, 'editor.action.rename');
  // The rename box opens with the current name preselected; typing replaces
  // it. Focus lands on the input only after prepareRename answers, so wait
  // for it or the keystrokes fall through to the editor.
  const renameInput = page.locator('.monaco-editor .rename-box input');
  await renameInput.waitFor({ state: 'visible', timeout: 30_000 });
  await expect(renameInput).toBeFocused({ timeout: 10_000 });
  await page.keyboard.type('salute');
  await page.keyboard.press('Enter');
  await expect.poll(() => getCode(page), { timeout: 30_000 }).toContain('def salute(name):');
  expect(await getCode(page)).toContain('print(salute("world"))');
});

test('go to references finds the call site from the def', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, GREET);
  // Cursor on "greet" in the def; the one reference is the call on line 5,
  // and with a single result Monaco navigates to it instead of peeking.
  await setCursor(page, 1, 5);
  await triggerEditorAction(page, 'editor.action.goToReferences');
  await expect
    .poll(
      () => page.evaluate(() => {
        const editor = window.monaco.editor
          .getEditors()
          .find((e) => e.getModel() && e.getModel().getLanguageId() === 'python');
        const pos = editor.getPosition();
        return { line: pos.lineNumber, column: pos.column };
      }),
      { timeout: 30_000 }
    )
    .toEqual({ line: 5, column: 7 });
});

test('quick outline lists the symbols in the paste', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, GREET);
  await setCursor(page, 1, 1);
  await triggerEditorAction(page, 'editor.action.quickOutline');
  await expect
    .poll(
      () => page.$$eval('.quick-input-widget .monaco-list-row .label-name', (els) =>
        els.map((el) => el.textContent.trim())
      ),
      { timeout: 30_000 }
    )
    .toContain('greet');
});

test('organize imports sorts the import block', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, 'import sys\nimport os\n\nprint(os.path, sys.path)\n');
  await setCursor(page, 1, 1);
  // Exercises the whole command path: codeAction → executeCommand →
  // the server's workspace/applyEdit applied back onto the model.
  await triggerEditorAction(page, 'editor.action.organizeImports');
  await expect.poll(() => getCode(page), { timeout: 30_000 }).toContain('import os\nimport sys');
});

test('inlay hints show inferred variable types', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, 'nums = [1, 2, 3]\n');
  // The rendered view gains a ": list[int]" hint that is not in the text.
  await expect
    .poll(
      () => page.evaluate(() => document.querySelector('.monaco-editor .view-lines').innerText),
      { timeout: 30_000 }
    )
    .toContain('list[int]');
  expect(await getCode(page)).not.toContain('list[int]');
});

test('semantic tokens are served for the paste', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, 'class Foo:\n    def bar(self):\n        return 1\n\n\nFoo().bar()\n');
  // The raw request bypasses the providers' own sync, so poll past the
  // debounced didChange.
  await expect
    .poll(
      () => page.evaluate(() =>
        window.PbinPyright.session
          .request('textDocument/semanticTokens/full', {
            textDocument: { uri: 'file:///src/Untitled.py' }
          })
          .then((r) => (r && r.data && r.data.length) || 0)
      ),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
});

test('markers are cleared when switching away from python', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPyright(page);
  await setCode(page, 'x: int = "nope"\n');
  await page.waitForFunction(() => {
    return window.monaco.editor.getModelMarkers({ owner: 'basedpyright' }).length > 0;
  }, null, { timeout: 60_000 });
  await page.selectOption('#languageSelect', 'lua');
  await page.waitForFunction(() => {
    return window.monaco.editor.getModelMarkers({ owner: 'basedpyright' }).length === 0;
  }, null, { timeout: 10_000 });
});
