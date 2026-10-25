// Deno-style URL module imports (code-runner.js): the https:// module graph
// is fetched from allowlisted CDNs before the run and mirrored into the
// QuickJS virtual filesystem, so the sandbox itself stays offline. The Effect
// test doubles as coverage for the pbin/effect-tracing bridge into the span
// waterfall (trace-view.js) and for the web-globals prelude, which Effect's
// modules need at evaluation time.
const { test, expect } = require('@playwright/test');
const { openRoom, setCode, run } = require('./helpers');

test('a paste imports a package from esm.sh', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, [
    "import camelCase from 'https://esm.sh/camelcase@8.0.0';",
    "console.log('cc:', camelCase('foo-bar baz'));",
  ].join('\n'));
  const output = await run(page);
  expect(output).toContain('cc: fooBarBaz');
});

test('a URL import from a non-allowlisted host is refused', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, "import x from 'https://example.com/evil.mjs';\nconsole.log(x);");
  const output = await run(page);
  expect(output).toMatch(/URL imports are limited to/);
});

test('the Effect Trace starter runs with traced spans in the trace tab', async ({ page }) => {
  // Effect's subpath dependency graph still needs a generous budget on a
  // cold CDN cache. Exercise the real imports and keep every trace assertion.
  test.setTimeout(600_000);
  await openRoom(page, 'typescript');

  // The starter button inserts the whole example (hello-world.js's
  // PbinEffectTracing); no hand-written program needed.
  await expect(page.locator('#effectTracingButton')).toBeVisible();
  await page.click('#effectTracingButton');
  await expect.poll(() => page.evaluate(() => window.getValue())).toContain('pbin/effect-tracing');

  const output = await run(page, 540_000);
  expect(output).toContain('total:');

  // The run surfaces the trace tab with the example's waterfall.
  await expect(page.locator('#paneTabTrace')).toBeVisible();
  await page.click('#paneTabTrace');
  const panel = page.locator('.pb-trace');
  await expect(panel).toHaveCount(1);
  await expect(panel.locator('.pb-trace-title')).toHaveText('process-order');
  await expect(panel.locator('.pb-trace-row--span')).toHaveCount(13);
  await expect(panel).toContainText('fetch-price SKU-1001');
  await expect(panel).toContainText('fetch-price SKU-1003');
  // The failed (then retried and recovered) effect's span carries ERROR status.
  await panel.locator('.pb-trace-row--span', { hasText: 'reserve-stock' }).first().click();
  await expect(panel.locator('.pb-trace-details')).toContainText('ERROR');
});
