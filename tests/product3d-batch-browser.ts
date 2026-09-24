/**
 * Product photos → AI background removal → TripoSR 360° reconstruction → before/after captures:
 *   node tests/run-browser-test.mjs tests/product3d-batch-browser.ts
 * Runs the production workers in Chrome (WebGPU) with the pinned models served from disk:
 * tmp/multiview-model (TripoSR) and tmp/background-model/model_fp16.onnx (BiRefNet), see
 * docs/product3d-editor.md. Photos come from SJN_PRODUCT3D_BATCH_INPUT (default
 * test-results/product3d-batch/input); each photo gets test-results/product3d-batch/<name>/ and the run
 * writes summary.json. SJN_PRODUCT3D_BATCH_CPU=<name> also times the CPU (wasm) path for that photo.
 * SJN_PRODUCT3D_BATCH_RERENDER=1 skips the AI steps and re-captures the saved meshes (for renderer changes).
 */
import { chromium } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { estimateAlbedo } from '../src/lib/product3d/albedo';
import { meshVolume, surfaceRoughness } from '../src/lib/product3d/mesh-cleanup';

type Background = typeof import('../src/lib/background-removal/client');
type Product = typeof import('../src/lib/product3d/client') & typeof import('./helpers/product3d-capture');
type Cutouts = Window & { cutouts?: Record<string, Blob> };

const input = path.resolve(process.env.SJN_PRODUCT3D_BATCH_INPUT ?? 'test-results/product3d-batch/input');
const output = path.resolve('test-results/product3d-batch');
const models = [
  path.resolve('tmp/background-model'),
  path.resolve(process.env.SJN_PRODUCT3D_MODELS ?? 'tmp/multiview-model'),
];
const runtime = path.resolve('node_modules/onnxruntime-web/dist');
const cpuPhoto = process.env.SJN_PRODUCT3D_BATCH_CPU;
const rerender = process.env.SJN_PRODUCT3D_BATCH_RERENDER === '1';
const summaryFile = path.join(output, 'summary.json');
for (const file of [
  path.join(models[0], 'model_fp16.onnx'),
  ...['encoder', 'backbone', 'decoder'].map((part) => path.join(models[1], `${part}_fp16.onnx`)),
])
  if (!existsSync(file)) throw new Error(`Missing ${file}; see docs/product3d-editor.md.`);
const photos = readdirSync(input)
  .filter((file) => /\.(jpe?g|png|webp)$/i.test(file))
  .sort()
  .map((file) => ({ file, name: path.parse(file).name }));
if (!photos.length) throw new Error(`No photos in ${input}`);

// Each client resolves `new URL('./worker.ts', import.meta.url)`, so each gets its own folder.
const bundles = new Map<string, string>();
const entries: [string, BuildOptions][] = [
  [
    '/bg/client.js',
    {
      stdin: {
        contents: "export { BackgroundRemovalClient } from './src/lib/background-removal/client';",
        resolveDir: process.cwd(),
      },
    },
  ],
  ['/bg/worker.ts', { entryPoints: ['src/lib/background-removal/worker.ts'] }],
  [
    '/p3d/client.js',
    {
      stdin: {
        contents: `export { Product3dClient } from './src/lib/product3d/client';
          export { captureComparison } from './tests/helpers/product3d-capture';`,
        resolveDir: process.cwd(),
      },
    },
  ],
  ['/p3d/worker.ts', { entryPoints: ['src/lib/product3d/worker.ts'] }],
];
for (const [route, options] of entries) {
  const result = await build({
    ...options,
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'warning',
  });
  bundles.set(route, result.outputFiles[0].text);
}

