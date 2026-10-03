/**
 * The per-product crops of the AI export (docs/flux-product-refine-results-*.md), no AI call: saved
 * TripoSR meshes (test-results/product3d-batch, with the photo colours and the glaze the editor now
 * gives them) put alone on the floor of the FLUX comparison room, seen from the AI input's camera, each
 * drawn large on the plain white backdrop by RoomViewerRenderer.exportProductCrops. For every product
 * the files the experiment needs go to test-results/flux-product-refine/inputs/<name>/:
 *   crop.png        the model input: long edge ≤ 496, padded white to the 16 px grid (fluxInputLayout)
 *   crop-render.png the same picture at 1024 px (what the crop was drawn at)
 *   silhouette.png  the 3D silhouette in the model input's pixels (white = product)
 *   reference.png   the saved photo's cut-out on white, long edge ≤ 496 (the reference image)
 *   frame.png       the whole AI input frame (1024 px) with the product's box and the crop window
 *   meta.json       layout, boxes, the product facts and both prompts
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-product-crops-browser.ts [--gpu]
 *   VIEW=30,20    azimuth,elevation of the AI input camera (default 30,20)
 *   MARGIN=0.15   the room around the product, as a share of its own size (default 0.15)
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type Sharp } from 'sharp';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import { buildFluxProductPrompt, type FluxProduct } from '../src/lib/ai-export/product-prompt';

const gpu = process.argv.includes('--gpu');
const [azimuth, elevation] = (process.env.VIEW ?? '30,20').split(',').map(Number);
const margin = Number(process.env.MARGIN ?? 0.15);
const root = 'test-results/product3d-batch';
const output = 'test-results/flux-product-refine/inputs';
const metricsPath = 'test-results/product3d-photo/metrics-browser.json';
const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as {
  name: string;
  camera: object;
  iou: number;
}[];

type Product = {
  name: string;
  /** The batch folder (mesh-*.bin, cutout.png). */
  folder: string;
  /** Metrics name of the fitted photo camera. */
  metric: string;
  category: 'toilet' | 'bath';
  installation: 'floor';
  sizeMm: [number, number, number];
  fact: FluxProduct;
};
const products: Product[] = [
  {
    name: 'bear-toilet',
    folder: `${root}/bear-a-original-500`,
    metric: 'cat-toilet-a',
    category: 'toilet',
    installation: 'floor',
    sizeMm: [400, 760, 700],
    fact: {
      kind: 'toilet',
      forms: ['floor-standing', 'lid-closed'],
      color: '#f2f1ec',
      finish: 'glossy',
      sizeMm: [400, 760, 700],
    },
  },
  {
    name: 'smart-toilet',
    folder: `${root}/02-smart-toilet`,
    metric: '02-smart-toilet',
    category: 'toilet',
    installation: 'floor',
    sizeMm: [400, 780, 700],
    fact: {
      kind: 'toilet',
      forms: ['floor-standing', 'lid-closed'],
      color: '#f2f1ec',
      finish: 'glossy',
      sizeMm: [400, 780, 700],
    },
  },
  {
    name: 'bathtub',
    folder: `${root}/03-bathtub-rect`,
    metric: '03-bathtub-rect',
    category: 'bath',
    installation: 'floor',
    sizeMm: [1500, 560, 750],
    fact: {
      kind: 'bath',
      forms: ['rectangular', 'built-in'],
      color: '#f2f1ec',
      finish: 'glossy',
      sizeMm: [1500, 560, 750],
    },
  },
].filter((product) => existsSync(`${product.folder}/mesh-positions.bin`)) as Product[];
assert.ok(products.length >= 3, 'fewer than three saved products found');

