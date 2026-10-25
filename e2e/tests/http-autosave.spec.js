const { test, expect } = require('@playwright/test');
const { openRoom, waitLive, setCode, storedText } = require('./helpers');

test('HTTP save failure is visible, protects navigation, and retries the latest edit', async ({ page }) => {
  await openRoom(page);
  let failing = true;
  await page.route('**/paste', async route => {
    if (route.request().method() === 'PUT' && failing) {
      await route.fulfill({status: 503, body: 'Synthetic save failure'});
    } else { await route.continue(); }
  });
  await page.click('#monacoContainer'); // User activation permits beforeunload dialog.
  await setCode(page, 'must not disappear');
  await expect(page.locator('#saveStatus')).toHaveAttribute('data-status', 'error');
  const dialog = page.waitForEvent('dialog');
  const navigation = page.reload().catch(() => null);
  const prompt = await dialog;
  expect(prompt.type()).toBe('beforeunload');
  await prompt.dismiss();
  await navigation;
  expect(await page.evaluate(() => window.getValue())).toBe('must not disappear');
  await setCode(page, 'latest text after failure');
  await expect(page.locator('#saveStatus')).toHaveAttribute('data-status', 'error');
  failing = false;
  await page.click('#saveStatus');
  await waitLive(page);
  await expect.poll(() => storedText(page)).toBe('latest text after failure');
  await page.reload(); await waitLive(page);
  expect(await page.evaluate(() => window.getValue())).toBe('latest text after failure');
});

test('newer edits made during a slow HTTP save are serialized and retained', async ({ page }) => {
  await openRoom(page);
  let release, intercepted;
  const ready = new Promise(resolve => { intercepted = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let writes = 0;
  await page.route('**/paste', async route => {
    if (route.request().method() === 'PUT' && ++writes === 1) { intercepted(); await hold; }
    await route.continue();
  });
  await setCode(page, 'first request');
  await ready;
  await setCode(page, 'newer edit during save');
  expect(writes).toBe(1);
  release();
  await waitLive(page);
  await expect.poll(() => storedText(page)).toBe('newer edit during save');
  expect(writes).toBe(2);
});