const contentType = (file: string) =>
  file.endsWith('.wasm')
    ? 'application/wasm'
    : /\.(m?js)$/.test(file)
      ? 'text/javascript'
      : file.endsWith('.png')
        ? 'image/png'
        : /\.jpe?g$/i.test(file)
          ? 'image/jpeg'
          : file.endsWith('.webp')
            ? 'image/webp'
            : 'application/octet-stream';
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && route.startsWith('/save/')) {
      const [, , name, file] = route.split('/');
      if (!photos.some((photo) => photo.name === name) || !/^[a-z0-9-]+\.(png|bin)$/.test(file))
        throw new Error('Unexpected output path');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      mkdirSync(path.join(output, name), { recursive: true });
      writeFileSync(path.join(output, name, file), Buffer.concat(chunks));
      res.end('ok');
      return;
    }
    if (route.startsWith('/mesh/')) {
      const [, , name, field] = route.split('/');
      if (!photos.some((photo) => photo.name === name) || !['positions', 'indices', 'colors'].includes(field))
        throw new Error('Unexpected mesh path');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(readFileSync(path.join(output, name, `mesh-${field}.bin`)));
      return;
    }
    if (bundles.has(route)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(bundles.get(route));
      return;
    }
    if (route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      return;
    }
    const photo = route.startsWith('/input/')
      ? photos.find(({ file }) => file === decodeURIComponent(route.slice(7)))
      : undefined;
    const name = path.basename(route);
    const file = photo
      ? path.join(input, photo.file)
      : (name.endsWith('.onnx') ? models : [runtime]).map((dir) => path.join(dir, name)).find(existsSync);
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Content-Length': statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Photos not in this run keep their earlier entries.
const summary: Record<string, Record<string, unknown>> = existsSync(summaryFile)
  ? JSON.parse(readFileSync(summaryFile, 'utf8'))
  : {};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  // The workers fetch the pinned model and runtime URLs; answer them from disk.
  for (const pattern of [
    'https://huggingface.co/**',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**',
  ])
    await context.route(pattern, (route) =>
      route.fulfill({
        status: 307,
        headers: {
          location: `${origin}/${path.basename(new URL(route.request().url()).pathname)}`,
          'access-control-allow-origin': '*',
        },
      }),
    );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  summary.device = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const info = (adapter as { info?: { vendor: string; architecture: string; description: string } } | null)
      ?.info;
    return {
      userAgent: navigator.userAgent,
      gpu: info
        ? { vendor: info.vendor, architecture: info.architecture, description: info.description }
        : 'unavailable',
    };
  });

  // All cut-outs first, so the BiRefNet session is gone before the 666 MB TripoSR backbone loads.
  const cutouts: Record<string, unknown> = rerender
    ? {}
    : await page.evaluate(
        async ({ list, url }) => {
          const { BackgroundRemovalClient } = (await import(url)) as Background;
          const client = new BackgroundRemovalClient();
          const state = window as Cutouts;
          state.cutouts = {};
          const results: Record<string, unknown> = {};
          try {
            for (const { file, name } of list) {
              try {
                const photo = await (await fetch(`/input/${encodeURIComponent(file)}`)).blob();
                const result = await client.run(photo, () => {});
                state.cutouts[name] = result.blob;
                await fetch(`/save/${name}/cutout.png`, { method: 'POST', body: result.blob });
                results[name] = { ...result, blob: undefined, pngBytes: result.blob.size };
              } catch (error) {
                results[name] = { error: error instanceof Error ? error.message : String(error) };
              }
            }
          } finally {
            client.dispose();
          }
          return results;
        },
        { list: photos, url: '/bg/client.js' },
      );

  for (const { file, name } of photos) {
    const entry: Record<string, unknown> = rerender
      ? { ...summary[name] }
      : { photo: file, background: cutouts[name] };
    summary[name] = entry;
    const ready = rerender
      ? existsSync(path.join(output, name, 'mesh-positions.bin'))
      : !(cutouts[name] as { error?: string }).error;
    if (ready) {
      const reconstruction = await page.evaluate(
        async ({ name, url, rerender }) => {
          const { Product3dClient, captureComparison } = (await import(url)) as Product;
          const save = (file: string, body: Blob | ArrayBufferView) =>
            fetch(`/save/${name}/${file}`, { method: 'POST', body: body as BodyInit });
          const load = async (field: string) => (await fetch(`/mesh/${name}/${field}`)).arrayBuffer();
          const started = performance.now();
          try {
            let mesh, timings, wallMs;
            if (rerender)
              mesh = {
                positions: new Float32Array(await load('positions')),
                indices: new Uint32Array(await load('indices')),
                colors: new Float32Array(await load('colors')),
              };
            else {
              ({ mesh, timings } = await new Product3dClient().run(
                (window as Cutouts).cutouts![name],
                () => {},
              ));
              wallMs = performance.now() - started;
              await save('mesh-positions.bin', mesh.positions);
              await save('mesh-indices.bin', mesh.indices);
              await save('mesh-colors.bin', mesh.colors);
            }
            const { shots, upright, uprightMs } = await captureComparison(mesh);
            for (const shot of shots) await save(`${shot.key}.png`, shot.png);
            return {
              timings,
              wallMs,
              upright,
              uprightMs,
              luminance: Object.fromEntries(shots.map((shot) => [shot.key, shot.luminance])),
            };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },
        { name, url: '/p3d/client.js', rerender },
      );
      // A re-capture keeps the recorded AI timings.
      const recorded = (entry.reconstruction ?? {}) as { timings?: unknown; wallMs?: number };
      entry.reconstruction = rerender
        ? { ...recorded, ...reconstruction, timings: recorded.timings, wallMs: recorded.wallMs }
        : reconstruction;
      if (!('error' in reconstruction)) {
        const read = (field: string) => {
          const bytes = readFileSync(path.join(output, name, `mesh-${field}.bin`));
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        };
        const positions = new Float32Array(read('positions')),
          indices = new Uint32Array(read('indices')),
          colors = new Float32Array(read('colors'));
        const albedo = estimateAlbedo(positions, indices, colors);
        const materials = new Set<string>();
        for (let i = 0; i < albedo.length; i += 3)
          materials.add(`${albedo[i].toFixed(3)},${albedo[i + 1].toFixed(3)},${albedo[i + 2].toFixed(3)}`);
        Object.assign(entry, {
          vertices: positions.length / 3,
          triangles: indices.length / 3,
          roughness: Number(surfaceRoughness(positions, indices).toFixed(4)),
          volume: Number(meshVolume(positions, indices).toFixed(5)),
          materials: [...materials],
          uprightDegrees: Number(
            ((2 * Math.acos(Math.min(1, Math.abs(reconstruction.upright[3]))) * 180) / Math.PI).toFixed(2),
          ),
        });
      }
      if (cpuPhoto === name && !rerender)
        entry.cpu = await page.evaluate(
          ({ name, url }) =>
            new Promise((resolve) => {
              const worker = new Worker(new URL(url, location.href), {
                type: 'module',
                name: 'sjn-product3d',
              });
              const timer = setTimeout(() => {
                worker.terminate();
                resolve({ error: 'timeout after 15 min' });
              }, 900_000);
              const started = performance.now();
              worker.onmessage = ({ data }) => {
                if (data.type === 'progress') return;
                clearTimeout(timer);
                worker.terminate();
                resolve(
                  data.type === 'mesh'
                    ? {
                        timings: data.timings,
                        wallMs: performance.now() - started,
                        vertices: data.mesh.positions.length / 3,
                      }
                    : { error: data.message },
                );
              };
              worker.postMessage({
                type: 'run',
                id: 1,
                blob: (window as Cutouts).cutouts![name],
                forceCpu: true,
              });
            }),
          { name, url: '/p3d/worker.ts' },
        );
    }
    // Contact sheet: photo · cut-out / before 0°·45°·90° / after 0°·45°·90°.
    const tile = async (file: string) =>
      existsSync(file)
        ? sharp(file)
            .resize(320, 320, { fit: 'contain', background: '#f4f4f1' })
            .flatten({ background: '#f4f4f1' })
            .png()
            .toBuffer()
        : undefined;
    const cells = [
      path.join(input, file),
      path.join(output, name, 'cutout.png'),
      '',
      ...['before', 'after'].flatMap((variant) =>
        [0, 45, 90].map((angle) => path.join(output, name, `${variant}-${angle}.png`)),
      ),
    ];
    const tiles = await Promise.all(cells.map((cell) => (cell ? tile(cell) : undefined)));
    await sharp({ create: { width: 960, height: 960, channels: 3, background: '#ffffff' } })
      .composite(
        tiles.flatMap((buffer, i) =>
          buffer ? [{ input: buffer, left: (i % 3) * 320, top: Math.floor(i / 3) * 320 }] : [],
        ),
      )
      .png()
      .toFile(path.join(output, `${name}-comparison.png`));
    console.log(
      name,
      JSON.stringify({ ...entry, materials: (entry.materials as string[] | undefined)?.length }),
    );
  }
  if (errors.length) summary.pageErrors = { messages: errors };
} finally {
  await browser.close();
  server.close();
}
writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
