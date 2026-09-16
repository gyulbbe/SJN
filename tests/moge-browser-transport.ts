/** Real browser/Worker transport failure tests; HTTP failure bodies are controlled fixtures, no inference. */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { MOGE_ARTIFACT } from '../src/lib/reconstruction/moge-browser/artifact';

const output = resolve(process.env.MOGE_TEST_OUTPUT ?? 'test-results/moge-transport');
await mkdir(output, { recursive: true });
const define = {
  'process.env.NEXT_PUBLIC_MOGE_MODEL_URL': 'undefined',
  'process.env.NODE_ENV': '"production"',
};
await build({
  entryPoints: ['src/lib/reconstruction/moge-browser/worker.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: resolve(output, 'worker.js'),
  define,
  logLevel: 'warning',
});
await build({
  stdin: {
    contents: "export {MogeBrowserClient} from './src/lib/reconstruction/moge-browser/client';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: resolve(output, 'client.js'),
  define,
  logLevel: 'warning',
});
const requests: Record<string, number> = { failure: 0, corrupt: 0, slow: 0 };
let cancelledConnectionClosed = false;
const server = createServer(async (req, res) => {
  if (req.url === '/failure') {
    requests.failure++;
    res.statusCode = 503;
    res.end('fixture service unavailable');
    return;
  }
  if (req.url === '/corrupt') {
    requests.corrupt++;
    res.setHeader('Content-Length', '3');
    res.end('bad');
    return;
  }
  if (req.url === '/slow') {
    requests.slow++;
    res.setHeader('Content-Length', String(MOGE_ARTIFACT.bytes));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.write(Buffer.alloc(8192));
    const timer = setInterval(() => res.write(Buffer.alloc(1024)), 500);
    res.on('close', () => {
      clearInterval(timer);
      cancelledConnectionClosed = true;
    });
    return;
  }
  if (req.url === '/worker.ts' || req.url === '/client.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await readFile(resolve(output, req.url === '/worker.ts' ? 'worker.js' : 'client.js')));
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<html><body>MoGe browser failure fixtures</body></html>');
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report: Record<string, unknown> = {
  scope: 'real-browser-worker-controlled-http-no-model-inference',
  checks: [],
};
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  for (const fixture of ['failure', 'corrupt', 'slow']) {
    const result = await page.evaluate(async (fixture) => {
      const path = '/client.js',
        { MogeBrowserClient } = await import(path);
      const client = new MogeBrowserClient(),
        controller = new AbortController();
      const canvas = new OffscreenCanvas(64, 64);
      canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const progress: { stage: string; loaded?: number }[] = [];
      try {
        await client.run(blob, {
          mode: 'auto',
          modelUrl: new URL('/' + fixture, location.origin).href,
          signal: controller.signal,
          onProgress: (p: { stage: string; loaded?: number }) => {
            progress.push(p);
            if (fixture === 'slow' && p.stage === 'downloading' && (p.loaded ?? 0) > 0) controller.abort();
          },
        });
        return { fixture, rejected: false, progress };
      } catch (error) {
        return {
          fixture,
          rejected: true,
          name: error instanceof Error ? error.name : '',
          message: String(error),
          progress,
        };
      } finally {
        client.dispose();
      }
    }, fixture);
    assert.equal(result.rejected, true);
    assert.equal(
      result.progress.some((p) => p.stage === 'initializing'),
      false,
      'a model download failure must not initialize a GPU/CPU retry',
    );
    if (fixture === 'slow') assert.equal(result.name, 'AbortError');
    (report.checks as unknown[]).push(result);
  }
  await page.waitForTimeout(500);
  assert.deepEqual(requests, { failure: 1, corrupt: 1, slow: 1 });
  assert.equal(cancelledConnectionClosed, true, 'worker cancellation must close the streaming request');
  report.requests = requests;
  report.cancelledConnectionClosed = cancelledConnectionClosed;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
