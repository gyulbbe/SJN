/** Opt-in real FP32 model execution. All photo bytes stay on loopback; no mocks. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';

const output = resolve(
  process.env.MOGE_TEST_OUTPUT ??
    `test-results/moge-browser/${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile('tests/fixtures/reconstruction-corpus-v1.json', 'utf8'));
const fixture = manifest.cases.find(
  (x: { id: string }) => x.id === (process.env.MOGE_TEST_CASE ?? 'bath-01'),
);
const photo = await readFile(resolve(fixture.input.path));
const workerFile = resolve(output, 'worker.js');
await build({
  entryPoints: ['src/lib/reconstruction/moge-browser/worker.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: workerFile,
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_MOGE_MODEL_URL': 'undefined' },
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
  define: { 'process.env.NEXT_PUBLIC_MOGE_MODEL_URL': 'undefined' },
  logLevel: 'warning',
});
const report: Record<string, unknown> = {
  fixture: fixture.id,
  photoSha256: fixture.input.sha256,
  output,
  cpu: cpus()[0].model,
  hostMemoryBytes: totalmem(),
  implementation: 'real-model-no-mocks',
  runs: [],
};
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && /^\/capture\/[a-z0-9-]+\.(bin|json)$/.test(req.url ?? '')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      await writeFile(resolve(output, req.url!.split('/').pop()!), Buffer.concat(chunks));
      res.end('ok');
      return;
    }
    if (req.url === '/photo') {
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(photo);
      return;
    }
    if (req.url === '/client.js' || req.url === '/worker.ts') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(req.url === '/worker.ts' ? workerFile : resolve(output, 'client.js')));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body><div id="status">MoGe real model verification</div></body></html>');
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address() as { port: number };
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: process.env.MOGE_TEST_DISABLE_GPU === '1' ? ['--disable-gpu', '--disable-webgpu'] : [],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (message) => console.log('browser:', message.text().slice(0, 700)));
  page.on('pageerror', (error) => console.log('pageerror:', error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  report.browser = await page.evaluate(async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: unknown } | null> } })
      .gpu;
    const adapter = await gpu?.requestAdapter();
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      isolated: crossOriginIsolated,
      adapter: adapter?.info ? JSON.parse(JSON.stringify(adapter.info)) : null,
    };
  });
  // Capture exactly the browser canvas RGB NCHW used by the worker for a Python FP32 comparison.
  await page.evaluate(async () => {
    const blob = await (await fetch('/photo')).blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale),
      height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height),
      ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data,
      area = width * height,
      rgb = new Float32Array(area * 3);
    for (let i = 0; i < area; i++) for (let c = 0; c < 3; c++) rgb[c * area + i] = rgba[i * 4 + c] / 255;
    await fetch('/capture/input.bin', { method: 'POST', body: rgb });
    await fetch('/capture/input.json', {
      method: 'POST',
      body: JSON.stringify({
        width,
        height,
        numTokens: 1200,
        sourceWidth: bitmap.width,
        sourceHeight: bitmap.height,
      }),
    });
    bitmap.close();
  });
  for (const mode of (process.env.MOGE_TEST_MODES ?? 'webgpu,wasm').split(',').filter(Boolean)) {
    console.log('MOGE mode', mode);
    const result = await page.evaluate(async (mode) => {
      const modulePath = '/client.js';
      const { MogeBrowserClient } = await import(modulePath);
      const client = new MogeBrowserClient();
      const progress: unknown[] = [];
      try {
        const result = await client.run(await (await fetch('/photo')).blob(), {
          mode,
          timeoutMs: 600_000,
          onProgress: (p: { stage: string; loaded?: number; total?: number }) => {
            if (p.stage !== 'downloading' || p.loaded === p.total)
              console.log('MoGe', p.stage, JSON.stringify(p));
            progress.push(p);
          },
        });
        for (const field of ['points', 'normal', 'mask'])
          await fetch(`/capture/${mode}-raw-${field}.bin`, { method: 'POST', body: result.raw[field] });
        for (const field of ['points', 'normal', 'mask', 'depth'])
          await fetch(`/capture/${mode}-dense-${field}.bin`, { method: 'POST', body: result.dense[field] });
        const summary = {
          backend: result.backend,
          requestedMode: result.requestedMode,
          cacheSource: result.cacheSource,
          cacheNotice: result.cacheNotice,
          fallbackReason: result.fallbackReason,
          metadata: result.metadata,
          timings: result.timings,
          raw: { width: result.raw.width, height: result.raw.height, metricScale: result.raw.metricScale },
          diagnostics: result.dense.diagnostics,
          intrinsics: result.dense.intrinsics,
        };
        await fetch(`/capture/${mode}-result.json`, {
          method: 'POST',
          body: JSON.stringify(summary, null, 2),
        });
        return { status: 'success', ...summary, progress };
      } catch (error) {
        return { status: 'failed', error: String(error), progress };
      } finally {
        client.dispose();
      }
    }, mode);
    (report.runs as unknown[]).push(result);
    console.log(JSON.stringify(result).slice(0, 4000));
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  await page.screenshot({ path: resolve(output, 'browser.png') });
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
console.log('MOGE_REPORT', output);
