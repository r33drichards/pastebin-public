// The Ctrl/Cmd+K command menu (ninja-keys + static/js/command-palette.js):
// opening, searching, running actions, the language submenu, and the
// debugger actions it exposes.
const { test, expect } = require('@playwright/test');
const { openRoom, setCode } = require('./helpers');

// The palette exists once ninja-keys has loaded from the CDN; the toolbar
// ⌘K key is revealed at the same moment.
async function waitForPalette(page) {
  await expect(page.locator('#commandMenuButton')).toBeVisible({ timeout: 30_000 });
}

// ninja-keys renders in nested shadow DOM; Playwright's css pierces it.
function searchBox(page) {
  return page.locator('ninja-keys input.search');
}

async function openPalette(page) {
  await page.keyboard.press('Control+k');
  await expect(searchBox(page)).toBeVisible();
}

// Types a query, waits until the list has re-rendered with the expected
// action on top (ninja-keys filters asynchronously), then selects it.
async function pick(page, query, titlePart) {
  await searchBox(page).fill(query);
  await expect(page.locator('ninja-keys ninja-action .ninja-title').first()).toContainText(titlePart);
  await page.keyboard.press('Enter');
}

async function runAction(page, query, titlePart) {
  await openPalette(page);
  await pick(page, query, titlePart);
}

test('Ctrl+K opens the menu, Escape closes it, and it works from inside the editor', async ({ page }) => {
  await openRoom(page);
  await waitForPalette(page);

  await openPalette(page);
  // The root list holds every section's actions (regression check: nothing
  // gets mis-parented under a submenu).
  const titles = page.locator('ninja-keys ninja-action .ninja-title');
  await expect(titles.first()).toContainText('Run');
  await expect(titles.filter({ hasText: 'Copy paste text' })).toBeVisible();
  await expect(titles.filter({ hasText: 'New paste' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(searchBox(page)).toBeHidden();

  // From inside Monaco (where Ctrl+K is normally a chord prefix).
  await page.click('#monacoContainer');
  await openPalette(page);
  await page.keyboard.press('Escape');
});

test('actions run: word wrap toggles and the paste text is copied', async ({ page, context }) => {
  await openRoom(page);
  await waitForPalette(page);

  const wrapButton = page.locator('#toggleWordWrapButton');
  const before = await wrapButton.getAttribute('aria-pressed');
  await runAction(page, 'word wrap', 'Word wrap');
  await expect(wrapButton).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  await expect(searchBox(page)).toBeHidden();

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setCode(page, 'hello from the palette');
  await runAction(page, 'copy paste text', 'Copy paste text');
  await expect(page.locator('#copyTextButton')).toContainText('Copied');

  await runAction(page, 'switch to the output tab', 'Switch to the Output tab');
  await expect(page.locator('#paneTabOutput')).toHaveAttribute('aria-selected', 'true');
  await runAction(page, 'switch to the code tab', 'Switch to the Code tab');
  await expect(page.locator('#paneTabCode')).toHaveAttribute('aria-selected', 'true');
});

test('the language submenu switches the language', async ({ page }) => {
  await openRoom(page);
  await waitForPalette(page);

  await openPalette(page);
  await pick(page, 'switch language', 'Switch language'); // opens the submenu
  await expect(searchBox(page)).toBeVisible();
  // the submenu lists only languages, runnable ones first
  const titles = page.locator('ninja-keys ninja-action .ninja-title');
  await expect(titles.first()).toContainText('▶');
  await expect(titles.filter({ hasText: 'Word wrap' })).toHaveCount(0);
  await pick(page, 'python', 'python');

  await expect(page.locator('#languageSelect')).toHaveValue('python');
  await expect(page.locator('#language')).toHaveValue('python');
});

test('debug actions: toggle a breakpoint on the cursor line', async ({ page }) => {
  await openRoom(page, 'python');
  await waitForPalette(page);
  await setCode(page, 'x = 1\ny = 2\nprint(x + y)\n');
  await page.evaluate(() => window.pbinEditor.setPosition({ lineNumber: 2, column: 1 }));

  await runAction(page, 'toggle breakpoint', 'Toggle breakpoint');
  await expect.poll(() => page.evaluate(() => window.PbinDebug.getBreakpoints().map((b) => b.line))).toEqual([2]);

  await page.evaluate(() => window.pbinEditor.setPosition({ lineNumber: 2, column: 1 }));
  await runAction(page, 'toggle breakpoint', 'Toggle breakpoint');
  await expect.poll(() => page.evaluate(() => window.PbinDebug.getBreakpoints().length)).toBe(0);
});

test('the catalog adapts: debugger actions only for debuggable languages', async ({ page }) => {
  await openRoom(page, 'go');
  await waitForPalette(page);

  const ids = () => page.evaluate(() => window.PbinPalette.actions().map((a) => a.id));
  expect(await ids()).not.toContain('toggle-breakpoint');

  await page.evaluate(() => {
    const select = document.getElementById('languageSelect');
    select.value = 'python';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await ids()).toContain('toggle-breakpoint');
  expect(await ids()).not.toContain('dbg-continue'); // only while paused
});
