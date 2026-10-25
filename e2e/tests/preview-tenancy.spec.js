// Real same-browser-profile preferences and scoped editor URLs, not a VM mock.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { waitLive, setCode, storedText } = require('./helpers');

test('two previews and the default editor isolate browser preferences and saved text', async ({ browser }) => {
  const work = process.env.PBIN_WP_FIXTURE;
  expect(work, 'Full preview browser gate requires the disposable WordPress fixture').toBeTruthy();
  const fixture = JSON.parse(fs.readFileSync(path.join(work, 'previews.json'), 'utf8'));
  const context = await browser.newContext();
  const a = await context.newPage(), b = await context.newPage(), normal = await context.newPage();
  try {
    await a.goto(`/previews/pr-${fixture.a}/`); await waitLive(a);
    await b.goto(`/previews/pr-${fixture.b}/`); await waitLive(b);
    await normal.goto('/'); await waitLive(normal);
    await a.check('#autoRunCheckbox');
    await expect(b.locator('#autoRunCheckbox')).not.toBeChecked();
    await expect(normal.locator('#autoRunCheckbox')).not.toBeChecked();
    await a.evaluate(() => window.pbinStorage.setItem('pbin-theme', 'dark'));
    await b.evaluate(() => window.pbinStorage.setItem('pbin-theme', 'light'));
    await normal.evaluate(() => window.pbinStorage.setItem('pbin-theme', 'system'));
    expect(await a.evaluate(() => window.localStorage.getItem('pbin-theme'))).toBe('system');
    expect(await a.evaluate(() => window.pbinStorage.getItem('pbin-theme'))).toBe('dark');
    expect(await b.evaluate(() => window.pbinStorage.getItem('pbin-theme'))).toBe('light');
    await setCode(a, 'only tenant A'); await waitLive(a);
    await setCode(b, 'only tenant B'); await waitLive(b);
    await expect.poll(() => storedText(a)).toBe('only tenant A');
    await expect.poll(() => storedText(b)).toBe('only tenant B');
    await a.reload(); await waitLive(a);
    await b.reload(); await waitLive(b);
    await expect(a.locator('#autoRunCheckbox')).toBeChecked();
    await expect(b.locator('#autoRunCheckbox')).not.toBeChecked();
    expect(await a.evaluate(() => window.getValue())).toBe('only tenant A');
    expect(await b.evaluate(() => window.getValue())).toBe('only tenant B');
    const scripts = await a.locator('script[src]').evaluateAll(nodes => nodes.map(n => n.getAttribute('src')));
    expect(scripts.filter(url => url.includes('/static/')).every(url => url.startsWith(`/previews/pr-${fixture.a}/_releases/${fixture.revision}/static/`))).toBeTruthy();
  } finally {
    await context.close();
  }
});
