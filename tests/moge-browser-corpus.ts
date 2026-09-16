/** Real geometry-only browser regression. Photos never leave loopback; Gemma is not called. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';

const output = resolve(
  process.env.MOGE_TEST_OUTPUT ??
    `test-results/moge-geometry/${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
await mkdir(output, { recursive: true });
const userManifest = JSON.parse(
  await readFile('test-results/reconstruction-quality-next/fifteen-photo-manifest.json', 'utf8'),
);
const commons = JSON.parse(await readFile('tests/fixtures/reconstruction-corpus-v1.json', 'utf8'));
type Photo = { id: string; path: string; sha256: string };
const available: Photo[] = [
  ...userManifest.files,
  ...commons.cases.map((x: { id: string; input: Omit<Photo, 'id'> }) => ({ id: x.id, ...x.input })),
];
const selected = (process.env.MOGE_TEST_CASES ?? userManifest.files.map((x: Photo) => x.id).join(',')).split(
  ',',
);
const fixtures = available.filter((x) => selected.includes(x.id));
if (fixtures.length !== selected.length) throw new Error('Unknown or duplicate MoGe test fixture');
const photos = new Map<string, Buffer>();
for (const fixture of fixtures) {
  const bytes = await readFile(fixture.path);
  if (createHash('sha256').update(bytes).digest('hex') !== fixture.sha256)
    throw new Error(`Changed original photo ${fixture.id}`);
  photos.set(fixture.id, bytes);
  await mkdir(resolve(output, fixture.id), { recursive: true });
}
const define = {
  'process.env.NEXT_PUBLIC_MOGE_MODEL_URL': 'undefined',
  'process.env.NODE_ENV': '"production"',
};
for (const [entry, name] of [
  ['src/lib/reconstruction/moge-browser/worker.ts', 'moge-worker.js'],
  ['src/lib/segmentation/worker.ts', 'seg-worker.js'],
])
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outfile: resolve(output, name),
    define,
    logLevel: 'warning',
  });
for (const [source, name] of [
  ["export {MogeBrowserClient} from './src/lib/reconstruction/moge-browser/client';", 'moge-client.js'],
  ["export {segmentRoom} from './src/lib/segmentation';", 'seg-client.js'],
])
  await build({
    stdin: { contents: source, resolveDir: process.cwd() },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outfile: resolve(output, name),
    define,
    logLevel: 'warning',
  });
const served = new Map([
  ['/moge/client.js', 'moge-client.js'],
  ['/moge/worker.ts', 'moge-worker.js'],
  ['/seg/client.js', 'seg-client.js'],
  ['/seg/worker.ts', 'seg-worker.js'],
]);
const isolated = process.env.MOGE_TEST_ISOLATED === '1';
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (isolated) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    if (req.method === 'POST' && /^\/capture\/[a-z0-9-]+\/[a-z0-9-]+\.(bin|json|png)$/.test(path)) {
      const [, , id, file] = path.split('/');
      if (!photos.has(id)) throw new Error('Unknown fixture');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      await writeFile(resolve(output, id, file), Buffer.concat(chunks));
      res.end('ok');
      return;
    }
    if (path.startsWith('/photo/')) {
      const bytes = photos.get(path.slice(7));
      if (!bytes) throw new Error('Unknown photo');
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(bytes);
      return;
    }
    if (served.has(path)) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(resolve(output, served.get(path)!)));
      return;
    }
    if (path.startsWith('/models/deeplab-ade20k/') || path.startsWith('/models/tfjs-wasm/')) {
      const local = resolve('public', '.' + path);
      if (relative(resolve('public/models'), local).startsWith('..')) throw new Error('Unsafe static path');
      res.setHeader(
        'Content-Type',
        extname(local) === '.wasm'
          ? 'application/wasm'
          : extname(local) === '.json'
            ? 'application/json'
            : 'application/octet-stream',
      );
      res.end(await readFile(local));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<html><head><meta charset="utf-8"><style>body{background:#13202c;color:white;font:14px sans-serif}figure{margin:12px}img{width:100%;max-width:1400px}pre{white-space:pre-wrap}</style></head><body><h2>MoGe + DeepLab 실제 형상 분석 (Gemma 미호출)</h2><main id="results"></main></body></html>',
    );
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const args = process.env.MOGE_TEST_DISABLE_GPU === '1' ? ['--disable-gpu', '--disable-webgpu'] : [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
const report: Record<string, unknown> = {
  scope: 'geometry-only-real-DeepLab-and-MoGe-no-Gemma-no-cloud-photo-upload',
  fixtures,
  cpu: cpus()[0].model,
  hostMemoryBytes: totalmem(),
  launchArgs: args,
  requestedIsolation: isolated,
  runs: [],
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('console', (message) => console.log('browser', message.text().slice(0, 700)));
  await page.goto(`http://127.0.0.1:${port}`);
  report.browser = await page.evaluate(async () => {
    const adapter = await (
      navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info: Record<string, string> } | null> } }
    ).gpu?.requestAdapter();
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      isolated: crossOriginIsolated,
      gpu: adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          }
        : null,
    };
  });
  for (const fixture of fixtures) {
    const modes = (process.env.MOGE_TEST_MODES ?? 'webgpu').split(',');
    console.log('MOGE_GEOMETRY', fixture.id, modes.join(','));
    const rows = await page.evaluate(
      async ({ fixture, modes }) => {
        const mogePath = '/moge/client.js',
          segPath = '/seg/client.js';
        const { MogeBrowserClient } = await import(mogePath),
          { segmentRoom } = await import(segPath);
        const blob = await (await fetch(`/photo/${fixture.id}`)).blob(),
          bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        const controller = new AbortController(),
          segmentationStarted = performance.now();
        // Dedicated segmentation worker terminates before the MoGe session is created.
        const segmentation = await segmentRoom(blob, undefined, {
          signal: controller.signal,
          quality: 'reconstruction',
        });
        const segmentationMs = performance.now() - segmentationStarted;
        const metadata = {
          version: 1,
          inputFingerprint: fixture.sha256,
          image: { width: bitmap.width, height: bitmap.height },
          mask: { width: segmentation.width, height: segmentation.height },
          regions: (segmentation.objects ?? []).map((x: { id: string; kind: string; bounds: unknown }) => ({
            id: 'seg-' + x.id,
            kind: x.kind,
            bounds: x.bounds,
            source: 'segmentation',
          })),
        };
        const save = (name: string, body: BodyInit) =>
          fetch(`/capture/${fixture.id}/${name}`, { method: 'POST', body });
        await save('metadata.json', JSON.stringify(metadata));
        await save('semantic-floor.bin', segmentation.floor);
        await save('semantic-wall.bin', segmentation.wall);
        // Exact CPU-canvas preprocessing used by MoGe, for a later offline Python FP32 reference.
        const ratio = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height)),
          width = Math.round(bitmap.width * ratio),
          height = Math.round(bitmap.height * ratio);
        const inputCanvas = new OffscreenCanvas(width, height),
          inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true })!;
        inputCtx.fillStyle = '#fff';
        inputCtx.fillRect(0, 0, width, height);
        inputCtx.imageSmoothingEnabled = true;
        inputCtx.imageSmoothingQuality = 'high';
        inputCtx.drawImage(bitmap, 0, 0, width, height);
        const rgba = inputCtx.getImageData(0, 0, width, height).data,
          area = width * height,
          rgb = new Float32Array(area * 3);
        for (let i = 0; i < area; i++) for (let c = 0; c < 3; c++) rgb[c * area + i] = rgba[i * 4 + c] / 255;
        await save('input.bin', rgb);
        await save(
          'input.json',
          JSON.stringify({
            width,
            height,
            numTokens: 1200,
            sourceWidth: bitmap.width,
            sourceHeight: bitmap.height,
          }),
        );
        const rows = [];
        for (const mode of modes) {
          const client = new MogeBrowserClient();
          try {
            const result = await client.run(blob, {
              mode,
              geometry: { metadata, floor: segmentation.floor, wall: segmentation.wall },
              onProgress: (p: { stage: string }) => {
                if (p.stage === 'inference' || p.stage === 'planes') console.log(fixture.id, mode, p.stage);
              },
            });
            for (const name of ['points', 'normal', 'mask'])
              await save(`${mode}-raw-${name}.bin`, result.raw[name]);
            for (const name of ['points', 'normal', 'mask', 'depth'])
              await save(`${mode}-dense-${name}.bin`, result.dense[name]);
            for (const name of ['floor', 'wall', 'excluded'])
              await save(`${mode}-labels-${name}.bin`, result.planes.labels[name]);
            const row = {
              id: fixture.id,
              status: 'success',
              segmentationMs,
              backend: result.backend,
              requestedMode: result.requestedMode,
              cacheSource: result.cacheSource,
              fallbackReason: result.fallbackReason,
              metadata: result.metadata,
              timings: result.timings,
              raw: { width, height, metricScale: result.raw.metricScale },
              intrinsics: result.dense.intrinsics,
              diagnostics: result.dense.diagnostics,
              floor: result.planes.floor,
              walls: result.planes.walls,
              evidence: result.planes.evidence,
              semanticRegions: metadata.regions.length,
            };
            await save(`${mode}-result.json`, JSON.stringify(row, null, 2));
            const preview = document.createElement('canvas');
            preview.width = width * 4;
            preview.height = height;
            const ctx = preview.getContext('2d')!;
            ctx.drawImage(bitmap, 0, 0, width, height);
            const depth = [...(result.dense.depth as Float32Array)]
                .filter(Number.isFinite)
                .sort((a, b) => a - b),
              near = depth[Math.floor(depth.length * 0.02)],
              far = depth[Math.floor(depth.length * 0.98)];
            for (let panel = 1; panel <= 3; panel++) {
              const pixels = ctx.createImageData(width, height);
              for (let i = 0; i < area; i++) {
                if (!result.dense.mask[i]) {
                  pixels.data[i * 4 + 3] = 255;
                  continue;
                }
                if (panel === 1) {
                  const d = Math.max(0, Math.min(1, (result.dense.depth[i] - near) / (far - near || 1)));
                  pixels.data[i * 4] = 255 * (1 - d);
                  pixels.data[i * 4 + 1] = 255 * (1 - Math.abs(d * 2 - 1));
                  pixels.data[i * 4 + 2] = 255 * d;
                } else if (panel === 2)
                  for (let c = 0; c < 3; c++)
                    pixels.data[i * 4 + c] = (result.dense.normal[i * 3 + c] + 1) * 127.5;
                else {
                  const x = i % width,
                    y = Math.floor(i / width),
                    k =
                      Math.min(
                        segmentation.height - 1,
                        Math.floor(((y + 0.5) * segmentation.height) / height),
                      ) *
                        segmentation.width +
                      Math.min(segmentation.width - 1, Math.floor(((x + 0.5) * segmentation.width) / width));
                  const floor = result.planes.labels.floor[k],
                    wall = result.planes.labels.wall[k];
                  if (floor > 0) {
                    pixels.data[i * 4 + 1] = 220;
                    pixels.data[i * 4 + 2] = 120;
                  } else if (wall > 0) {
                    pixels.data[i * 4] = 80 + wall * 9;
                    pixels.data[i * 4 + 1] = 60 + wall * 7;
                    pixels.data[i * 4 + 2] = 230;
                  }
                }
                pixels.data[i * 4 + 3] = 255;
              }
              ctx.putImageData(pixels, panel * width, 0);
            }
            const png = await new Promise<Blob>((done) => preview.toBlob((b) => done(b!), 'image/png'));
            await save(`${mode}-preview.png`, png);
            const figure = document.createElement('figure'),
              caption = document.createElement('figcaption'),
              img = document.createElement('img');
            caption.textContent = `${fixture.id} · ${mode} · 원본 / 깊이 / 법선 / 관측 평면 · ${result.planes.walls.length} walls · floor ${!!result.planes.floor}`;
            img.src = URL.createObjectURL(png);
            figure.append(caption, img);
            document.querySelector('#results')!.append(figure);
            rows.push(row);
          } catch (error) {
            const row = { id: fixture.id, mode, status: 'failed', error: String(error) };
            await save(`${mode}-error.json`, JSON.stringify(row));
            rows.push(row);
          } finally {
            client.dispose();
          }
        }
        bitmap.close();
        return rows;
      },
      { fixture, modes },
    );
    (report.runs as unknown[]).push(...rows);
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      'MOGE_GEOMETRY_RESULT',
      fixture.id,
      JSON.stringify(
        rows.map((x) => ({
          status: x.status,
          ...('timings' in x
            ? { timings: x.timings, floor: !!x.floor, walls: x.walls.length }
            : { error: x.error }),
        })),
      ),
    );
  }
  await page.screenshot({ path: resolve(output, 'contact-sheet.png'), fullPage: true });
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
console.log('MOGE_GEOMETRY_REPORT', output);
