// AI tab completion: ghost text from /complete, accepted with Tab.
//
// The completion backend needs an API token, so these tests mock /complete
// at the network layer; they cover the editor integration (probe, inline
// suggestion, Tab accept), not the model itself.
const { test, expect } = require('@playwright/test');
const { openRoom, getCode } = require('./helpers');

const COMPLETION = 'return a + b;';

// Serves {enabled:true} for the probe and a fixed completion for requests.
async function mockCompletionBackend(page) {
  const requests = [];
  await page.route('**/complete', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { enabled: true } });
      return;
    }
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { completion: COMPLETION } });
  });
  return requests;
}

test('typing shows a ghost-text suggestion that Tab accepts', async ({ page }) => {
  const requests = await mockCompletionBackend(page);
  await openRoom(page, 'javascript');

  await page.click('#monacoContainer');
  await page.keyboard.type('function add(a, b) {');
  await page.keyboard.press('Enter');

  // Ghost text appears after the debounce + mocked round trip.
  await expect(page.locator('span[class*="ghost-text"]').first()).toBeAttached({ timeout: 15_000 });

  await page.keyboard.press('Tab');
  await expect.poll(() => getCode(page)).toContain(COMPLETION);

  // The request carried the text around the cursor.
  expect(requests.length).toBeGreaterThan(0);
  const last = requests[requests.length - 1];
  expect(last.prefix).toContain('function add(a, b) {');
  expect(typeof last.suffix).toBe('string');
});

test('the AI toolbar button toggles completions off and on', async ({ page }) => {
  const requests = await mockCompletionBackend(page);
  await openRoom(page, 'javascript');

  // The button appears once the probe confirms the backend, reading "On".
  const aiButton = page.locator('#toggleAiButton');
  await expect(aiButton).toBeVisible({ timeout: 15_000 });
  await expect(aiButton).toHaveAttribute('aria-pressed', 'true');

  // Toggle off: no completion requests while typing.
  await aiButton.click();
  await expect(aiButton).toHaveAttribute('aria-pressed', 'false');
  const before = requests.length;
  await page.click('#monacoContainer');
  await page.keyboard.type('function add(a, b) {');
  await page.waitForTimeout(1500); // longer than the debounce
  expect(requests.length).toBe(before);
  expect(await page.locator('span[class*="ghost-text"]').count()).toBe(0);

  // Toggle back on: ghost text returns.
  await aiButton.click();
  await expect(aiButton).toHaveAttribute('aria-pressed', 'true');
  await page.click('#monacoContainer');
  await page.keyboard.press('Enter');
  await expect(page.locator('span[class*="ghost-text"]').first()).toBeAttached({ timeout: 15_000 });
});

test('the AI-off choice persists across reloads', async ({ page }) => {
  await mockCompletionBackend(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('pbin-ai-completions', 'false'); } catch (e) {}
  });
  await openRoom(page, 'javascript');

  const aiButton = page.locator('#toggleAiButton');
  await expect(aiButton).toBeVisible({ timeout: 15_000 });
  await expect(aiButton).toHaveAttribute('aria-pressed', 'false');
  await expect(aiButton).toContainText('AI: Off');
});

test('editor stays quiet when completion is not configured', async ({ page }) => {
  let asked = 0;
  await page.route('**/complete', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { enabled: false } });
      return;
    }
    asked += 1;
    await route.fulfill({ json: { completion: COMPLETION } });
  });
  await openRoom(page, 'javascript');

  await page.click('#monacoContainer');
  await page.keyboard.type('function add(a, b) {');
  await page.waitForTimeout(1500); // longer than the debounce
  expect(asked).toBe(0);
  // Without a backend there is nothing to toggle, so the button stays hidden.
  await expect(page.locator('#toggleAiButton')).toBeHidden();
});
