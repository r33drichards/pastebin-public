// The room itself: creating and joining, live sync and autosave, and the
// toolbar (language picker, Auto Run, output panel, copy/share, Hello World).
const { test, expect } = require('@playwright/test');
const { openRoom, waitLive, setCode, getCode, run, storedText } = require('./helpers');

test('visiting / creates a room that is editable straight away', async ({ page }) => {
  await openRoom(page);
  expect(page.url()).toMatch(/\/paste\?id=[0-9a-f-]{36}$/);
  await expect(page.locator('#runButton')).toBeVisible();
  // No Edit / Save flow.
  await expect(page.locator('#editButton')).toHaveCount(0);
  await expect(page.locator('#saveButton')).toHaveCount(0);
  await page.click('#monacoContainer');
  await page.keyboard.type('typed straight away');
  expect(await getCode(page)).toBe('typed straight away');
});

test('each visit to / gets its own room', async ({ page }) => {
  const first = await openRoom(page);
  const second = await openRoom(page);
  expect(second).not.toBe(first);
});

test('two people in a room see each other\'s edits, and the text is saved', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const url = await openRoom(alice);
  await alice.click('#monacoContainer');
  await alice.keyboard.type('hello from alice');

  await bob.goto(url);
  await waitLive(bob);
  await expect.poll(() => getCode(bob)).toBe('hello from alice');
  await bob.click('#monacoContainer');
  await bob.keyboard.press('ControlOrMeta+End');
  await bob.keyboard.type(' and bob');

  await expect.poll(() => getCode(alice)).toBe('hello from alice and bob');
  // Each sees two avatars, with their own outlined.
  await expect(alice.locator('#collabAvatars .pb-avatar')).toHaveCount(2);
  await expect(alice.locator('#collabAvatars .pb-avatar--self')).toHaveCount(1);
  await waitLive(alice);
  await expect.poll(() => storedText(alice), { timeout: 15_000 }).toBe('hello from alice and bob');

  // Opening the link later joins the same room with the saved text.
  const later = await (await browser.newContext()).newPage();
  await later.goto(url);
  await waitLive(later);
  expect(await getCode(later)).toBe('hello from alice and bob');
});

test('language picker lists runnable languages first, filters, and syncs the choice', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const other = await (await browser.newContext()).newPage();
  const url = await openRoom(page);
  await other.goto(url);
  await waitLive(other);

  await page.click('#languageSelectButton');
  const rows = () => page.locator('.pb-langpick-list > *').allTextContents();
  const all = await rows();
  expect(all[0]).toBe('Runnable');
  const otherHeading = all.indexOf('Other languages');
  expect(otherHeading).toBeGreaterThan(1);
  // Everything above the second heading is runnable, nothing below is.
  expect(all.slice(1, otherHeading).every((t) => t.startsWith('▶'))).toBe(true);
  expect(all.slice(otherHeading + 1).some((t) => t.startsWith('▶'))).toBe(false);

  await page.keyboard.type('py');
  expect(await rows()).toEqual(['Runnable', '▶python']);
  await page.keyboard.type('zzz');
  expect(await rows()).toEqual(['No languages match']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pb-langpick-panel')).toBeHidden();

  await page.click('#languageSelectButton');
  await page.keyboard.type('pyth');
  await page.keyboard.press('Enter');
  await expect(page.locator('#languageSelectButton')).toHaveText('▶ python');
  await expect(other.locator('#languageSelectButton')).toHaveText('▶ python');

  // The choice is saved with the room.
  await waitLive(page);
  await page.waitForTimeout(2500);
  await page.reload();
  await waitLive(page);
  await expect(page.locator('#languageSelectButton')).toHaveText('▶ python');
});

test('output panel starts closed and opens when code runs', async ({ page }) => {
  await openRoom(page, 'javascript');
  await expect(page.locator('#outputPanel')).toBeHidden();
  await setCode(page, 'console.log(6 * 7)');
  expect(await run(page)).toContain('42');
  await expect(page.locator('#outputPanel')).toBeVisible();
  // merging the split (users drag the output tab back) hides the output
  await page.evaluate(() => window.toggleOutput());
  await expect(page.locator('#outputPanel')).toBeHidden();
});

test('Cmd/Ctrl+Enter runs the code', async ({ page }) => {
  await openRoom(page, 'javascript');
  await page.click('#monacoContainer');
  await page.keyboard.type('console.log(6 * 7)');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#output')).toContainText('42', { timeout: 120_000 });
});

test('Auto Run re-runs on changes, including another person\'s', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openRoom(page, 'javascript');
  await page.click('#monacoContainer');
  await page.keyboard.type('console.log(1 + 1)');
  await page.waitForTimeout(1500);
  // Off by default: nothing has run.
  await expect(page.locator('#outputPanel')).toBeHidden();

  await page.check('#autoRunCheckbox');
  await expect(page.locator('#output')).toContainText('2', { timeout: 120_000 });
  await setCode(page, 'console.log(100 + 1)');
  await expect(page.locator('#output')).toContainText('101', { timeout: 120_000 });

  const friend = await (await browser.newContext()).newPage();
  await friend.goto(page.url());
  await waitLive(friend);
  // The setting is per browser: the friend's is off.
  await expect(friend.locator('#autoRunCheckbox')).not.toBeChecked();
  await setCode(friend, 'console.log(7 * 11)');
  await expect(page.locator('#output')).toContainText('77', { timeout: 120_000 });

  // ...and remembered in this browser.
  const again = await context.newPage();
  await again.goto(page.url());
  await waitLive(again);
  await expect(again.locator('#autoRunCheckbox')).toBeChecked();
});

test('Hello World button only shows for runnable languages, appends, and can be undone', async ({ page }) => {
  await openRoom(page);
  await expect(page.locator('#helloWorldButton')).toBeHidden();
  await page.click('#languageSelectButton');
  await page.keyboard.type('python');
  await page.keyboard.press('Enter');
  await expect(page.locator('#helloWorldButton')).toBeVisible();

  await page.click('#monacoContainer');
  await page.keyboard.type('x = 1');
  await page.click('#helloWorldButton');
  const code = await getCode(page);
  expect(code.startsWith('x = 1\n\ndef greet(name):')).toBe(true);
  expect(code).toContain('greet("World")');
  await waitLive(page);
  await expect.poll(() => storedText(page), { timeout: 15_000 }).toBe(code);

  await page.keyboard.press('ControlOrMeta+z');
  expect(await getCode(page)).toBe('x = 1');
});

test('Copy text and Share paste copy to the clipboard and confirm on the button', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await openRoom(page);
  await page.click('#monacoContainer');
  await page.keyboard.type('clip me');

  const copy = page.locator('#copyTextButton');
  await expect(copy).toHaveText('Copy text');
  await copy.click();
  await expect(copy).toHaveText('Copied text to clipboard');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('clip me');
  await expect(copy).toHaveText('Copy text', { timeout: 5_000 });

  const share = page.locator('#sharePasteButton');
  await expect(share).toHaveText('Share paste');
  await share.click();
  await expect(share).toHaveText('Copied share URL to clipboard');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  await expect(share).toHaveText('Share paste', { timeout: 5_000 });
});

test('removed pages stay removed', async ({ request }) => {
  // /complete is back since AI tab completion (completion.spec.js covers it).
  for (const path of ['/classic', '/ai-edit']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});
