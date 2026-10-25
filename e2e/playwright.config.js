// Browser tests target an explicitly supplied WordPress fixture. They never
// build/start the retired Go application server or silently reuse another site.
const { defineConfig } = require('@playwright/test');
const external = process.env.PBIN_BASE_URL;
if (!external) {
  throw new Error('Set PBIN_BASE_URL to an isolated WordPress instance, or run via wordpress/ci/run-fixture.sh');
}
const baseURL = external.replace(/\/$/, '') + '/';
if (!/^https?:\/\//.test(baseURL)) throw new Error('PBIN_BASE_URL must be an HTTP(S) URL');

module.exports = defineConfig({
  testDir: './tests',
  // The runners download their runtimes (WASM, CDN scripts) on first use.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  // Language runtimes come from third-party CDNs; retry transient failures.
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // No device preset: its user agent would make the editor pick the wrong
  // platform's keyboard shortcuts.
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
