// OpenTelemetry tracing: a paste that imports '@opentelemetry/api' (the
// in-paste shim, static/js/otel-shim.js) gets a span waterfall under its
// output (static/js/trace-view.js). Covered on all three routes a trace can
// take: a plain JavaScript run (QuickJS, traces ride stdout as sentinel
// lines), a TypeScript run (types stripped first, then the same QuickJS
// path), and a debugger run (the worker returns traces on its result
// message).
const { test, expect } = require('@playwright/test');
const { openRoom, setCode, run } = require('./helpers');

const TRACED = (typed) => [
  "import { trace, SpanStatusCode } from '@opentelemetry/api';",
  "const tracer = trace.getTracer('demo');",
  typed
    ? 'function busy(n: number): number { let s = 0; for (let i = 0; i < n; i++) s += Math.sqrt(i); return s; }'
    : 'function busy(n) { let s = 0; for (let i = 0; i < n; i++) s += Math.sqrt(i); return s; }',
  "tracer.startActiveSpan('main-work', (root) => {",
  "  root.setAttribute('input.size', 3);",
  "  tracer.startActiveSpan('step-one', (span) => {",
  '    busy(100000);',
  "    span.setAttribute('answer', 42);",
  "    span.addEvent('checkpoint');",
  '    span.end();',
  '  });',
  "  tracer.startActiveSpan('step-two', (span) => {",
  '    busy(50000);',
  "    span.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });",
  '    span.end();',
  '  });',
  '  root.end();',
  '});',
  "console.log('after the trace');",
].join('\n');

async function expectWaterfall(page, output) {
  // The program's own output is kept; the sentinel line is stripped out.
  expect(output).toContain('after the trace');
  expect(output).not.toContain('__PBIN_OTEL_TRACE__');

  // The run surfaces the trace tab; the waterfalls live in its document.
  await expect(page.locator('#paneTabTrace')).toBeVisible();
  await page.click('#paneTabTrace');

  // The waterfall: a header naming the root span, one row per span.
  const panel = page.locator('.pb-trace');
  await expect(panel).toHaveCount(1);
  await expect(panel.locator('.pb-trace-title')).toHaveText('main-work');
  await expect(panel.locator('.pb-trace-row--span')).toHaveCount(3);
  await expect(panel).toContainText('step-one');
  await expect(panel).toContainText('step-two');
  await expect(panel.locator('.pb-trace-evt')).toHaveCount(1); // the checkpoint event

  // Clicking a row opens its details (attributes, status); clicking again
  // closes them.
  await panel.locator('.pb-trace-row--span', { hasText: 'step-one' }).click();
  await expect(panel.locator('.pb-trace-details')).toContainText('answer');
  await expect(panel.locator('.pb-trace-details')).toContainText('42');
  await panel.locator('.pb-trace-row--span', { hasText: 'step-one' }).click();
  await expect(panel.locator('.pb-trace-details')).toHaveCount(0);
  await panel.locator('.pb-trace-row--span', { hasText: 'step-two' }).click();
  await expect(panel.locator('.pb-trace-details')).toContainText('ERROR: boom');
}

test('a JavaScript paste with spans renders a waterfall', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, TRACED(false));
  const output = await run(page);
  await expectWaterfall(page, output);
});

test('a TypeScript paste with spans renders a waterfall', async ({ page }) => {
  await openRoom(page, 'typescript');
  await setCode(page, TRACED(true));
  const output = await run(page);
  await expectWaterfall(page, output);
});

test('a debugger run returns its traces too', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, TRACED(false));
  // Run in debugger mode: the run completes on the instrumented worker,
  // which hands traces back on its result message. Pause-on-exception is
  // turned on because with no breakpoints and without it, a debug run
  // pauses on the first line (debug.js) — here it runs straight through.
  await page.evaluate(() => {
    window.PbinDebug.setRunMode('debug');
    window.PbinDebug.setPauseOnException(true);
  });
  const output = await run(page);
  await expectWaterfall(page, output);
});

test('a paste without the import is untouched', async ({ page }) => {
  await openRoom(page, 'javascript');
  await setCode(page, "console.log('no tracing here');");
  const output = await run(page);
  expect(output).toContain('no tracing here');
  await expect(page.locator('.pb-trace')).toHaveCount(0);
  await expect(page.locator('#paneTabTrace')).toBeHidden();
});
