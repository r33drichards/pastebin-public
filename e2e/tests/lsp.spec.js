// Language-aware completions: keyword/builtin/snippet suggestions from
// lsp-completions.js, shown in Monaco's suggest widget.
const { test, expect } = require('@playwright/test');
const { openRoom, getCode } = require('./helpers');

// Returns the labels currently shown in the suggest widget.
function suggestLabels(page) {
  return page.$$eval('.suggest-widget .monaco-list-row .label-name', (els) =>
    els.map((el) => el.textContent.trim())
  );
}

// Types `prefix` into the empty editor and waits for the suggest widget to
// offer `expected` among its completions.
async function typeAndExpectSuggestion(page, prefix, expected) {
  await page.click('#monacoContainer');
  await page.keyboard.type(prefix);
  // quickSuggestions may race the first keystrokes; Ctrl+Space forces it.
  await page.keyboard.press('Control+Space');
  await expect
    .poll(() => suggestLabels(page), { timeout: 15_000 })
    .toContain(expected);
}

test('python keywords are suggested while typing', async ({ page }) => {
  await openRoom(page, 'python');
  await typeAndExpectSuggestion(page, 'ret', 'return');
});

test('go builtin word list loads from the Monarch grammar', async ({ page }) => {
  await openRoom(page, 'go');
  await typeAndExpectSuggestion(page, 'fun', 'func');
});

test('custom grammar languages get completions too', async ({ page }) => {
  await openRoom(page, 'minizinc');
  await typeAndExpectSuggestion(page, 'cons', 'constraint');
});

test('snippets insert with placeholders', async ({ page }) => {
  await openRoom(page, 'python');
  await page.click('#monacoContainer');
  await page.keyboard.type('ifmain');
  await page.keyboard.press('Control+Space');
  await expect.poll(() => suggestLabels(page), { timeout: 15_000 }).toContain('ifmain');
  // Select the ifmain snippet (snippets sort above plain words) and accept.
  await page.keyboard.press('Enter');
  await expect.poll(() => getCode(page)).toContain('if __name__ == "__main__":');
});

test('javascript IntelliSense from the TypeScript worker still works', async ({ page }) => {
  await openRoom(page, 'javascript');
  await page.click('#monacoContainer');
  await page.keyboard.type('JSON.par');
  await expect
    .poll(() => suggestLabels(page), { timeout: 30_000 })
    .toContain('parse');
});
