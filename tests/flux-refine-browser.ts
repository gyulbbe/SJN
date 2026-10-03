/**
 * The per-product export end to end in a real browser, without any new AI call: the real room renderer
 * (layers, silhouettes, close-ups), the real cut-out model (the cached BiRefNet in tmp/background-model,
 * served from disk), the real runRefine and the real composite. The model's answers are the twelve real
 * FLUX results recorded on 2026-10-03 (test-results/flux-product-refine/real), which belong to exactly
 * the close-ups this script draws again (the same room, camera, sizes and margin as
 * tests/flux-product-crops-browser.ts). The room's own answer is the empty render itself (the
 * room is not what is measured here).
 *
 * Per product and per recorded answer: repainted or kept (with the overlap measured the way the page
 * does it: product stood on the 3D one's ground point at its height), and the composite. Writes
 * test-results/flux-product-refine/composite/ (before/after images, outcomes.json).
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-refine-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const root = path.resolve('test-results/flux-product-refine');
const batch = path.resolve('test-results/product3d-batch');
const metrics = JSON.parse(readFileSync('test-results/product3d-photo/metrics-browser.json', 'utf8')) as {
  name: string;
  camera: object;
  iou: number;
}[];
const products = [
  {
    name: 'bear-toilet',
    folder: 'bear-a-original-500',
    metric: 'cat-toilet-a',
    category: 'toilet',
    sizeMm: [400, 760, 700],
  },
  {
    name: 'smart-toilet',
    folder: '02-smart-toilet',
    metric: '02-smart-toilet',
    category: 'toilet',
    sizeMm: [400, 780, 700],
  },
  {
    name: 'bathtub',
    folder: '03-bathtub-rect',
    metric: '03-bathtub-rect',
    category: 'bath',
    sizeMm: [1500, 560, 750],
  },
] as const;
const variants = [
  { key: 'crop-424242', label: '(i) crop only 424242' },
  { key: 'crop-777001', label: '(i) crop only 777001' },
  { key: 'crop-photo-424242', label: '(ii) crop+photo 424242' },
  { key: 'crop-photo-777001', label: '(ii) crop+photo 777001' },
] as const;
for (const product of products)
  for (const variant of variants)
    assert.ok(
      existsSync(`${root}/real/${product.name}-${variant.key}.jpg`),
      `missing recorded answer ${product.name}-${variant.key}`,
    );
const output = `${root}/composite`;
mkdirSync(output, { recursive: true });

const bundles = new Map<string, string>();
const entries: [string, BuildOptions][] = [
  [
    '/lib.js',
    {
      stdin: {
        contents: [
          "export * from './src/lib/room-viewer/renderer';",
          "export * from './src/lib/ai-export/view';",
          "export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';",
          "export {makeProductMeshAsset} from './src/lib/product3d/codec';",
          "export {createDefaultPose} from './src/lib/product3d/pose';",
          "export {estimateUprightQuaternion} from './src/lib/product3d/upright';",
          "export {projectRoomFixture} from './src/lib/room-fixtures';",
          "export {readPixels, pixelsToPng} from './src/lib/ai-export/client';",
          "export {composeFluxResult} from './src/lib/ai-export/composite';",
          "export {fluxInputLayout} from './src/lib/ai-export/contract';",
          "export {ownMask} from './src/lib/ai-export/refine';",
          "export {runRefine, productFact} from './src/lib/ai-export/refine-run';",
        ].join(''),
        resolveDir: process.cwd(),
      },
      define: { 'import.meta.url': '"http://localhost/page.js"' },
    },
  ],
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
  ['/surface-worker.js', { entryPoints: ['src/lib/product3d/surface-worker.ts'] }],
];
for (const [route, options] of entries) {
  const result = await build({
    ...options,
    bundle: true,
    write: false,
    platform: 'browser',
    format: route === '/surface-worker.js' ? 'iife' : 'esm',
    logLevel: 'warning',
  });
  bundles.set(route, result.outputFiles[0].text);
}
const models = path.resolve('tmp/background-model');
const runtime = path.resolve('node_modules/onnxruntime-web/dist');
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
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
    const name = path.basename(route);
    const file =
      (name.endsWith('.onnx') ? models : runtime) &&
      path.join(name.endsWith('.onnx') ? models : runtime, name);
    if (!file || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.endsWith('.wasm')
        ? 'application/wasm'
        : /\.m?js$/.test(file)
          ? 'text/javascript'
          : 'application/octet-stream',
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

type Outcome = {
  status: 'refined' | 'kept';
  reason?: string;
  message?: string;
  detail?: string;
  iou?: number;
  plainIou?: number;
  ratio?: number;
};
type Shot = {
  name: string;
  before: string;
  after: Record<string, { url: string; outcome: Outcome }>;
  box: number[];
};
const b64 = (file: string) => readFileSync(file).toString('base64');
const shots: Shot[] = [];
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const context = await browser.newContext();
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
  if (process.env.DEBUG_NET) {
    page.on('requestfailed', (r) => console.log('FAILED', r.url(), r.failure()?.errorText));
    context.on('requestfinished', (r) => console.log('OK', r.url().slice(0, 120)));
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // ONNX Runtime logs its own warnings as errors.
    if (m.type() === 'error' && !m.text().includes('onnxruntime')) errors.push(m.text());
  });
  await page.goto(`${origin}/`);
  // The surface worker serves the room's saved products; the cut-out worker is the real one.
  await page.evaluate(async () => {
    const Real = window.Worker;
    const code = await (await fetch('/surface-worker.js')).text();
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    window.Worker = function (u: string | URL, options?: WorkerOptions) {
      if (options?.name === 'sjn-background-removal') return new Real(u, options);
      return new Real(url, options && options.type === 'module' ? {} : options);
    } as unknown as typeof Worker;
  });
  await page.evaluate(async () => {
    const url = '/lib.js';
    (window as unknown as { Room: unknown }).Room = await import(/* @vite-ignore */ url);
  });
  for (const product of products) {
    const metric = metrics.find((m) => m.name === product.metric)!;
    const folder = `${batch}/${product.folder}`;
    const meta = JSON.parse(readFileSync(`${root}/inputs/${product.name}/meta.json`, 'utf8')) as {
      view: { azimuth: number; elevation: number };
      margin: number;
      product: object;
    };
    const answers = Object.fromEntries(
      variants.map((variant) => [variant.key, b64(`${root}/real/${product.name}-${variant.key}.jpg`)]),
    );
    const shot = (await page.evaluate(
      async ({ data, product, metric, meta, answers, variantKeys }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lib = (window as unknown as { Room: Record<string, any> }).Room;
        const decode = (s: string) => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        };
        const dataUrl = (blob: Blob) =>
          new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.readAsDataURL(blob);
          });
        const mesh = {
          positions: new Float32Array(decode(data.p)),
          colors: new Float32Array(decode(data.c)),
          indices: new Uint32Array(decode(data.i)),
        };
        const pose = {
          ...lib.createDefaultPose(),
          objectQuaternion: lib.estimateUprightQuaternion(mesh.positions),
        };
        const { assets, snapshot, aspect, room } = await lib.buildFluxRoomScene();
        const meshAsset = await lib.makeProductMeshAsset(mesh, 'mesh', 'input');
        const photoBlob = new Blob([decode(data.photo)], { type: 'image/png' });
        const photoAsset = {
          id: 'input',
          ownerId: 'local',
          name: 'photo',
          kind: 'product',
          mime: 'image/png',
          size: photoBlob.size,
          width: 512,
          height: 512,
          createdAt: 'test',
          blob: photoBlob,
        };
        const reader = async (id: string) =>
          id === 'mesh' ? meshAsset : id === 'input' ? photoAsset : assets[id];
        const [w, h, d] = product.sizeMm;
        const next = structuredClone(snapshot);
        next.materials.real = {
          ...snapshot.materials.standard,
          id: 'real',
          materialId: 'real',
          name: 'real',
          category: product.category,
          installation: 'floor',
          widthMm: w,
          heightMm: h,
          depthMm: d,
          textureAssetIds: [],
          views: [
            {
              assetId: 'input',
              direction: '정면',
              anchor: { x: 0.5, y: 1 },
              product3d: {
                version: 1,
                meshAssetId: 'mesh',
                inputAssetId: 'input',
                modelId: 'saved',
                modelRevision: 'saved',
                pose,
                shading: 'mixed',
                photoCamera: { ...metric.camera, iou: metric.iou },
                gloss: 'light',
              },
            },
          ],
        };
        const fixture = {
          id: 'real',
          name: 'real',
          materialVersionId: 'real',
          viewIndex: 0,
          position: { x: 0.5, y: 0.5 },
          width: 0.1,
          height: 0.1,
          rotation: 0,
          anchor: { x: 0.5, y: 1 },
          locked: false,
          shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
          occlusion: { polygon: [], strokes: [] },
          color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
          roomPlacement: {
            face: 'floor',
            u: 0.5,
            v: 0.5,
            scale: 1,
            widthMm: w,
            heightMm: h,
            imageAspect: w / h,
            contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
          },
        };
        for (const scene of [next.scene, next.beforeScene]) {
          scene.fixtures = [structuredClone(fixture)];
          lib.projectRoomFixture(room, scene.fixtures[0], aspect);
        }
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
          const orbit = lib.fluxOrbitView(meta.view);
          const frame = {
            width: 1024,
            height: Math.round((1024 * next.scene.imageHeight) / next.scene.imageWidth),
          };
          const layers = viewer.exportLayers(orbit, { longEdge: frame.width });
          const mask = viewer.regionMask(layers.width, layers.height, orbit);
          const boxes = Object.values(viewer.fixtureBounds(layers.width, layers.height, orbit)) as number[][];
          const crops = viewer.exportProductCrops(orbit, {
            frame: { width: layers.width, height: layers.height },
            longEdge: 1024,
            margin: meta.margin,
            ids: ['real'],
          });
          const crop = crops[0];
          const layout = lib.fluxInputLayout(layers.width, layers.height);
          // The room's answer: the empty render itself, on the model's grid at twice its size.
          const emptyCanvas = document.createElement('canvas');
          emptyCanvas.width = layers.width;
          emptyCanvas.height = layers.height;
          emptyCanvas
            .getContext('2d')!
            .putImageData(
              new ImageData(new Uint8ClampedArray(layers.empty), layers.width, layers.height),
              0,
              0,
            );
          const answerCanvas = document.createElement('canvas');
          answerCanvas.width = layout.width * 2;
          answerCanvas.height = layout.height * 2;
          const answerContext = answerCanvas.getContext('2d')!;
          answerContext.fillStyle = '#ffffff';
          answerContext.fillRect(0, 0, answerCanvas.width, answerCanvas.height);
          answerContext.drawImage(
            emptyCanvas,
            layout.x * 2,
            layout.y * 2,
            layout.contentWidth * 2,
            layout.contentHeight * 2,
          );
          const room_answer = {
            width: answerCanvas.width,
            height: answerCanvas.height,
            data: answerContext.getImageData(0, 0, answerCanvas.width, answerCanvas.height).data,
          };
          const input = { width: layers.width, height: layers.height, data: layers.empty };
          const toPng = async (pixels: { width: number; height: number; data: Uint8ClampedArray }) =>
            dataUrl(await lib.pixelsToPng(pixels));
          const before = lib.composeFluxResult({ result: room_answer, input, layers, mask, layout, boxes });
          const out: Record<string, unknown> = {};
          const clientUrl = '/bg/client.js';
          const { BackgroundRemovalClient } = (await import(/* @vite-ignore */ clientUrl)) as {
            BackgroundRemovalClient: new () => {
              run: (blob: Blob, progress: () => void) => Promise<{ blob: Blob }>;
              dispose: () => void;
            };
          };
          const bg = new BackgroundRemovalClient();
          try {
            for (const key of variantKeys as string[]) {
              const answer = new Blob([decode(answers[key])], { type: 'image/jpeg' });
              const outcomes = await lib.runRefine({
                products: [
                  {
                    id: 'real',
                    label: product.name,
                    crop,
                    fact: meta.product,
                  },
                ],
                frame: { width: layers.width, height: layers.height },
                seed: 1,
                signal: new AbortController().signal,
                deps: {
                  encode: lib.pixelsToPng,
                  decode: lib.readPixels,
                  request: async () => answer,
                  cutout: async (image: Blob) => (await bg.run(image, () => {})).blob,
                },
              });
              const outcome = outcomes[0];
              const refine =
                outcome.status === 'refined'
                  ? {
                      layers: [outcome.layer],
                      owns: [lib.ownMask(crop, { width: layers.width, height: layers.height })],
                    }
                  : undefined;
              const composed = lib.composeFluxResult({
                result: room_answer,
                input,
                layers,
                mask,
                layout,
                boxes,
                ...(refine ? { refine } : {}),
              });
              out[key] = {
                url: await toPng(composed.raw),
                outcome:
                  outcome.status === 'refined'
                    ? {
                        status: 'refined',
                        iou: outcome.iou,
                        plainIou: outcome.plainIou,
                        ratio: outcome.ratio,
                      }
                    : {
                        status: 'kept',
                        reason: outcome.reason,
                        message: outcome.message,
                        detail: outcome.detail,
                        iou: outcome.iou,
                      },
              };
            }
          } finally {
            bg.dispose();
          }
          return { before: await toPng(before.raw), after: out, box: crop.box };
        } finally {
          viewer.dispose();
        }
      },
      {
        data: {
          p: b64(`${folder}/mesh-positions.bin`),
          c: b64(`${folder}/mesh-colors.bin`),
          i: b64(`${folder}/mesh-indices.bin`),
          photo: b64(`${folder}/cutout.png`),
        },
        product: { name: product.name, category: product.category, sizeMm: [...product.sizeMm] },
        metric,
        meta,
        answers,
        variantKeys: variants.map((v) => v.key),
      },
    )) as Omit<Shot, 'name'>;
    shots.push({ name: product.name, ...shot });
  }
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
  server.close();
}

