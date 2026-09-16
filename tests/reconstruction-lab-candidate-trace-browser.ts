/** Saved actual observation diagnostics; no AI or placement accuracy claim. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const inputPath = 'test-results/reconstruction-placement-quality-20260914/before-run-01/user-03/result.json';
const inputBytes = await readFile(inputPath);
const saved = JSON.parse(inputBytes.toString('utf8'));
const rawReview = {
  ...saved.currentReview,
  candidates: saved.originalRawCandidates,
  planes: saved.originalPlanes,
};
const report = {
  review: saved.currentReview,
  rawReview,
  rawSegmentationCandidates: saved.rawSegmentationCandidates,
  fixtures: saved.project.shared.comparison.before.fixtures,
};
const selected = report.review.candidates.find(
  (candidate: { kind: string; placementReview?: { status: string } }) =>
    candidate.kind === 'basin' && candidate.placementReview?.status === 'held',
);
assert.ok(selected, 'saved actual user03 must contain the held basin');
const files = [
  'src/lib/reconstruction/lab-candidate-trace.ts',
  'src/components/reconstruction/lab-candidate-trace.tsx',
];
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hashes = Object.fromEntries(
  await Promise.all(files.map(async (path) => [path, digest(await readFile(path))])),
);
const out =
  'test-results/reconstruction-placement-quality-20260914/candidate-trace-ui/' +
  new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(out, { recursive: true });
const contents = [
  "import React from 'react'; import {createRoot} from 'react-dom/client';",
  "import {LabCandidateTracePanel} from './src/components/reconstruction/lab-candidate-trace';",
  "import {labCandidateTraces} from './src/lib/reconstruction/lab-candidate-trace';",
  'const report=' + JSON.stringify(report) + ';const original=JSON.stringify(report);',
  'window.readTraceState=()=>({unchanged:JSON.stringify(report)===original,traces:labCandidateTraces(report)});',
  "createRoot(document.getElementById('root')).render(<LabCandidateTracePanel report={report}/>);",
].join('\n');
const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const script = bundle.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.end(script);
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><meta charset="utf-8"><style>body{font:15px sans-serif;line-height:1.6;margin:12px}summary{cursor:pointer}li{margin:8px 0}pre{background:#f5f5f5;padding:8px}p{overflow-wrap:anywhere}#root{min-width:0}</style><div id="root"></div><script src="/app.js"></script>',
    );
  }
});
await new Promise<void>((resolve) => server.listen(43193, '127.0.0.1', resolve));
let browser;
const errors: string[] = [],
  external: string[] = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:43193/')) external.push(request.url());
  });
  await page.addInitScript(() => {
    (window as unknown as { workerCalls: number }).workerCalls = 0;
    class NoWorker {
      constructor() {
        (window as unknown as { workerCalls: number }).workerCalls++;
        throw Error('diagnostics must not run AI');
      }
    }
    Object.defineProperty(window, 'Worker', { value: NoWorker });
  });
  await page.goto('http://127.0.0.1:43193/');
  const panel = page.getByTestId('lab-candidate-traces');
  await panel.locator(':scope > summary').click();
  const candidate = panel.locator('[data-candidate-trace="' + selected.id + '"]');
  await candidate.locator(':scope > summary').click();
  await expect(candidate.locator('[data-trace-stage]')).toHaveCount(7);
  await expect(candidate.locator('[data-trace-stage="observation"]')).toHaveAttribute(
    'data-trace-status',
    'recorded',
  );
  await expect(candidate.locator('[data-trace-stage="placement"]')).toHaveAttribute(
    'data-trace-status',
    'recorded',
  );
  const bounds = candidate.locator('[data-trace-stage="bounds"]');
  await expect(bounds).toHaveAttribute('data-trace-status', 'held');
  await bounds.locator('summary').click();
  await expect(bounds).toContainText('원사진 카메라 재투영 오차가 아니에요');
  await expect(candidate.locator('[data-trace-stage="generation"]')).toHaveAttribute(
    'data-trace-status',
    'not-run',
  );
  const placement = candidate.locator('[data-trace-stage="placement"]');
  await placement.locator('summary').click();
  const displayed = JSON.parse((await placement.locator('pre').textContent())!);
  assert.equal(displayed.output.requested.u, selected.placementReview.requested.u);
  assert.equal(displayed.output.requested.widthMm, selected.placementReview.requested.widthMm);
  await page.screenshot({ path: out + '/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    '390px fits',
  );
  await page.screenshot({ path: out + '/mobile.png', fullPage: true });
  const state = (await page.evaluate(() => {
    const w = window as unknown as { readTraceState: () => unknown; workerCalls: number };
    return { data: w.readTraceState(), workers: w.workerCalls };
  })) as { data: { unchanged: boolean; traces: unknown[] }; workers: number };
  assert.ok(state.data.unchanged);
  assert.equal(state.workers, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const after = Object.fromEntries(
    await Promise.all(files.map(async (path) => [path, digest(await readFile(path))])),
  );
  assert.deepEqual(hashes, after, 'production source stable during diagnostics test');
  await writeFile(
    out + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Saved actual user03 observations through production read-only candidate diagnostic component; no AI and no placement accuracy claim',
        inputPath,
        inputSha256: digest(inputBytes),
        sourceHashes: hashes,
        sourceHashesUnchanged: true,
        selectedCandidateId: selected.id,
        recordedCandidateCount: state.data.traces.length,
        checks: [
          'seven stages',
          'held physical bounds',
          'original requested coordinates',
          'source-camera distinction',
          'generation stopped',
          'no document mutation',
          '390px fits',
        ],
        workers: state.workers,
        errors,
        external,
      },
      null,
      2,
    ),
  );
  await writeFile(out + '/traces.json', JSON.stringify(state.data.traces, null, 2));
  console.log(
    JSON.stringify({
      ok: true,
      out,
      selectedCandidateId: selected.id,
      candidateCount: state.data.traces.length,
    }),
  );
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