await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export * from './src/lib/ai-export/view';",
      "export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';",
      "export {makeProductMeshAsset} from './src/lib/product3d/codec';",
      "export {createDefaultPose} from './src/lib/product3d/pose';",
      "export {estimateUprightQuaternion} from './src/lib/product3d/upright';",
      "export {projectRoomFixture} from './src/lib/room-fixtures';",
    ].join(''),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Room',
  logLevel: 'error',
  define: { 'import.meta.url': '"http://localhost/page.js"' },
});
const worker = await build({
  entryPoints: ['src/lib/product3d/surface-worker.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
type Shot = {
  name: string;
  frame: string;
  frameBox: [number, number, number, number];
  frameSize: [number, number];
  width: number;
  height: number;
  rgba: string;
  coverage: string;
  window: [number, number, number, number];
  box: [number, number, number, number];
  ms: number;
};
let shots: Shot[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.route('http://127.0.0.1:43227/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43227/');
  await page.evaluate(`(() => {
    const Real = window.Worker; let url;
    window.__setWorker = (code) => { url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); };
    window.Worker = function (_u, options) { return new Real(url, options && options.type === 'module' ? {} : options); };
  })();`);
  await page.evaluate(
    (code) => (window as unknown as { __setWorker: (c: string) => void }).__setWorker(code),
    worker.outputFiles[0].text,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const b64 = (file: string) => readFileSync(file).toString('base64');
  shots = [];
  for (const product of products) {
    const camera = metrics.find((m) => m.name === product.metric);
    assert.ok(camera, `no photo camera for ${product.metric}`);
    const shot = (await page.evaluate(
      async ({ data, product, camera, view, margin }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lib = (window as unknown as { Room: Record<string, any> }).Room;
        const decode = (s: string) => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        };
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
          installation: product.installation,
          widthMm: w,
          heightMm: h,
          depthMm: d,
          textureAssetIds: [],
          views: [
            {
              assetId: 'input',
              direction: '정면' as const,
              anchor: { x: 0.5, y: 1 },
              product3d: {
                version: 1 as const,
                meshAssetId: 'mesh',
                inputAssetId: 'input',
                modelId: 'saved',
                modelRevision: 'saved',
                pose,
                shading: 'mixed',
                photoCamera: { ...camera.camera, iou: camera.iou },
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
            face: 'floor' as const,
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
          const dataUrl = (blob: Blob) =>
            new Promise<string>((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result as string);
              r.readAsDataURL(blob);
            });
          const bytes = (array: ArrayLike<number>) => {
            let text = '';
            const view = array as Uint8Array;
            for (let i = 0; i < view.length; i += 0x8000)
              text += String.fromCharCode(...view.subarray(i, i + 0x8000));
            return btoa(text);
          };
          await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
          const orbit = lib.fluxOrbitView({ azimuth: view[0], elevation: view[1] });
          // The AI input's frame: 1024 px on the long side, the scene's aspect.
          const frame = {
            width: 1024,
            height: Math.round((1024 * next.scene.imageHeight) / next.scene.imageWidth),
          };
          const frameBlob = await viewer.export(orbit, {
            format: 'png',
            mode: 'after',
            longEdge: frame.width,
          });
          const boxes = viewer.fixtureBounds(frame.width, frame.height, orbit);
          const started = performance.now();
          const crops = viewer.exportProductCrops(orbit, { frame, longEdge: 1024, margin });
          const ms = performance.now() - started;
          const crop = crops.find((c: { id: string }) => c.id === 'real');
          if (!crop) throw new Error('no crop for the product');
          return {
            name: product.name,
            frame: await dataUrl(frameBlob),
            frameBox: boxes.real,
            frameSize: [frame.width, frame.height],
            width: crop.width,
            height: crop.height,
            rgba: bytes(new Uint8Array(crop.data.buffer)),
            coverage: bytes(crop.coverage),
            window: crop.window,
            box: crop.box,
            ms: Math.round(ms),
          };
        } finally {
          viewer.dispose();
        }
      },
      {
        data: {
          p: b64(`${product.folder}/mesh-positions.bin`),
          c: b64(`${product.folder}/mesh-colors.bin`),
          i: b64(`${product.folder}/mesh-indices.bin`),
          photo: b64(`${product.folder}/cutout.png`),
        },
        product: {
          name: product.name,
          category: product.category,
          installation: product.installation,
          sizeMm: product.sizeMm,
        },
        camera,
        view: [azimuth, elevation],
        margin,
      },
    )) as Shot;
    shots.push(shot);
  }
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
}

const png = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
for (const shot of shots) {
  const product = products.find((p) => p.name === shot.name)!;
  const dir = `${output}/${shot.name}`;
  await mkdir(dir, { recursive: true });
  const rgba = Buffer.from(shot.rgba, 'base64');
  const coverage = Buffer.from(shot.coverage, 'base64');
  assert.equal(rgba.length, shot.width * shot.height * 4);
  assert.equal(coverage.length, shot.width * shot.height);
  // The backdrop is plain white in the corners, and the silhouette sits where the narrowed camera
  // says the product's outline is (the outline measured on the whole frame, mapped into the window).
  for (const [x, y] of [
    [0, 0],
    [shot.width - 1, 0],
    [0, shot.height - 1],
    [shot.width - 1, shot.height - 1],
  ]) {
    const at = (y * shot.width + x) * 4;
    assert.deepEqual([...rgba.subarray(at, at + 3)], [255, 255, 255], `${shot.name}: corner is white`);
  }
  const found = [shot.width, shot.height, -1, -1];
  for (let i = 0; i < coverage.length; i++) {
    if (coverage[i] < 128) continue;
    found[0] = Math.min(found[0], i % shot.width);
    found[1] = Math.min(found[1], Math.floor(i / shot.width));
    found[2] = Math.max(found[2], (i % shot.width) + 1);
    found[3] = Math.max(found[3], Math.floor(i / shot.width) + 1);
  }
  const [wl, wt, wr, wb] = shot.window;
  const expected = [
    ((shot.box[0] - wl) / (wr - wl)) * shot.width,
    ((shot.box[1] - wt) / (wb - wt)) * shot.height,
    ((shot.box[2] - wl) / (wr - wl)) * shot.width,
    ((shot.box[3] - wt) / (wb - wt)) * shot.height,
  ];
  // Mesh vertices (not pixels) set the outline, and the silhouette is antialiased: a few pixels.
  found.forEach((value, index) =>
    assert.ok(
      Math.abs(value - expected[index]) <= 4,
      `${shot.name}: silhouette edge ${index} ${value} vs ${expected[index]}`,
    ),
  );
  // The model input: shrink to the 496 px grid (padded white, never stretched).
  const layout = fluxInputLayout(shot.width, shot.height);
  const place = async (input: Sharp, background: string) =>
    input
      .resize(Math.round(layout.contentWidth), Math.round(layout.contentHeight), { kernel: 'lanczos3' })
      .extend({
        left: Math.round(layout.x),
        top: Math.round(layout.y),
        right: layout.width - Math.round(layout.x) - Math.round(layout.contentWidth),
        bottom: layout.height - Math.round(layout.y) - Math.round(layout.contentHeight),
        background,
      })
      .png()
      .toBuffer();
  const render = sharp(rgba, { raw: { width: shot.width, height: shot.height, channels: 4 } }).removeAlpha();
  await render.clone().png().toFile(`${dir}/crop-render.png`);
  await sharp(await place(render.clone(), '#ffffff'))
    .png()
    .toFile(`${dir}/crop.png`);
  await sharp(
    await place(
      sharp(coverage, { raw: { width: shot.width, height: shot.height, channels: 1 } }).toColourspace('b-w'),
      '#000000',
    ),
  )
    .png()
    .toFile(`${dir}/silhouette.png`);
  // The reference: the saved photo's cut-out on white, long edge ≤ 496.
  const refLayout = fluxInputLayout(512, 512);
  await sharp(`${product.folder}/cutout.png`)
    .flatten({ background: '#ffffff' })
    .resize(refLayout.width, refLayout.height)
    .png()
    .toFile(`${dir}/reference.png`);
  // The frame, with the product's box (red) and the crop window (blue).
  const [fw, fh] = shot.frameSize;
  const rect = (box: number[], color: string) =>
    `<rect x="${box[0] * fw}" y="${box[1] * fh}" width="${(box[2] - box[0]) * fw}" height="${(box[3] - box[1]) * fh}" fill="none" stroke="${color}" stroke-width="2"/>`;
  await sharp(png(shot.frame))
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${fw}" height="${fh}">${rect(shot.box, '#d22')}${rect(shot.window, '#26d')}</svg>`,
        ),
      },
    ])
    .png()
    .toFile(`${dir}/frame.png`);
  const prompts = {
    crop: buildFluxProductPrompt(product.fact, false),
    cropAndPhoto: buildFluxProductPrompt(product.fact, true),
  };
  writeFileSync(
    `${dir}/meta.json`,
    JSON.stringify(
      {
        name: shot.name,
        view: { azimuth, elevation },
        margin,
        layout,
        crop: { width: shot.width, height: shot.height },
        window: shot.window,
        box: shot.box,
        frameBox: shot.frameBox,
        frameSize: shot.frameSize,
        product: product.fact,
        prompts,
        renderMs: shot.ms,
      },
      null,
      1,
    ),
  );
  const pixels = Math.round(Math.max(shot.box[2] - shot.box[0], shot.box[3] - shot.box[1]) * fw);
  console.log(
    `${shot.name.padEnd(13)} frame product ≈${pixels}px wide | crop ${shot.width}×${shot.height} → model input ${layout.width}×${layout.height} | ${shot.ms} ms`,
  );
}
console.log('crops:', output);
