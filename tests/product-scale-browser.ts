/**
 * Real-WebGL pictures of product photos beside their standard models (which are exactly the registered
 * size), for the product size work (docs/product-scale-results-20261024.md).
 *
 * Room A: the smart toilet's 정면 photo and its model, the bear toilet's 정면 photo and its model.
 * Room B: the bath's 정면 photo, and the smart toilet seen from its side at the front left corner (as
 * the user's export picture showed it). Room C: the same two as their standard models, same places.
 * Each room is drawn as the export's front input (the AI orbit) and as the space viewer's front view.
 * The material can be given no depth (--no-depth) to show the side photo without one.
 *
 * The photos are the local development products exported to test-results/product-scale/photos.
 *
 * Usage: node tests/run-browser-test.mjs tests/product-scale-browser.ts --label=before [--no-depth] [--gpu]
 * Writes test-results/product-scale/<label>/<room>-<view>.png and <label>/sheet.png.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const noDepth = process.argv.includes('--no-depth');
const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice(8) ?? 'current';
const output = `test-results/product-scale/${label}`;
await mkdir(output, { recursive: true });

type Photo = { direction: string; anchor: { x: number; y: number }; url: string };
type Product = {
  key: string;
  name: string;
  category: string;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  photos: Photo[];
};
const photoDir = 'test-results/product-scale/photos';
const materials = JSON.parse(await readFile(`${photoDir}/materials.json`, 'utf8')) as {
  name: string;
  category: string;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  views: { direction: string; anchor: { x: number; y: number }; file?: string }[];
}[];
async function product(key: string, name: string): Promise<Product> {
  const m = materials.find((item) => item.name === name);
  if (!m) throw new Error(`${name}: test-results/product-scale/photos에 없어요.`);
  return {
    key,
    name: m.name,
    category: m.category,
    widthMm: m.widthMm,
    heightMm: m.heightMm,
    depthMm: noDepth ? 0 : m.depthMm,
    photos: await Promise.all(
      m.views.map(async (view) => ({
        direction: view.direction,
        anchor: view.anchor,
        url: `data:image/${view.file!.split('.').at(-1)};base64,${(await readFile(`${photoDir}/${view.file}`)).toString('base64')}`,
      })),
    ),
  };
}
const products = [
  await product('smart', '스마트 변기'),
  await product('bear', '곰 변기 v2'),
  await product('bath', '사각 욕조'),
];

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {projectRoomFixture, productContentBounds} from './src/lib/room-fixtures';export {projectReconstructionFixture} from './src/lib/reconstruction/projection';export {showAsStandardModel} from './src/lib/standard-model-view';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Scale',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
type Lib = typeof import('../src/lib/room-viewer/renderer') &
  typeof import('../src/lib/room-viewer/view-state') &
  typeof import('../src/lib/ai-export/view') &
  Pick<typeof import('./helpers/flux-room-scene'), 'buildFluxRoomScene'> &
  Pick<typeof import('../src/lib/room-fixtures'), 'projectRoomFixture' | 'productContentBounds'> &
  Pick<typeof import('../src/lib/reconstruction/projection'), 'projectReconstructionFixture'> &
  Pick<typeof import('../src/lib/standard-model-view'), 'showAsStandardModel'>;

/** [product, chosen photo, u, v, as its standard model] */
const ROOMS = {
  A: [
    ['smart', 0, 0.2, 0.35, false],
    ['smart', 0, 0.38, 0.35, true],
    ['bear', 0, 0.62, 0.35, false],
    ['bear', 0, 0.8, 0.35, true],
  ],
  B: [
    ['bath', 0, 0.55, 0.2, false],
    ['smart', 1, 0.12, 0.85, false],
  ],
  // Room B's products as their standard models, in the same places: the registered size.
  C: [
    ['bath', 0, 0.55, 0.2, true],
    ['smart', 1, 0.12, 0.85, true],
  ],
} as const;
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43223/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43223/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const shots = (await page.evaluate(
    async ({ products, rooms }) => {
      const lib = (window as unknown as { Scale: Lib }).Scale;
      const { assets, snapshot, aspect, room } = await lib.buildFluxRoomScene({ walls: 'white' });
      const dataUrl = (blob: Blob) =>
        new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
      const materials: typeof snapshot.materials = { ...snapshot.materials };
      for (const item of products) {
        const views = [];
        for (const [j, photo] of item.photos.entries()) {
          const blob = await (await fetch(photo.url)).blob();
          const bitmap = await createImageBitmap(blob);
          const id = `${item.key}-${j}`;
          assets[id] = {
            id,
            ownerId: 'test',
            name: id,
            mime: blob.type,
            size: blob.size,
            width: bitmap.width,
            height: bitmap.height,
            kind: 'product',
            blob,
            createdAt: '2026-10-24',
          };
          bitmap.close();
          views.push({ assetId: id, direction: photo.direction, anchor: photo.anchor });
        }
        materials[item.key] = {
          ...snapshot.materials.white,
          id: item.key,
          materialId: item.key,
          name: item.name,
          category: item.category as 'toilet',
          installation: 'floor',
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          depthMm: item.depthMm,
          textureAssetIds: [],
          views,
        };
      }
      const reader = async (id: string) => assets[id];
      const out: { room: string; view: string; url: string }[] = [];
      for (const [roomName, items] of Object.entries(rooms)) {
        const fixtures = [];
        for (const [i, [key, viewIndex, u, v]] of items.entries()) {
          const material = materials[key];
          const asset = assets[
            material.views[viewIndex].assetId
          ] as import('../src/lib/types').ImageAssetRecord;
          fixtures.push({
            id: `${roomName}-${i}`,
            name: material.name,
            materialVersionId: key,
            viewIndex,
            position: { x: 0.5, y: 0.5 },
            width: 0.1,
            height: 0.1,
            rotation: 0,
            anchor: { ...material.views[viewIndex].anchor },
            locked: false,
            shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
            occlusion: { polygon: [], strokes: [] },
            color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
            roomPlacement: {
              face: 'floor' as const,
              u,
              v,
              scale: 1,
              widthMm: material.widthMm,
              heightMm: material.heightMm,
              imageAspect: asset.width / asset.height,
              contentBounds: await lib.productContentBounds(asset),
            },
          });
        }
        const next = { ...structuredClone({ ...snapshot, materials: {} }), materials };
        for (const scene of [next.scene, next.beforeScene]) {
          scene.fixtures = structuredClone(fixtures);
          for (const [i, fixture] of scene.fixtures.entries()) {
            lib.projectRoomFixture(room, fixture, aspect);
            if (items[i][4]) {
              lib.showAsStandardModel(scene, fixture.id, materials[fixture.materialVersionId]);
              lib.projectReconstructionFixture(room, fixture, aspect);
            }
          }
        }
        for (const [view, state, exportAngles] of [
          ['export', lib.fluxOrbitView({ azimuth: 0, elevation: 0 }), true],
          ['viewer', lib.defaultRoomView(), false],
        ] as const) {
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles });
            const blob = await viewer.export(state, { format: 'png', mode: 'after', longEdge: 1200 });
            out.push({ room: roomName, view, url: await dataUrl(blob) });
          } finally {
            viewer.dispose();
          }
        }
      }
      return out;
    },
    { products, rooms: ROOMS },
  )) as { room: string; view: string; url: string }[];
  const W = 600,
    H = 400;
  const tiles: { input: Buffer; top: number; left: number }[] = [];
  for (const shot of shots) {
    const png = Buffer.from(shot.url.slice(shot.url.indexOf(',') + 1), 'base64');
    await writeFile(`${output}/${shot.room}-${shot.view}.png`, png);
    tiles.push({
      input: await sharp(png).resize(W, H, { fit: 'contain', background: '#ffffff' }).png().toBuffer(),
      top: ['A', 'B', 'C'].indexOf(shot.room) * H,
      left: (shot.view === 'export' ? 0 : 1) * W,
    });
  }
  await sharp({ create: { width: W * 2, height: H * 3, channels: 3, background: '#ffffff' } })
    .composite(tiles)
    .png()
    .toFile(`${output}/sheet.png`);
  console.log(`${label}: ${shots.length} pictures, sheet ${output}/sheet.png`);
  if (errors.length) console.log('page errors:', errors.join(' | '));
} finally {
  await browser.close();
}
