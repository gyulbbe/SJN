/**
 * Real-WebGL pictures of floor toilets in the default room, for the floor and wall contact work
 * (docs/size-order-and-contact-results-20261024.md). Four toilets stand side by side: a grey one shown
 * by its 정면 photo registered with the default anchor (0.97), a white one likewise, a drawn one with a
 * soft ground shadow under it, and the grey one as its standard model. They stand at the default
 * place (v 0.55) and, in a second room, against the wall behind them (`roomPlacement.againstWall`;
 * before that field existed, the second room was the default place again). Each room is drawn from the
 * front (the space viewer's default), the right, the back and the left, and from above the right to
 * show the gap to the wall.
 *
 * The photos are the local development toilets exported to test-results/fixture-contact/photos (see
 * the results document); without them, drawn stand-ins with the same transparent margins are used.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-contact-browser.ts --label=before [--gpu]
 * Writes test-results/fixture-contact/<label>/<place>-<view>.png and <label>/sheet.png.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice(8) ?? 'current';
const output = `test-results/fixture-contact/${label}`;
await mkdir(output, { recursive: true });

type Photo = { direction: string; anchor: { x: number; y: number }; url: string };
type Toilet = { name: string; widthMm: number; heightMm: number; depthMm: number; photos: Photo[] };
const photoDir = 'test-results/fixture-contact/photos';
async function localToilet(name: string): Promise<Toilet | undefined> {
  if (!existsSync(`${photoDir}/materials.json`)) return undefined;
  const materials = JSON.parse(await readFile(`${photoDir}/materials.json`, 'utf8')) as {
    name: string;
    widthMm: number;
    heightMm: number;
    depthMm: number;
    views: { direction: string; anchor: { x: number; y: number }; file?: string }[];
  }[];
  const m = materials.find((item) => item.name === name);
  if (!m || m.views.some((view) => !view.file)) return undefined;
  return {
    name: m.name,
    widthMm: m.widthMm,
    heightMm: m.heightMm,
    depthMm: m.depthMm,
    photos: await Promise.all(
      m.views.map(async (view) => ({
        direction: view.direction,
        anchor: view.anchor,
        url: `data:image/${view.file!.split('.').at(-1)};base64,${(await readFile(`${photoDir}/${view.file}`)).toString('base64')}`,
      })),
    ),
  };
}
const toilets = [await localToilet('곰 변기 v2'), await localToilet('스마트 변기')];

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {projectRoomFixture, productContentBounds} from './src/lib/room-fixtures';export {projectReconstructionFixture} from './src/lib/reconstruction/projection';export {showAsStandardModel} from './src/lib/standard-model-view';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Contact',
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

const VIEWS = [
  ['front', null],
  ['right', { azimuth: 90, elevation: 10 }],
  ['back', { azimuth: 180, elevation: 10 }],
  ['left', { azimuth: -90, elevation: 10 }],
  ['above-right', { azimuth: 60, elevation: 45 }],
] as const;
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43222/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43222/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const shots = (await page.evaluate(
    async ({ toilets, views }) => {
      const lib = (window as unknown as { Contact: Lib }).Contact;
      const { assets, snapshot, aspect, room } = await lib.buildFluxRoomScene({ walls: 'white' });
      const dataUrl = (blob: Blob) =>
        new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
      // A drawn stand-in: a grey or white toilet with a transparent margin like the local photos.
      const drawn = async (fill: string): Promise<string> => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 500;
        const c = canvas.getContext('2d')!;
        c.fillStyle = fill;
        c.fillRect(150, 90, 200, 120); // tank
        c.beginPath();
        c.ellipse(250, 300, 110, 90, 0, 0, Math.PI * 2);
        c.fill(); // bowl
        c.fillRect(190, 300, 120, 141); // foot, down to 0.882
        return canvas.toDataURL('image/png');
      };
      // A cut-out with a soft ground shadow under it (alpha ≤ 128), like some background removals leave.
      const shadowed = async (): Promise<string> => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 500;
        const c = canvas.getContext('2d')!;
        const shadow = c.createRadialGradient(200, 470, 10, 200, 470, 150);
        shadow.addColorStop(0, 'rgba(0,0,0,0.45)');
        shadow.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = shadow;
        c.fillRect(40, 440, 320, 60);
        c.fillStyle = '#b9a58c';
        c.fillRect(110, 40, 180, 110);
        c.beginPath();
        c.ellipse(200, 260, 100, 85, 0, 0, Math.PI * 2);
        c.fill();
        c.fillRect(150, 260, 100, 215); // the foot ends at 0.95; the shadow reaches 0.99
        return canvas.toDataURL('image/png');
      };
      const list = [
        toilets[0] ?? {
          name: '곰 변기(대역)',
          widthMm: 370,
          heightMm: 660,
          depthMm: 640,
          photos: [{ direction: '정면', anchor: { x: 0.5, y: 0.97 }, url: await drawn('#8d8f93') }],
        },
        toilets[1] ?? {
          name: '스마트 변기(대역)',
          widthMm: 400,
          heightMm: 520,
          depthMm: 700,
          photos: [{ direction: '정면', anchor: { x: 0.5, y: 0.97 }, url: await drawn('#f4f4f2') }],
        },
        {
          name: '그림자 합성 변기',
          widthMm: 380,
          heightMm: 700,
          depthMm: 650,
          photos: [{ direction: '정면', anchor: { x: 0.5, y: 0.97 }, url: await shadowed() }],
        },
      ];
      const materials: typeof snapshot.materials = { ...snapshot.materials };
      for (const [i, toilet] of list.entries()) {
        const views = [];
        for (const [j, photo] of toilet.photos.entries()) {
          const blob = await (await fetch(photo.url)).blob();
          const bitmap = await createImageBitmap(blob);
          const id = `toilet-${i}-${j}`;
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
            createdAt: '2026-10-23',
          };
          bitmap.close();
          views.push({ assetId: id, direction: photo.direction, anchor: photo.anchor });
        }
        materials[`toilet-${i}`] = {
          ...snapshot.materials.white,
          id: `toilet-${i}`,
          materialId: `toilet-${i}`,
          name: toilet.name,
          category: 'toilet',
          installation: 'floor',
          widthMm: toilet.widthMm,
          heightMm: toilet.heightMm,
          depthMm: toilet.depthMm,
          textureAssetIds: [],
          views,
        };
      }
      const reader = async (id: string) => assets[id];
      const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
      const toiletFixture = async (i: number, u: number, v: number) => {
        const material = materials[`toilet-${i}`];
        const asset = assets[material.views[0].assetId] as import('../src/lib/types').ImageAssetRecord;
        return {
          id: `toilet-${i}-${u}`,
          name: material.name,
          materialVersionId: material.id,
          viewIndex: 0,
          position: { x: 0.5, y: 0.5 },
          width: 0.1,
          height: 0.1,
          rotation: 0,
          anchor: { ...material.views[0].anchor },
          locked: false,
          shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
          occlusion: { polygon: [], strokes: [] },
          color: { ...color },
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
        };
      };
      const out: { place: string; view: string; url: string; notices: string }[] = [];
      for (const place of ['default', 'wall'] as const) {
        const fixtures = [
          await toiletFixture(0, 0.15, 0.55),
          await toiletFixture(1, 0.38, 0.55),
          await toiletFixture(2, 0.62, 0.55),
          await toiletFixture(0, 0.85, 0.55),
        ];
        const next = { ...structuredClone({ ...snapshot, materials: {} }), materials };
        for (const scene of [next.scene, next.beforeScene]) {
          scene.fixtures = structuredClone(fixtures);
          // The second room keeps each product against the wall behind it (room-wall-contact.ts).
          if (place === 'wall')
            for (const fixture of scene.fixtures) fixture.roomPlacement!.againstWall = true;
          for (const fixture of scene.fixtures) lib.projectRoomFixture(room, fixture, aspect);
          // The last is the grey toilet as its standard model.
          lib.showAsStandardModel(scene, scene.fixtures[3].id, materials['toilet-0']);
          lib.projectReconstructionFixture(room, scene.fixtures[3], aspect);
        }
        for (const [view, orbit] of views) {
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(next, reader, { background: '#ffffff' });
            const state = orbit ? lib.fluxOrbitView(orbit) : lib.defaultRoomView();
            const blob = await viewer.export(state, { format: 'png', mode: 'after', longEdge: 1200 });
            out.push({
              place,
              view,
              url: await dataUrl(blob),
              notices: viewer.notices
                .filter((n) => n.severity === 'error')
                .map((n) => n.message)
                .join(' | '),
            });
          } finally {
            viewer.dispose();
          }
        }
      }
      return out;
    },
    { toilets, views: VIEWS },
  )) as { place: string; view: string; url: string; notices: string }[];
  const tiles: { input: Buffer; top: number; left: number }[] = [];
  const W = 600,
    H = 400;
  for (const shot of shots) {
    const png = Buffer.from(shot.url.slice(shot.url.indexOf(',') + 1), 'base64');
    await writeFile(`${output}/${shot.place}-${shot.view}.png`, png);
    const row = shot.place === 'default' ? 0 : 1,
      col = VIEWS.findIndex(([name]) => name === shot.view);
    tiles.push({
      input: await sharp(png).resize(W, H, { fit: 'contain', background: '#ffffff' }).png().toBuffer(),
      top: row * H,
      left: col * W,
    });
    if (shot.notices) console.log(`  ${shot.place} ${shot.view}: ${shot.notices}`);
  }
  await sharp({ create: { width: W * VIEWS.length, height: H * 2, channels: 3, background: '#ffffff' } })
    .composite(tiles)
    .png()
    .toFile(`${output}/sheet.png`);
  console.log(`${label}: ${shots.length} pictures, sheet ${output}/sheet.png`);
  if (errors.length) console.log('page errors:', errors.join(' | '));
} finally {
  await browser.close();
}