const png = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const table: Record<string, Outcome> = {};
for (const shot of shots) {
  writeFileSync(`${output}/${shot.name}-3d.png`, png(shot.before));
  for (const variant of variants) {
    const entry = shot.after[variant.key];
    writeFileSync(`${output}/${shot.name}-${variant.key}.png`, png(entry.url));
    table[`${shot.name}-${variant.key}`] = entry.outcome;
  }
}
writeFileSync(`${output}/outcomes.json`, JSON.stringify(table, null, 1));
// A sheet per product: the 3D render, then each recorded answer put into the room, each cut round the
// product and enlarged.
const cell = 380;
const sheets: Buffer[] = [];
for (const shot of shots) {
  const [left, top, right, bottom] = shot.box;
  const info = await sharp(png(shot.before)).metadata();
  const pad = 0.04;
  const region = {
    left: Math.max(0, Math.round((left - pad) * info.width!)),
    top: Math.max(0, Math.round((top - pad) * info.height!)),
  };
  const size = {
    width: Math.min(info.width! - region.left, Math.round((right - left + 2 * pad) * info.width!)),
    height: Math.min(info.height! - region.top, Math.round((bottom - top + 2 * pad) * info.height!)),
  };
  const crop = async (url: string) =>
    sharp(png(url))
      .extract({ ...region, ...size })
      .resize(cell, cell, { fit: 'contain', background: '#ffffff' })
      .png()
      .toBuffer();
  const parts = [{ title: '3D render', url: shot.before, text: '' }].concat(
    variants.map((variant) => {
      const { outcome } = shot.after[variant.key];
      return {
        title: variant.label,
        url: shot.after[variant.key].url,
        text:
          outcome.status === 'refined'
            ? `refined IoU ${outcome.iou!.toFixed(2)}`
            : `kept: ${outcome.reason}${outcome.iou ? ` ${outcome.iou.toFixed(2)}` : ''}`,
      };
    }),
  );
  const composites: OverlayOptions[] = [];
  for (const [index, part] of parts.entries()) {
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="30"><rect width="100%" height="100%" fill="#fff"/><text x="6" y="20" font-size="13" font-family="sans-serif" fill="#222">${part.title} ${part.text}</text></svg>`,
      ),
      left: index * cell,
      top: 0,
    });
    composites.push({ input: await crop(part.url), left: index * cell, top: 30 });
  }
  sheets.push(
    await sharp({
      create: { width: cell * parts.length, height: cell + 30, channels: 3, background: '#ffffff' },
    })
      .composite(composites)
      .png()
      .toBuffer(),
  );
}
await sharp({
  create: { width: cell * 5, height: (cell + 30) * sheets.length, channels: 3, background: '#ffffff' },
})
  .composite(sheets.map((input, index) => ({ input, left: 0, top: index * (cell + 30) })))
  .png()
  .toFile(`${output}/sheet-all.png`);
const refined = Object.values(table).filter((o) => o.status === 'refined').length;
for (const [key, outcome] of Object.entries(table))
  console.log(
    `${key.padEnd(34)} ${outcome.status === 'refined' ? `refined  IoU ${outcome.iou!.toFixed(3)} (plain ${outcome.plainIou!.toFixed(3)}, height ratio ${outcome.ratio!.toFixed(2)})` : `kept (${outcome.reason}) ${outcome.message} ${outcome.detail ?? ''}`}`,
  );
console.log(`repainted ${refined} of ${Object.keys(table).length}; sheet: ${output}/sheet-all.png`);
