// Config for sandboxed/proxied environments (e.g. Claude Code cloud sessions)
// where an agent proxy re-signs TLS with its own CA: Chromium rejects the
// CDN's re-signed certificates, so ignore certificate errors, and retry
// since the interception is also flaky. CI and local dev use the default
// playwright.config.js instead.
//
// Usage: npx playwright test --config playwright.sandbox.config.js
const fs = require('fs');
const base = require('./playwright.config.js');

// Those environments pre-install a Chromium at a version-agnostic path and
// block downloads, so when the pinned Playwright revision is missing, launch
// the pre-installed binary instead of asking for `npx playwright install`.
const prebuilt = '/opt/pw-browsers/chromium';
const launchOptions = fs.existsSync(prebuilt) ? { executablePath: prebuilt } : {};

module.exports = {
  ...base,
  retries: 4,
  use: { ...base.use, ignoreHTTPSErrors: true, launchOptions },
};
