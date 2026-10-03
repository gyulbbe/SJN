/**
 * The 3D room (and so the AI conversion input and the export, which draw the same room) with a saved
 * product whose view was saved with the photo's colours: a saved TripoSR mesh and its input photo
 * (test-results/product3d-batch, no new AI run) on the floor of the FLUX comparison room, saved as
 * "mixed" and as the original colours, without and with `photoCamera`. The room reads the input photo
 * back from the asset store (the real canvas decode, ProductAssetCache.asset) and puts its colours on
 * the mesh through the saved camera, as the editor does. Rows: mixed without / with, original colours
 * without / with; the picture is cut round the product and enlarged.
 *
 * Writes test-results/product3d-photo/room-<product>.png.
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-photo-room-browser.ts [--gpu]
 *   MESH=cat-toilet-a   one of the names in test-results/product3d-photo/metrics-browser.json (run
 *                       tests/product3d-photo-browser.ts first); default cat-toilet-a
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const name = process.env.MESH ?? 'cat-toilet-a';
const root = 'test-results/product3d-batch';
const source = {
  'cat-toilet-a': {
    mesh: `${root}/bear-a-original-500`,
    photo: 'test-results/diag/cat-toilet/cat-toilet-source-500.png',
  },
  '02-smart-toilet': { mesh: `${root}/02-smart-toilet`, photo: `${root}/02-smart-toilet/cutout.png` },
}[name as 'cat-toilet-a'];
const metricsPath = 'test-results/product3d-photo/metrics-browser.json';
if (!source || !existsSync(`${source.mesh}/mesh-positions.bin`) || !existsSync(metricsPath)) {
  console.log(`${name}: no mesh or no metrics, skipped`);
  process.exit(0);
}
const found = (
  JSON.parse(readFileSync(metricsPath, 'utf8')) as { name: string; camera?: object; iou?: number }[]
).find((m) => m.name === name);
assert.ok(found?.camera, `${name}: no camera in ${metricsPath}`);
const output = 'test-results/product3d-photo';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export * from './src/lib/room-viewer/view-state';",
      "export * from './src/lib/ai-export/view';",
      "export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';",
      "export {readPixels} from './src/lib/ai-export/client';",
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
const rows = [
  { shading: 'mixed', photo: false },
  { shading: 'mixed', photo: true },
  { shading: 'baked', photo: false },
  { shading: 'baked', photo: true },
] as const;
type Shot = { shading: string; photo: boolean; url: string; box: number[]; ms: number };
let shots: Shot[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.route('http://127.0.0.1:43226/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43226/');
  // Every Worker the bundle starts is the surface worker (as the page's own build would emit).
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
  shots = (await page.evaluate(
    async ({ data, rows, camera, iou }) => {
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
      const dataUrl = (blob: Blob) =>
        new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
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
        width: 500,
        height: 500,
        createdAt: 'test',
        blob: photoBlob,
      };
      const reader = async (id: string) =>
        id === 'mesh' ? meshAsset : id === 'input' ? photoAsset : assets[id];
      const material = (shading: string, photo: boolean) => ({
        ...snapshot.materials.standard,
        id: 'real',
        materialId: 'real',
        name: 'real',
        category: 'toilet' as const,
        installation: 'floor' as const,
        widthMm: 700,
        heightMm: 700,
        depthMm: 500,
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
              ...(shading === 'baked' ? {} : { shading }),
              ...(photo ? { photoCamera: { ...camera, iou } } : {}),
            },
          },
        ],
      });
      const fixture = () => ({
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
          widthMm: 700,
          heightMm: 700,
          imageAspect: 1,
          contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
        },
      });
      const draw = async (shading: string | undefined, photo: boolean) => {
        const next = structuredClone(snapshot);
        if (shading) next.materials.real = material(shading, photo);
        for (const scene of [next.scene, next.beforeScene]) {
          scene.fixtures = shading ? [fixture() as never] : [];
          if (shading) lib.projectRoomFixture(room, scene.fixtures[0], aspect);
        }
        const viewer = new lib.RoomViewerRenderer();
        try {
          const started = performance.now();
          await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
          const blob = await viewer.export(lib.fluxOrbitView({ azimuth: 0, elevation: 18 }), {
            format: 'png',
            mode: 'after',
            longEdge: 2000,
          });
          return { blob, ms: performance.now() - started, pixels: await lib.readPixels(blob) };
        } finally {
          viewer.dispose();
        }
      };
      const empty = await draw(undefined, false);
      const out: { shading: string; photo: boolean; url: string; box: number[]; ms: number }[] = [];
      for (const row of rows) {
        const shot = await draw(row.shading, row.photo);
        const box = [1e9, 1e9, -1, -1];
        const { data: now, width, height } = shot.pixels;
        for (let i = 0; i < width * height; i++) {
          const o = i * 4;
          const change =
            Math.abs(now[o] - empty.pixels.data[o]) +
            Math.abs(now[o + 1] - empty.pixels.data[o + 1]) +
            Math.abs(now[o + 2] - empty.pixels.data[o + 2]);
          if (change < 45) continue;
          box[0] = Math.min(box[0], i % width);
          box[1] = Math.min(box[1], Math.floor(i / width));
          box[2] = Math.max(box[2], i % width);
          box[3] = Math.max(box[3], Math.floor(i / width));
        }
        out.push({ ...row, url: await dataUrl(shot.blob), box, ms: Math.round(shot.ms) });
      }
      return out;
    },
    {
      data: {
        p: b64(`${source.mesh}/mesh-positions.bin`),
        c: b64(`${source.mesh}/mesh-colors.bin`),
        i: b64(`${source.mesh}/mesh-indices.bin`),
        photo: b64(source.photo),
      },
      rows: [...rows],
      camera: found.camera as object,
      iou: found.iou as number,
    },
  )) as Shot[];
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
}
const png = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const tile = 520;
const composites: OverlayOptions[] = [];
for (const [row, shot] of shots.entries()) {
  const side = Math.max(shot.box[2] - shot.box[0], shot.box[3] - shot.box[1]);
  const size = Math.round(side * 1.3);
  const info = await sharp(png(shot.url)).metadata();
  const left = Math.max(
    0,
    Math.min(info.width! - size, Math.round((shot.box[0] + shot.box[2]) / 2 - size / 2)),
  );
  const top = Math.max(
    0,
    Math.min(info.height! - size, Math.round((shot.box[1] + shot.box[3]) / 2 - size / 2)),
  );
  composites.push({
    input: await sharp(png(shot.url))
      .extract({ left, top, width: size, height: size })
      .resize(tile, tile)
      .toBuffer(),
    left: (row % 2) * tile,
    top: Math.floor(row / 2) * tile,
  });
}
await sharp({ create: { width: tile * 2, height: tile * 2, channels: 3, background: '#f4f4f0' } })
  .composite(composites)
  .png()
  .toFile(`${output}/room-${name}.png`);
for (const shot of shots)
  console.log(`${shot.shading.padEnd(6)} ${shot.photo ? 'photo colours' : 'as before   '} ${shot.ms} ms`);
// The photo colours make a different picture in both modes.
for (const shading of ['mixed', 'baked'])
  assert.notEqual(
    shots.find((s) => s.shading === shading && !s.photo)!.url,
    shots.find((s) => s.shading === shading && s.photo)!.url,
    `${shading}: the photo's colours show in the room`,
  );
console.log(
  'compare images:',
  `${output}/room-${name}.png (left: as before, right: photo colours; top: mixed, bottom: original colours)`,
);
