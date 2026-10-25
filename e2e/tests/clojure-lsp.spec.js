// Clojure editor support (static/js/clojure-lsp.js): completions, hovers,
// signature help, outline, go-to-definition, paren diagnostics and run-error
// markers — all local (docs table + buffer reader + the run's SCI context).
const { test, expect } = require('@playwright/test');
const { openRoom, setCode, run } = require('./helpers');

// A function defined on line 1 and called on line 5.
const GREET = '(defn greet [name]\n  (str "Hello, " name "!"))\n\n\n(println (greet "world"))\n';

async function setCursor(page, lineNumber, column) {
  await page.evaluate(([line, col]) => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel() && e.getModel().getLanguageId() === 'clojure');
    editor.setPosition({ lineNumber: line, column: col });
    editor.focus();
  }, [lineNumber, column]);
}

async function triggerEditorAction(page, action) {
  await page.evaluate((id) => {
    const editor = window.monaco.editor
      .getEditors()
      .find((e) => e.getModel() && e.getModel().getLanguageId() === 'clojure');
    editor.focus();
    editor.trigger('test', id, null);
  }, action);
}

function suggestLabels(page) {
  return page.$$eval('.suggest-widget .monaco-list-row .label-name', (els) =>
    els.map((el) => el.textContent.trim())
  );
}

test('core functions are suggested with their docs', async ({ page }) => {
  await openRoom(page, 'clojure');
  await page.click('#monacoContainer');
  await page.keyboard.type('(redu');
  await page.keyboard.press('Control+Space');
  await expect.poll(() => suggestLabels(page), { timeout: 15_000 }).toContain('reduce');
});

test("the paste's own defns are suggested first", async ({ page }) => {
  await openRoom(page, 'clojure');
  await setCode(page, GREET);
  await setCursor(page, 5, 1);
  await page.keyboard.type('(gre');
  await page.keyboard.press('Control+Space');
  await expect.poll(() => suggestLabels(page), { timeout: 15_000 }).toContain('greet');
});

test('hover on a core symbol shows arglists and docstring', async ({ page }) => {
  await openRoom(page, 'clojure');
  await setCode(page, '(map inc [1 2 3])\n');
  await setCursor(page, 1, 3); // on "map"
  await triggerEditorAction(page, 'editor.action.showHover');
  const hover = page.locator('.monaco-editor .monaco-hover');
  await expect(hover).toBeVisible({ timeout: 15_000 });
  await expect(hover).toContainText('clojure.core/map', { timeout: 15_000 });
  await expect(hover).toContainText('lazy sequence');
});

test('unbalanced parens get a live marker', async ({ page }) => {
  await openRoom(page, 'clojure');
  await setCode(page, '(defn broken [x]\n  (+ x 1)\n');
  await page.waitForFunction(() => {
    return window.monaco.editor
      .getModelMarkers({ owner: 'clojure-syntax' })
      .some((m) => m.message.includes("Unclosed '('"));
  }, null, { timeout: 15_000 });
  // Balancing the form clears the marker.
  await setCode(page, '(defn fixed [x]\n  (+ x 1))\n');
  await page.waitForFunction(() => {
    return window.monaco.editor.getModelMarkers({ owner: 'clojure-syntax' }).length === 0;
  }, null, { timeout: 15_000 });
});

test('go to definition jumps from a call to the defn', async ({ page }) => {
  await openRoom(page, 'clojure');
  await setCode(page, GREET);
  await setCursor(page, 5, 12); // on "greet" in the call
  await triggerEditorAction(page, 'editor.action.revealDefinition');
  await expect
    .poll(
      () => page.evaluate(() => {
        const editor = window.monaco.editor
          .getEditors()
          .find((e) => e.getModel() && e.getModel().getLanguageId() === 'clojure');
        const pos = editor.getPosition();
        return { line: pos.lineNumber, column: pos.column };
      }),
      { timeout: 15_000 }
    )
    .toEqual({ line: 1, column: 7 });
});

test('quick outline lists the top-level defs', async ({ page }) => {
  await openRoom(page, 'clojure');
  await setCode(page, '(ns my.app)\n\n(def answer 42)\n\n(defn greet [name] name)\n');
  await setCursor(page, 1, 1);
  await triggerEditorAction(page, 'editor.action.quickOutline');
  const picker = page.locator('.quick-input-widget .monaco-list');
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await expect(picker).toContainText('greet');
  await expect(picker).toContainText('answer');
});

test('signature help shows the arities of a core function', async ({ page }) => {
  await openRoom(page, 'clojure');
  await page.click('#monacoContainer');
  await page.keyboard.type('(reduce ');
  await triggerEditorAction(page, 'editor.action.triggerParameterHints');
  const hints = page.locator('.monaco-editor .parameter-hints-widget');
  await expect(hints).toBeVisible({ timeout: 15_000 });
  await expect(hints).toContainText('reduce');
  await expect(hints).toContainText('f');
});

test('a failed run marks the failing line, cleared by editing', async ({ page }) => {
  await openRoom(page, 'clojure');
  await setCode(page, '(println "before")\n(nth [1 2] 5)\n');
  expect(await run(page)).toMatch(/No item 5/);
  const markers = await page.evaluate(() =>
    window.monaco.editor.getModelMarkers({ owner: 'clojure-run' })
      .map((m) => ({ line: m.startLineNumber, message: m.message }))
  );
  expect(markers.length).toBe(1);
  expect(markers[0].line).toBe(2);
  expect(markers[0].message).toContain('No item 5');
  // Editing clears the run marker.
  await setCode(page, '(println "edited")\n');
  await page.waitForFunction(() => {
    return window.monaco.editor.getModelMarkers({ owner: 'clojure-run' }).length === 0;
  }, null, { timeout: 15_000 });
});

test('hover reads live metadata from the last run', async ({ page }) => {
  await openRoom(page, 'clojure');
  await setCode(page, '(defn my-add\n  "Adds two numbers."\n  [a b]\n  (+ a b))\n\n(my-add 2 3)\n');
  expect(await run(page)).toMatch(/Result:[\s\S]*5/);
  await setCursor(page, 6, 3); // on "my-add" in the call
  await triggerEditorAction(page, 'editor.action.showHover');
  const hover = page.locator('.monaco-editor .monaco-hover');
  await expect(hover).toBeVisible({ timeout: 15_000 });
  // The docstring comes from the run's SCI context, not the docs table.
  await expect(hover).toContainText('Adds two numbers.', { timeout: 15_000 });
});
