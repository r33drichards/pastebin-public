// The Input tab: stdin for programs, attached files in the program's
// filesystem, downloads for files a program creates, and downloading the
// output itself.
const { test, expect } = require('@playwright/test');
const { openRoom, waitLive, setCode, run } = require('./helpers');

function setStdin(page, text) {
  return page.evaluate((t) => window.pbinInput.setText(t), text);
}

test('python reads the Input tab as stdin', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, 'import sys\nprint("got:", sys.stdin.read().strip().upper())');
  await setStdin(page, 'hello input');
  expect(await run(page)).toMatch(/got: HELLO INPUT/);
});

test('attached files are readable by name', async ({ page }) => {
  await openRoom(page, 'python');
  await page.click('#paneTabInput');
  await page.setInputFiles('#inputFilePicker', {
    name: 'data.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('line one\nline two\n'),
  });
  await expect(page.locator('.pb-filechip')).toHaveCount(1);
  // The Input tab shows a badge with the number of attached files.
  await expect(page.locator('#inputBadge')).toHaveText('1');
  await page.click('#paneTabCode');
  await setCode(page, 'print(len(open("data.txt").read().splitlines()), "lines")');
  expect(await run(page)).toMatch(/2 lines/);
});

test('files a program creates can be downloaded', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, 'with open("out.txt", "w") as f:\n    f.write("made by the program")\nprint("done")');
  const output = await run(page);
  expect(output).toMatch(/done/);
  expect(output).toMatch(/out\.txt/);
  const chip = page.locator('.pbin-runfile', { hasText: 'out.txt' });
  const [download] = await Promise.all([page.waitForEvent('download'), chip.click()]);
  expect(download.suggestedFilename()).toBe('out.txt');
});

test('the output can be downloaded as a text file', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, 'console.log("downloadable output");');
  expect(await run(page)).toMatch(/downloadable output/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#downloadOutputButton'),
  ]);
  expect(download.suggestedFilename()).toBe('output.txt');
});

test('shell reads stdin', async ({ page }) => {
  await openRoom(page, 'shell');
  await setCode(page, 'read name\necho "hi $name"');
  await setStdin(page, 'bob');
  expect(await run(page)).toMatch(/hi bob/);
});

test('picat reads stdin', async ({ page }) => {
  await openRoom(page, 'picat');
  await setCode(page, 'main =>\n    L = read_line(),\n    printf("hi %s%n", L).');
  await setStdin(page, 'bob');
  expect(await run(page)).toMatch(/hi bob/);
});

test('cpp reads stdin and attached files', async ({ page }) => {
  await openRoom(page, 'cpp');
  await page.click('#paneTabInput');
  await page.setInputFiles('#inputFilePicker', {
    name: 'nums.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('40 2'),
  });
  await page.click('#paneTabCode');
  await setCode(page, [
    '#include <iostream>',
    '#include <fstream>',
    'int main() {',
    '  std::string name;',
    '  std::cin >> name;',
    '  int a = 0, b = 0;',
    '  std::ifstream f("nums.txt");',
    '  f >> a >> b;',
    '  std::cout << name << " " << (a + b) << std::endl;',
    '  return 0;',
    '}',
  ].join('\n'));
  await setStdin(page, 'sum:');
  expect(await run(page)).toMatch(/sum: 42/);
});

test('minizinc reads the Input tab as .dzn data', async ({ page }) => {
  await openRoom(page, 'minizinc');
  await setCode(page, 'int: n;\nvar 1..n: x;\nconstraint x = n;\nsolve satisfy;\noutput ["x=\\(x)\\n"];');
  await setStdin(page, 'n = 5;');
  expect(await run(page)).toMatch(/x=5/);
});

// The Echo Input starter: one per stdin-capable language. Clicking the
// button inserts a program that reads stdin and prints it back, and seeds
// the Input tab with sample text, so Run demonstrates the round trip.
const echoExpectations = {
  python: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  ruby: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  javascript: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  typescript: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  cpp: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  shell: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  scheme: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  clojure: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  picat: /you said: Hello from the Input tab![\s\S]*you said: It was sent to stdin\./,
  minizinc: /n from the Input tab = 42/,
};

for (const [lang, expected] of Object.entries(echoExpectations)) {
  test(`${lang} Echo Input starter reads stdin back`, async ({ page }) => {
    await openRoom(page, lang);
    await expect(page.locator('#echoStdinButton')).toBeVisible();
    await page.click('#echoStdinButton');
    // The button seeded the Input tab with the sample text.
    expect(await page.evaluate(() => window.pbinInput.getText())).not.toBe('');
    expect(await run(page)).toMatch(expected);
  });
}

test('every Echo Input starter has a test', async ({ page }) => {
  await openRoom(page);
  const langs = await page.evaluate(() => Object.keys(window.PbinEchoStdin));
  expect(langs.sort()).toEqual(Object.keys(echoExpectations).sort());
});

// The Parse JSON starter: reads JSON from the Input tab, parses it with a
// real JSON parser, and prints each key and value. Only languages with one
// in their runtime have the starter. The sample input is
// {"name": "pbin", "stars": 42, "wasm": true}.
const jsonPattern = (bool) => new RegExp(`name = pbin[\\s\\S]*stars = 42[\\s\\S]*wasm = ${bool}`);
const jsonExpectations = {
  python: jsonPattern('True'),
  ruby: jsonPattern('true'),
  javascript: jsonPattern('true'),
  typescript: jsonPattern('true'),
  scheme: jsonPattern('true'),
  clojure: jsonPattern('true'),
  minizinc: jsonPattern('(true|wasm)'),
};

for (const [lang, expected] of Object.entries(jsonExpectations)) {
  test(`${lang} Parse JSON starter prints keys and values`, async ({ page }) => {
    await openRoom(page, lang);
    await expect(page.locator('#jsonStdinButton')).toBeVisible();
    await page.click('#jsonStdinButton');
    expect(await page.evaluate(() => window.pbinInput.getText())).toContain('"name"');
    expect(await run(page)).toMatch(expected);
  });
}

test('every Parse JSON starter has a test', async ({ page }) => {
  await openRoom(page);
  const langs = await page.evaluate(() => Object.keys(window.PbinJsonStdin));
  expect(langs.sort()).toEqual(Object.keys(jsonExpectations).sort());
});

test('stdin text is remembered per paste in this browser', async ({ page }) => {
  const url = await openRoom(page, 'python');
  await setStdin(page, 'persisted input');
  await page.goto(url);
  await waitLive(page);
  await expect
    .poll(() => page.evaluate(() => window.pbinInput && window.pbinInput.getText()))
    .toBe('persisted input');
});
