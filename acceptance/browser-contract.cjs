// Runs unchanged against either isolated backend. Never imports app internals.
const { chromium } = require(process.env.PBIN_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base=process.env.PBIN_ACCEPTANCE_URL;
if (!base) throw new Error('PBIN_ACCEPTANCE_URL required');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PBIN_CHROMIUM || '/usr/bin/chromium'});
 try {
  const a=await browser.newPage(), b=await browser.newPage();
  await a.goto(new URL('/?lang=javascript',base).href);
  await a.locator('#collabStatus[data-status="saved"]').waitFor({timeout:60000});
  assert.equal(await a.evaluate(()=>crossOriginIsolated),true);
  await a.locator('#monacoContainer').click();await a.keyboard.type('console.log(6 * 7)');
  await b.goto(a.url());await b.locator('#collabStatus[data-status="saved"]').waitFor({timeout:30000});
  await b.waitForFunction(()=>window.getValue()==='console.log(6 * 7)');
  assert.equal(await b.locator('#collabAvatars .pb-avatar').count(),2);
  await b.locator('#monacoContainer').click();await b.keyboard.press('ControlOrMeta+End');await b.keyboard.type('; // peer');
  await a.waitForFunction(()=>window.getValue().endsWith('; // peer'));
  await a.locator('#runButton').click();await a.waitForFunction(()=>document.querySelector('#output').innerText.includes('42'),{timeout:60000});
  // Last participant closing must persist immediately, not only on debounce.
  const url=a.url();await a.close();await b.close();
  const c=await browser.newPage();await c.goto(url);await c.locator('#collabStatus[data-status="saved"]').waitFor({timeout:30000});
  assert.equal(await c.evaluate(()=>window.getValue()),'console.log(6 * 7); // peer');
  assert.match(await c.locator('#languageSelectButton').innerText(),/javascript/);
  await c.reload();await c.locator('#collabStatus[data-status="saved"]').waitFor({timeout:30000});
  assert.equal(await c.evaluate(()=>window.getValue()),'console.log(6 * 7); // peer');
  console.log('PASS: fresh room, language, real edit/presence/sync, runner, close/rejoin/reload');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
