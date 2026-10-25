// Structured run output: JSON printed by a program is shown in a read-only
// Monaco editor (syntax highlighting + folding, so it can be collapsed),
// SVG markup and Mermaid source render as the actual graphic with a
// source toggle, while plain text output stays an ordinary <pre>. Copy
// keeps returning the raw program output in every case.
const { test, expect } = require('@playwright/test');
const { openRoom, setCode, run } = require('./helpers');

// Prints a pretty-printed JSON object, like JSON.stringify(x, null, 2) would.
const jsonProgram = [
  '(display "{") (newline)',
  '(display "  \\"name\\": \\"pbin\\",") (newline)',
  '(display "  \\"tags\\": [1, 2, 3]") (newline)',
  '(display "}")',
].join('\n');

test('JSON output is rendered in a collapsible read-only Monaco editor', async ({ page }) => {
  await openRoom(page, 'scheme');
  await setCode(page, jsonProgram);

  await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
  await page.click('#runButton');
  const editorBlock = page.locator('#output .pb-output-monaco');
  await expect(editorBlock).toBeVisible({ timeout: 120_000 });

  // It is a JSON Monaco model, not a <pre>.
  await expect(editorBlock).toHaveAttribute('data-pb-lang', 'json');
  await expect(editorBlock.locator('.monaco-editor')).toBeVisible();
  expect(await page.evaluate(() =>
    window.monaco.editor.getModels().map((m) => m.getLanguageId())
  )).toContain('json');

  // Folding: collapsing the object hides the inner lines.
  await expect(editorBlock.getByText('"tags"')).toBeVisible();
  await editorBlock.locator('.codicon-folding-expanded').first().click();
  await expect(editorBlock.getByText('"tags"')).toBeHidden();

  // Copy and download still see the raw program output, not Monaco's DOM.
  expect(await page.evaluate(() => window.pbinOutputText())).toContain(
    '{\n  "name": "pbin",\n  "tags": [1, 2, 3]\n}'
  );
});

test('compact single-line JSON is pretty-printed into the editor; Copy stays raw', async ({ page }) => {
  await openRoom(page, 'scheme');
  await setCode(page, '(display "{\\"name\\":\\"pbin\\",\\"stars\\":42,\\"wasm\\":true}")');

  await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
  await page.click('#runButton');
  const editorBlock = page.locator('#output .pb-output-monaco');
  await expect(editorBlock).toBeVisible({ timeout: 120_000 });
  await expect(editorBlock).toHaveAttribute('data-pb-lang', 'json');

  // Displayed pretty-printed (one key per line), so folding works.
  await expect(editorBlock.getByText('"stars": 42')).toBeVisible();
  await editorBlock.locator('.codicon-folding-expanded').first().click();
  await expect(editorBlock.getByText('"stars": 42')).toBeHidden();

  // Copy still returns the output exactly as the program printed it.
  expect(await page.evaluate(() => window.pbinOutputText())).toContain(
    '{"name":"pbin","stars":42,"wasm":true}'
  );
});

test('plain text output stays a plain <pre>', async ({ page }) => {
  await openRoom(page, 'scheme');
  await setCode(page, '(display "just some text output") (newline) (display "with two lines")');
  const text = await run(page);
  expect(text).toContain('just some text output');
  await expect(page.locator('#output .pb-output-monaco')).toHaveCount(0);
  await expect(page.locator('#output pre')).toBeVisible();
});

test('SVG output renders as the graphic, with a toggle to its source', async ({ page }) => {
  await openRoom(page, 'scheme');
  await setCode(page,
    '(display "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"120\\" height=\\"80\\">' +
    '<circle cx=\\"60\\" cy=\\"40\\" r=\\"30\\" fill=\\"teal\\"/></svg>")');

  await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
  await page.click('#runButton');
  const block = page.locator('#output .pb-output-render[data-pb-lang="svg"]');
  await expect(block).toBeVisible({ timeout: 120_000 });
  await expect(block.locator('svg circle')).toBeVisible();

  // The toggle flips to the markup in a read-only Monaco editor, and back.
  await block.locator('.pb-output-src-toggle').click();
  await expect(block.locator('.pb-output-monaco')).toBeVisible();
  await expect(block.locator('svg circle')).toBeHidden();
  await block.locator('.pb-output-src-toggle').click();
  await expect(block.locator('svg circle')).toBeVisible();

  // Copy sees the raw markup, not the rendered DOM.
  expect(await page.evaluate(() => window.pbinOutputText())).toContain('<svg xmlns=');
});

test('Mermaid output renders as a diagram; mermaid-looking prose stays text', async ({ page }) => {
  await openRoom(page, 'scheme');
  await setCode(page, '(display "graph TD") (newline) (display "  A[Start] --> B[Done]")');

  await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
  await page.click('#runButton');
  const block = page.locator('#output .pb-output-render[data-pb-lang="mermaid"]');
  await expect(block).toBeVisible({ timeout: 120_000 });
  await expect(block.locator('.pb-output-render-body svg')).toBeVisible();
  await expect(block.getByText('Start')).toBeVisible();

  // A line that merely starts with a diagram keyword is not a diagram.
  await setCode(page, '(display "graph coloring is a classic problem") (newline) (display "second line")');
  const text = await run(page);
  expect(text).toContain('graph coloring');
  await expect(page.locator('#output .pb-output-render')).toHaveCount(0);
});
