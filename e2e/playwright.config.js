// Browser end-to-end tests. By default they build and start a local server
// with a throwaway database; set PBIN_BASE_URL to test a deployed instance.
const { defineConfig } = require('@playwright/test');
const os = require('os');
const path = require('path');

const port = process.env.PBIN_E2E_PORT || '8799';
const external = process.env.PBIN_BASE_URL;

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
    baseURL: external || `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // No device preset: its user agent would make the editor pick the wrong
  // platform's keyboard shortcuts.
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: external ? undefined : {
    command: 'go run .',
    cwd: path.join(__dirname, '..'),
    url: `http://localhost:${port}/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: port,
      PBIN_RATE_LIMIT: '1000',
      DB_PATH: path.join(os.tmpdir(), `pbin-e2e-${process.pid}.db`),
    },
  },
});
