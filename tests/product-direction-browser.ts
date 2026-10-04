/**
 * Real-WebGL check that an angle name is the product's direction, with no other setting.
 *
 * Part A, a photo basin (400 × 300 px photos, an asymmetric 오른쪽 photo with the tap at its right
 * end) placed three ways: on the left wall with the 오른쪽 photo (the name that suits that wall), on
 * the left wall with the 정면 photo, and on the back wall with the 정면 photo. Each is drawn as the
 * space viewer's front view and as the AI export's front input (white backdrop, export photo
 * choice), and compared with the 2D photo: the picture's width : height, and where the asymmetric
 * photo's tap sits, must be the photo's. A top view shows the plane standing on its wall. Before
 * the angle name decided the direction, a left-wall photo was turned 90° and was edge-on here.
 *
 * (A Part B used saved 360° meshes; the 360° editor was removed, see docs/product3d-removal.md.)
 *
 * Captures go to test-results/product-direction/. Usage:
 *   node tests/run-browser-test.mjs tests/product-direction-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/product-direction';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels} from './src/lib/ai-export/client';export {buildViewerFixtures} from './src/lib/room-viewer/fixtures';export {DEFAULT_ROOM} from './src/lib/room-geometry';export {projectRoomFixture, productContentBounds} from './src/lib/room-fixtures';export {directionAngle} from './src/lib/product-direction';export {Box3, Vector3, Quaternion} from 'three';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Direction',
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
  Pick<typeof import('../src/lib/ai-export/client'), 'readPixels'> &
  Pick<typeof import('../src/lib/room-viewer/fixtures'), 'buildViewerFixtures'> &
  Pick<typeof import('../src/lib/room-geometry'), 'DEFAULT_ROOM'> &
  Pick<typeof import('../src/lib/room-fixtures'), 'projectRoomFixture' | 'productContentBounds'> &
  Pick<typeof import('../src/lib/product-direction'), 'directionAngle'> &
  Pick<typeof import('three'), 'Box3' | 'Vector3' | 'Quaternion'>;

const toPng = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const failures: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) {
    failures.push(message);
    console.log('  ✗', message);
  }
};
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43221/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43221/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  // ───────────────────────────── Part A: the photo basin ─────────────────────────────
  const photoCases = [
    { id: 'left-오른쪽', face: 'left', name: '오른쪽' },
    { id: 'left-정면', face: 'left', name: '정면' },
    { id: 'back-정면', face: 'back', name: '정면' },
  ] as const;
  type PhotoRow = {
    id: string;
    view: string;
    box: { width: number; height: number; aspect: number; tap: number; pixels: number };
    photo: { aspect: number; tap: number };
    contact: { edge: number; reach: number };
    notice: string;
    url: string;
  };
  const photoRows = (await page.evaluate(
    async ({ cases }) => {
      const lib = (window as unknown as { Direction: Lib }).Direction;
      const dataUrl = (blob: Blob) =>
        new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
      const { assets, snapshot, imageWidth, imageHeight, aspect, room } = await lib.buildFluxRoomScene();
      const draw = (kind: 'front' | 'right') => {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const c = canvas.getContext('2d')!;
        c.fillStyle = '#1f66e0';
        if (kind === 'front') {
          c.fillRect(40, 130, 320, 150); // a bowl, symmetric
          c.fillStyle = '#082a6b';
          c.fillRect(190, 50, 20, 80); // the tap in the middle
        } else {
          c.fillRect(30, 130, 240, 150); // a narrower bowl, the tap arm out to the right
          c.fillStyle = '#082a6b';
          c.fillRect(240, 70, 30, 60);
          c.fillRect(270, 70, 110, 24);
        }
        return canvas;
      };
      const addPhoto = async (id: string, canvas: HTMLCanvasElement) => {
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
        assets[id] = {
          id,
          ownerId: 'test',
          name: id,
          mime: 'image/png',
          size: blob.size,
          width: canvas.width,
          height: canvas.height,
          kind: 'product',
          blob,
          createdAt: '2026-10-01',
        };
      };
      await addPhoto('basin-front', draw('front'));
      await addPhoto('basin-right', draw('right'));
      // What the photo itself shows: its opaque outline's width : height and where the tap sits.
      const stats = async (id: string) => {
        const pixels = await lib.readPixels(assets[id].blob!);
        let x0 = 1e9,
          x1 = -1,
          y0 = 1e9,
          y1 = -1,
          tapX = 0,
          tapN = 0;
        for (let y = 0; y < pixels.height; y++)
          for (let x = 0; x < pixels.width; x++) {
            const o = (y * pixels.width + x) * 4;
            if (pixels.data[o + 3] < 128) continue;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
            if (pixels.data[o + 2] < 150) {
              tapX += x;
              tapN++;
            }
          }
        const width = x1 - x0 + 1;
        return { aspect: width / (y1 - y0 + 1), tap: (tapX / tapN - x0) / width };
      };
      const photoStats: Record<string, { aspect: number; tap: number }> = {
        정면: await stats('basin-front'),
        오른쪽: await stats('basin-right'),
      };
      const material = {
        ...snapshot.materials.standard,
        id: 'basin-photo',
        materialId: 'basin-photo',
        name: '세면대',
        category: 'basin' as const,
        installation: 'wall' as const,
        widthMm: 520,
        heightMm: 380,
        depthMm: 420,
        textureAssetIds: [],
        views: [
          { assetId: 'basin-front', direction: '정면', anchor: { x: 0.5, y: 0.5 } },
          { assetId: 'basin-right', direction: '오른쪽', anchor: { x: 0.5, y: 0.5 } },
        ],
      };
      const empty = () => ({ polygon: [], strokes: [] });
      const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
      const reader = async (id: string) => assets[id];
      // What the viewer shows: planes of the other photos of a product stay in the group, hidden.
      const shownBounds = (root: import('three').Object3D) => {
        const box = new lib.Box3();
        root.updateWorldMatrix(true, true);
        root.traverse((o) => {
          if (!(o as import('three').Mesh).isMesh) return;
          for (let n: import('three').Object3D | null = o; n; n = n.parent) if (!n.visible) return;
          box.union(new lib.Box3().setFromObject(o, true));
        });
        return box;
      };
      // The lit bowl is bright blue, the tap navy: both are bluer than any grey of the room.
      const isBlue = (r: number, g: number, b: number) => b > 50 && b - r > 35 && b - g > 12;
      const measure = (pixels: { width: number; height: number; data: ArrayLike<number> }) => {
        let x0 = 1e9,
          x1 = -1,
          y0 = 1e9,
          y1 = -1,
          n = 0,
          tapX = 0,
          tapN = 0;
        for (let y = 0; y < pixels.height; y++)
          for (let x = 0; x < pixels.width; x++) {
            const o = (y * pixels.width + x) * 4;
            const [r, g, b] = [pixels.data[o], pixels.data[o + 1], pixels.data[o + 2]];
            if (!isBlue(r, g, b)) continue;
            n++;
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
            // The dark tap (darker than the bowl) for where it sits in the product.
            if (b < 150) {
              tapX += x;
              tapN++;
            }
          }
        if (!n) return { width: 0, height: 0, aspect: 0, tap: 0, pixels: 0, x0, y0 };
        const width = x1 - x0 + 1;
        return {
          width,
          height: y1 - y0 + 1,
          aspect: width / (y1 - y0 + 1),
          tap: tapN ? (tapX / tapN - x0) / width : -1,
          pixels: n,
          x0,
          y0,
        };
      };
      const out: PhotoRow[] = [];
      for (const item of cases) {
        const next = structuredClone(snapshot);
        next.materials['basin-photo'] = material;
        const bounds = await lib.productContentBounds(
          assets[item.name === '정면' ? 'basin-front' : 'basin-right'],
        );
        const base = {
          id: 'basin',
          name: '세면대',
          materialVersionId: 'basin-photo',
          viewIndex: item.name === '정면' ? 0 : 1,
          position: { x: 0.5, y: 0.5 },
          width: 0.1,
          height: 0.1,
          rotation: 0,
          anchor: { x: 0.5, y: 0.5 },
          locked: false,
          shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
          occlusion: empty(),
          color: { ...color },
          roomPlacement: {
            face: item.face,
            u: 0.5,
            v: 0.5,
            scale: 1,
            widthMm: 520,
            heightMm: 380,
            imageAspect: 400 / 300,
            contentBounds: bounds,
          },
        };
        for (const scene of [next.scene, next.beforeScene]) {
          scene.fixtures = [structuredClone(base)];
          lib.projectRoomFixture(room, scene.fixtures[0], aspect);
        }
        // The product as built: how far its edge is from the wall it stands on, and the farthest it
        // reaches into the room along the wall's normal.
        const built = await lib.buildViewerFixtures(next.scene, next.materials, reader);
        const solid = shownBounds(built.group);
        const half = lib.DEFAULT_ROOM.widthMm / 2;
        const contact = {
          edge: item.face === 'left' ? Math.abs(solid.min.x + half) : Math.abs(solid.min.z - 1),
          reach: solid.max.z - solid.min.z,
        };
        built.dispose();
        // viewer-front: the space viewer; ai-*: the export (white backdrop, export photo choice).
        const modes = [
          ['viewer-front', lib.defaultRoomView(), false],
          ['ai-front', lib.fluxOrbitView({ azimuth: 0, elevation: 0 }), true],
          ['ai-top', lib.fluxOrbitView({ azimuth: 0, elevation: 90 }), true],
          ['ai-right', lib.fluxOrbitView({ azimuth: 90, elevation: 0 }), true],
        ] as const;
        for (const [view, state, exportAngles] of modes) {
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles });
            const blob = await viewer.export(state, { format: 'png', mode: 'after', longEdge: 2048 });
            const pixels = await lib.readPixels(blob);
            const box = measure(pixels);
            out.push({
              id: item.id,
              view,
              box,
              photo: photoStats[item.name],
              contact,
              notice: viewer.notices.map((n) => n.message).join(' | '),
              url: await dataUrl(blob),
            });
          } finally {
            viewer.dispose();
          }
        }
      }
      void imageWidth;
      void imageHeight;
      return out;
    },
    { cases: photoCases },
  )) as PhotoRow[];
  console.log('\nPart A — photo basin');
  for (const row of photoRows) {
    await writeFile(`${output}/photo-${row.id}-${row.view}.png`, toPng(row.url));
    console.log(
      `${row.id.padEnd(10)} ${row.view.padEnd(13)} ${String(row.box.width).padStart(4)}×${String(row.box.height).padEnd(4)} 가로:세로 ${row.box.aspect.toFixed(2)} (사진 ${row.photo.aspect.toFixed(2)})  수도꼭지 ${row.box.tap.toFixed(2)} (사진 ${row.photo.tap.toFixed(2)})` +
        `  벽까지 ${row.contact.edge.toFixed(3)}mm`,
    );
  }
  for (const id of photoCases.map((c) => c.id))
    for (const view of ['viewer-front', 'ai-front']) {
      const r = photoRows.find((x) => x.id === id && x.view === view)!;
      check(
        Math.abs(r.box.aspect / r.photo.aspect - 1) < 0.06,
        `${id} ${view}: the photo's width:height (${r.box.aspect.toFixed(2)} vs ${r.photo.aspect.toFixed(2)})`,
      );
      check(
        Math.abs(r.box.tap - r.photo.tap) < 0.1,
        `${id} ${view}: the tap sits where the photo has it (${r.box.tap.toFixed(2)} vs ${r.photo.tap.toFixed(2)})`,
      );
    }
  // The plane stands on its wall, perpendicular to it only as far as the photo is thick (none).
  for (const id of photoCases.map((c) => c.id)) {
    const r = photoRows.find((x) => x.id === id && x.view === 'viewer-front')!;
    check(r.contact.edge < 0.01, `${id}: it touches its wall (${r.contact.edge.toFixed(3)} mm off)`);
    check(r.contact.reach < 0.01, `${id}: a flat photo has no depth (${r.contact.reach.toFixed(3)} mm)`);
  }
  // From the right the plane is a fixed room object, now edge-on (it does not follow the camera).
  for (const id of photoCases.map((c) => c.id)) {
    const r = photoRows.find((x) => x.id === id && x.view === 'ai-right')!;
    console.log(`${id.padEnd(10)} ai-right 폭 ${r.box.width}px (${r.notice.slice(0, 60)})`);
  }
  const noticeOf = (id: string) => photoRows.find((x) => x.id === id && x.view === 'viewer-front')!.notice;
  check(!noticeOf('left-오른쪽').includes('어울리는 각도가 아니에요'), 'left-오른쪽: no mismatch warning');
  check(noticeOf('left-정면').includes('어울리는 각도가 아니에요'), 'left-정면: warns it does not suit');
  check(!noticeOf('back-정면').includes('어울리는 각도가 아니에요'), 'back-정면: no mismatch warning');

  // Contact sheet: one row per case, columns viewer-front · ai-front · ai-top · ai-right.
  {
    const views = ['viewer-front', 'ai-front', 'ai-top', 'ai-right'];
    const first = await sharp(toPng(photoRows[0].url)).metadata();
    const tile = { width: 360, height: Math.round((360 * first.height!) / first.width!) };
    const label = 24;
    const cells = (
      await Promise.all(
        photoCases.flatMap((item, row) =>
          views.map(async (view, column) => {
            const r = photoRows.find((x) => x.id === item.id && x.view === view)!;
            const text = `${item.face === 'left' ? '왼쪽 벽' : '뒤 벽'} · ‘${item.name}’ · ${view} · ${r.box.width}px`;
            const caption = Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${label}"><rect width="100%" height="100%" fill="#eeeeee"/><text x="6" y="17" font-family="sans-serif" font-size="12" fill="#222">${text}</text></svg>`,
            );
            const top = row * (tile.height + label),
              left = column * tile.width;
            return [
              {
                input: await sharp(toPng(r.url)).resize(tile.width, tile.height).png().toBuffer(),
                left,
                top: top + label,
              },
              { input: caption, left, top },
            ];
          }),
        ),
      )
    ).flat();
    await sharp({
      create: {
        width: tile.width * views.length,
        height: photoCases.length * (tile.height + label),
        channels: 3,
        background: '#cccccc',
      },
    })
      .composite(cells)
      .png()
      .toFile(`${output}/photo-sheet${gpu ? '-gpu' : ''}.png`);
  }

  await writeFile(
    `${output}/summary${gpu ? '-gpu' : ''}.json`,
    JSON.stringify(
      {
        photo: photoRows.map((r) => ({ ...r, url: undefined })),
        failures,
      },
      null,
      2,
    ),
  );
  const pageErrors = errors.filter((e) => !/WebGL|GPU stall|swiftshader/i.test(e));
  check(pageErrors.length === 0, `no page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else console.log('\nall checks passed');
assert.equal(failures.length, 0);
