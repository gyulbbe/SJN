/** Opt-in primary full-photo semantic label capture; private local geometry evaluation only. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const manifestPath = process.env.SEMANTIC_LABELS_MANIFEST;
if (!manifestPath) throw Error('Set SEMANTIC_LABELS_MANIFEST to the private case list.');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const cases: { id: string; path: string }[] = (Array.isArray(manifest) ? manifest : manifest.cases).map(
  (item: { id: string; path?: string; input?: { path: string } }) => ({
    id: item.id,
    path: item.path ?? item.input?.path,
  }),
);
assert(Array.isArray(cases) && cases.length > 0 && cases.length <= 20);
assert(cases.every((item) => /^[a-z0-9-]+$/.test(item.id) && typeof item.path === 'string'));
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
const output = resolve(
  process.env.SEMANTIC_LABELS_OUTPUT ?? 'test-results/reconstruction-object-surfaces-20260913/labels',
);
const scoped = relative(resolve('test-results'), output);
assert(scoped && !scoped.startsWith('..') && !isAbsolute(scoped));
const entries = await Promise.all(cases.map(async (item) => ({ ...item, bytes: await readFile(item.path) })));
const entry = await build({
  stdin: {
    contents:
      "export {segmentRoom} from './src/lib/segmentation'; export {reviewFromSegmentation} from './src/lib/reconstruction/analysis';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const worker = await build({
  entryPoints: ['src/lib/segmentation/worker.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
await mkdir(output, { recursive: true });
const sourceFiles = [
  'src/lib/segmentation/index.ts',
  'src/lib/reconstruction/analysis.ts',
  'src/lib/reconstruction/observed-placement.ts',
  'src/lib/reconstruction/installation.ts',
  'src/lib/segmentation/worker.ts',
  'src/lib/reconstruction/lab-engine.ts',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (path) => [
      path,
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ]),
  ),
);
const publicRoot = resolve('public');
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (path === '/')
      return void res
        .setHeader('Content-Type', 'text/html')
        .end('<html><head><link rel="icon" href="data:,"></head><body>Local geometry evidence</body></html>');
    if (path === '/index.js' || path === '/worker.ts')
      return void res
        .setHeader('Content-Type', 'text/javascript')
        .end(path === '/index.js' ? entry.outputFiles[0].text : worker.outputFiles[0].text);
    const input = entries.find((item) => path === '/input/' + item.id);
    if (input) return void res.setHeader('Content-Type', 'image/jpeg').end(input.bytes);
    const file = resolve(publicRoot, '.' + path);
    assert(!relative(publicRoot, file).startsWith('..'));
    res.setHeader(
      'Content-Type',
      extname(file) === '.wasm'
        ? 'application/wasm'
        : extname(file) === '.json'
          ? 'application/json'
          : 'application/octet-stream',
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const summary: unknown[] = [];
try {
  for (const item of entries) {
    const directory = resolve(output, item.id);
    await mkdir(directory, { recursive: true });
    const page = await browser.newPage();
    const errors: string[] = [],
      external: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:'))
        return route.continue();
      external.push(url);
      return route.abort();
    });
    try {
      await page.goto(origin);
      const capture = await page.evaluate(
        async ({ origin, id }) => {
          const api = await import(origin + '/index.js');
          const blob = await (await fetch('/input/' + id)).blob();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 180_000);
          const started = performance.now();
          const stages: { message: string; elapsedMs: number }[] = [];
          try {
            const masks = await api.segmentRoom(
              blob,
              (message: string) => stages.push({ message, elapsedMs: performance.now() - started }),
              { signal: controller.signal, captureSemanticLabels: true },
            );
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(masks.width, masks.height),
              context = canvas.getContext('2d')!;
            context.drawImage(bitmap, 0, 0, masks.width, masks.height);
            bitmap.close();
            const rgba = context.getImageData(0, 0, masks.width, masks.height).data;
            const room = { kind: 'parametric', version: 1, widthMm: 2400, depthMm: 2400, heightMm: 2400 };
            const analysisStart = performance.now();
            const review = api.reviewFromSegmentation(masks, rgba, room);
            const analysisMs = performance.now() - analysisStart;
            const to64 = (bytes: Uint8Array | Uint8ClampedArray) =>
              new Promise<string>((done, fail) => {
                const reader = new FileReader();
                reader.onload = () => done((reader.result as string).split(',')[1]);
                reader.onerror = () => fail(reader.error);
                reader.readAsDataURL(new Blob([bytes.slice().buffer as ArrayBuffer]));
              });
            return {
              width: masks.width,
              height: masks.height,
              room,
              review,
              objects: masks.objects,
              semanticLabels: await to64(masks.semanticLabels),
              floor: await to64(masks.floor),
              wall: await to64(masks.wall),
              rgba: await to64(rgba),
              analysisMs,
              totalMs: performance.now() - started,
              stages,
              browser: navigator.userAgent,
            };
          } finally {
            clearTimeout(timer);
            controller.abort();
          }
        },
        { origin, id: item.id },
      );
      const labelBytes = Buffer.from(capture.semanticLabels, 'base64');
      assert.equal(labelBytes.length, capture.width * capture.height);
      await writeFile(resolve(directory, 'semantic-labels.u8'), labelBytes);
      for (const kind of ['floor', 'wall'] as const) {
        const bytes = Buffer.from(capture[kind], 'base64');
        assert.equal(bytes.length, capture.width * capture.height);
        await writeFile(resolve(directory, `${kind}.u8`), bytes);
        await sharp(bytes, { raw: { width: capture.width, height: capture.height, channels: 1 } })
          .png()
          .toFile(resolve(directory, `${kind}.png`));
      }
      await writeFile(resolve(directory, 'photo.rgba'), Buffer.from(capture.rgba, 'base64'));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      assert(
        capture.review.planes
          .filter((p: { face: string }) => p.face === 'floor')
          .every((p: { geometrySource: string }) => p.geometrySource === 'visible-floor-region'),
      );
      const report = {
        ...capture,
        semanticLabels: undefined,
        labelSha256: createHash('sha256').update(labelBytes).digest('hex'),
        capturePass: 'primary-full-photo-only',
        floor: undefined,
        wall: undefined,
        rgba: undefined,
        id: item.id,
        inputSha256: createHash('sha256').update(item.bytes).digest('hex'),
        sourceHashes,
        errors,
        external,
        scope:
          'Actual first full-photo DeepLab semantic labels. No flip/crop inference, no Qwen, no calibration or physical-depth assertion.',
      };
      await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
      summary.push({
        id: item.id,
        status: 'complete',
        totalMs: capture.totalMs,
        planes: capture.review.planes.length,
        objects: capture.objects?.length,
      });
    } catch (error) {
      const failure = { id: item.id, status: 'failed', error: String(error), errors, external };
      await writeFile(resolve(directory, 'failure.json'), JSON.stringify(failure, null, 2));
      summary.push(failure);
    } finally {
      await page.close();
    }
    await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary.at(-1)));
  }
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
assert(summary.every((item) => (item as { status: string }).status === 'complete'));
