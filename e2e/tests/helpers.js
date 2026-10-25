const { expect } = require('@playwright/test');

// Opens a fresh room (optionally in a language) and waits until it is live.
async function openRoom(page, lang) {
  await page.goto(lang ? `/?lang=${encodeURIComponent(lang)}` : '/');
  await waitLive(page);
  return page.url();
}

// Waits until the room is connected and everything is saved.
async function waitLive(page) {
  await expect(page.locator('#collabStatus')).toHaveAttribute('data-status', 'saved', { timeout: 30_000 });
}

// Replaces the document through the editor, as a user edit: it is sent to
// the room and saved like typing would be.
async function setCode(page, code) {
  await page.evaluate((text) => {
    const model = window.monaco.editor.getModels()[0];
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  }, code);
}

function getCode(page) {
  return page.evaluate(() => window.getValue());
}

// Clicks Run and returns the output once the run has finished. Diagrams
// render as SVG, whose text is returned as well.
async function run(page, timeout = 180_000) {
  await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
  await page.click('#runButton');
  await page.waitForFunction(() => {
    const output = document.getElementById('output');
    const hasContent = output.innerText.trim() !== '' || output.querySelector('svg') !== null;
    return hasContent && !output.querySelector('.spinner') && !document.getElementById('runButton').disabled;
  }, null, { timeout });
  // Some runners write their result in more than one step.
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const output = document.getElementById('output');
    const svg = output.querySelector('svg');
    return (output.innerText + ' ' + (svg ? svg.textContent : '')).trim();
  });
}

// The text the server has stored for the room on this page.
async function storedText(page) {
  const response = await page.request.get(page.url() + '.txt');
  return response.text();
}

module.exports = { openRoom, waitLive, setCode, getCode, run, storedText };
