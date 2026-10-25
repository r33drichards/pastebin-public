// Optional preinstalled Chromium configuration for restricted environments.
// Certificate verification remains enabled. Fix trust at the environment level
// rather than treating a broken/intercepted TLS path as successful coverage.
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
  use: { ...base.use, launchOptions },
};
