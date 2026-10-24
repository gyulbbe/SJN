/**
 * Real-WebGL pictures of wall products, for the wall contact work (docs/wall-contact-results-20261024.md):
 * the 2D editor's picture (the photo compositor) and the 3D room from the front, right, back and left.
 *
 * The room is the user's report (2026-10-24): a shower set from a 정면 photo only, its visible part the
 * middle 30% of the picture, on the right wall near the back, its anchor on the slide bar. Beside it a
 * wall basin (정면 photo only) on the back wall and a shower with four angle photos on the left wall.
 * The photos are drawn here (sharp, from SVG), nothing is read from a database.
 *
 * Usage: node tests/run-browser-test.mjs tests/wall-contact-browser.ts --label=before [--no-shadow] [--gpu]
 * (--no-shadow: the products' shadow strength 0, the shadow comparison's "none"; --white: white tiled walls).
 * Writes test-results/wall-contact/<label>/<view>.png and <label>/sheet.png.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice(8) ?? 'current';
const noShadow = process.argv.includes('--no-shadow');
const walls: 'white' | 'terrazzo' = process.argv.includes('--white') ? 'white' : 'terrazzo';
const output = `test-results/wall-contact/${label}`;
await mkdir(output, { recursive: true });

const chrome = '#8f979b',
  edge = '#4f585c';
/** A 1000 × 1000 transparent picture with `body` drawn in it, as a data URL. */
const png = async (body: string) =>
  `data:image/png;base64,${(
    await sharp(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">${body}</svg>`),
    )
      .png()
      .toBuffer()
  ).toString('base64')}`;
/** The shower set seen from the front: visible from x 345 to 630 and y 40 to 890 (the user's photo). */
const SHOWER_FRONT = `
  <rect x="588" y="40" width="42" height="190" rx="18" fill="${chrome}" stroke="${edge}" stroke-width="5"/>
  <rect x="600" y="230" width="18" height="470" fill="${chrome}" stroke="${edge}" stroke-width="4"/>
  <rect x="345" y="380" width="230" height="60" rx="10" fill="${chrome}" stroke="${edge}" stroke-width="5"/>
  <rect x="520" y="330" width="34" height="60" fill="${chrome}" stroke="${edge}" stroke-width="4"/>
  <path d="M 450 440 C 430 700 380 885 470 885 C 560 885 600 820 609 700" fill="none" stroke="${edge}" stroke-width="14"/>
  <path d="M 450 440 C 430 700 380 885 470 885 C 560 885 600 820 609 700" fill="none" stroke="${chrome}" stroke-width="8"/>`;
/** Its profile facing left (its back, on the wall, at the picture's right): x 500 to 630. */
const SHOWER_LEFT = `
  <rect x="610" y="40" width="20" height="660" fill="${chrome}" stroke="${edge}" stroke-width="4"/>
  <rect x="500" y="380" width="115" height="60" rx="10" fill="${chrome}" stroke="${edge}" stroke-width="5"/>
  <rect x="540" y="60" width="75" height="150" rx="18" fill="${chrome}" stroke="${edge}" stroke-width="5"/>
  <path d="M 560 440 C 520 700 520 885 570 885 C 610 885 618 820 618 700" fill="none" stroke="${edge}" stroke-width="12"/>`;
/** A white wall basin seen from the front: visible from x 130 to 854 and y 196 to 778. */
const BASIN_FRONT = `
  <path d="M 130 196 L 854 196 L 854 330 C 854 640 700 778 492 778 C 284 778 130 640 130 330 Z" fill="#f2f1ec" stroke="#9a9a94" stroke-width="8"/>
  <rect x="470" y="210" width="44" height="70" rx="8" fill="${chrome}" stroke="${edge}" stroke-width="4"/>`;
const PRODUCTS = [
  {
    key: 'shower',
    name: '샤워 설비',
    category: 'shower',
    widthMm: 330,
    heightMm: 1000,
    depthMm: 150,
    photos: [{ direction: '정면', anchor: { x: 0.62, y: 0.3 }, url: await png(SHOWER_FRONT) }],
  },
  {
    key: 'shower4',
    name: '샤워 설비(네 방향)',
    category: 'shower',
    widthMm: 330,
    heightMm: 1000,
    depthMm: 150,
    photos: [
      { direction: '정면', anchor: { x: 0.5, y: 0.5 }, url: await png(SHOWER_FRONT) },
      { direction: '왼쪽', anchor: { x: 0.5, y: 0.5 }, url: await png(SHOWER_LEFT) },
      {
        direction: '오른쪽',
        anchor: { x: 0.5, y: 0.5 },
        url: await png(`<g transform="translate(1000 0) scale(-1 1)">${SHOWER_LEFT}</g>`),
      },
      {
        direction: '뒤',
        anchor: { x: 0.5, y: 0.5 },
        url: await png(`<g transform="translate(1000 0) scale(-1 1)">${SHOWER_FRONT}</g>`),
      },
    ],
  },
  {
    key: 'basin',
    name: '벽걸이 세면대',
    category: 'basin',
    widthMm: 560,
    heightMm: 560,
    depthMm: 440,
    photos: [{ direction: '정면', anchor: { x: 0.507, y: 0.488 }, url: await png(BASIN_FRONT) }],
  },
];
/** [product, face, u, v] */
const PLACES = [
  ['shower', 'right', 0.15, 0.3],
  ['basin', 'back', 0.35, 0.55],
  ['shower4', 'left', 0.55, 0.35],
] as const;
const VIEWS = [
  ['front', null],
  ['right', { azimuth: 90, elevation: 10 }],
  ['back', { azimuth: 180, elevation: 10 }],
  ['left', { azimuth: -90, elevation: 10 }],
] as const;

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {productContentBounds} from './src/lib/room-fixtures';export {reprojectRoomScene} from './src/lib/room-editing';export {getPlacementViewIndex} from './src/lib/material-images';export {PhotoCompositor} from './src/lib/render/compositor';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Wall',
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
  Pick<typeof import('../src/lib/room-fixtures'), 'productContentBounds'> &
  Pick<typeof import('../src/lib/room-editing'), 'reprojectRoomScene'> &
  Pick<typeof import('../src/lib/material-images'), 'getPlacementViewIndex'> &
  Pick<typeof import('../src/lib/render/compositor'), 'PhotoCompositor'>;
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43224/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43224/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const shots = (await page.evaluate(
    async ({ products, places, views, noShadow, walls }) => {
      const lib = (window as unknown as { Wall: Lib }).Wall;
      const { assets, snapshot } = await lib.buildFluxRoomScene({ walls });
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
          const id = `${item.key}-${j}`;
          assets[id] = {
            id,
            ownerId: 'test',
            name: id,
            mime: blob.type,
            size: blob.size,
            width: 1000,
            height: 1000,
            kind: 'product',
            blob,
            createdAt: '2026-10-24',
          };
          views.push({ assetId: id, direction: photo.direction, anchor: photo.anchor });
        }
        materials[item.key] = {
          ...snapshot.materials.white,
          id: item.key,
          materialId: item.key,
          name: item.name,
          category: item.category as 'shower',
          installation: 'wall',
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          depthMm: item.depthMm,
          textureAssetIds: [],
          views,
        };
      }
      const reader = async (id: string) => assets[id];
      const fixtures = [];
      for (const [i, [key, face, u, v]] of places.entries()) {
        const material = materials[key];
        const viewIndex = lib.getPlacementViewIndex(material, face).index;
        const asset = assets[
          material.views[viewIndex].assetId
        ] as import('../src/lib/types').ImageAssetRecord;
        fixtures.push({
          id: `wall-${i}`,
          name: material.name,
          materialVersionId: key,
          viewIndex,
          position: { x: 0.5, y: 0.5 },
          width: 0.1,
          height: 0.1,
          rotation: 0,
          anchor: { ...material.views[viewIndex].anchor },
          locked: false,
          // What a new product gets in the editor (editor.tsx).
          shadow: { x: 0, y: 0.005, opacity: noShadow ? 0 : 0.3, blur: 0.015, scale: 0.7 },
          occlusion: { polygon: [], strokes: [] },
          color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
          roomPlacement: {
            face,
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
        // As the editor draws them on opening (the read migration).
        lib.reprojectRoomScene(scene, materials);
      }
      const out: { view: string; url: string; notices: string }[] = [];
      // The 2D editor's picture.
      const compositor = new lib.PhotoCompositor();
      try {
        await compositor.setSnapshot(next, reader);
        const canvas = compositor.render(1500, 1000, 'after');
        out.push({ view: '2d', url: canvas.toDataURL('image/png'), notices: '' });
      } finally {
        compositor.dispose();
      }
      for (const [view, orbit] of views) {
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(next, reader, { background: '#ffffff' });
          const state = orbit ? lib.fluxOrbitView(orbit) : lib.defaultRoomView();
          const blob = await viewer.export(state, { format: 'png', mode: 'after', longEdge: 1200 });
          out.push({
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
      return out;
    },
    { products: PRODUCTS, places: PLACES, views: VIEWS, noShadow, walls },
  )) as { view: string; url: string; notices: string }[];
  const tiles: { input: Buffer; top: number; left: number }[] = [];
  const W = 600,
    H = 400;
  for (const [i, shot] of shots.entries()) {
    const picture = Buffer.from(shot.url.slice(shot.url.indexOf(',') + 1), 'base64');
    await writeFile(`${output}/${shot.view}.png`, picture);
    tiles.push({
      input: await sharp(picture).resize(W, H, { fit: 'contain', background: '#ffffff' }).png().toBuffer(),
      top: Math.floor(i / 3) * H,
      left: (i % 3) * W,
    });
    if (shot.notices) console.log(`  ${shot.view}: ${shot.notices}`);
  }
  await sharp({ create: { width: W * 3, height: H * 2, channels: 3, background: '#ffffff' } })
    .composite(tiles)
    .png()
    .toFile(`${output}/sheet.png`);
  console.log(`${label}: ${shots.length} pictures, sheet ${output}/sheet.png`);
  if (errors.length) console.log('page errors:', errors.join(' | '));
} finally {
  await browser.close();
}
