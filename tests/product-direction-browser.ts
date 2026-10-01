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
 * Part B, the eight real product photos (their saved TripoSR meshes, no new AI): every mesh at the
 * 360° editor pose of each of 정면 · 오른쪽 · 왼쪽 · 뒤 (poseForDirection) on the left wall, the back
 * wall and the floor. It checks that the pose reads back as the name, that the product touches its
 * wall or floor and stays inside the room's width, and compares the in-room silhouette from the
 * front with the level 360° capture of the same pose (IoU on the shared bounding box), against the
 * opposite name's capture.
 *
 * Captures go to test-results/product-direction/. Usage:
 *   node tests/run-browser-test.mjs tests/product-direction-browser.ts [--gpu] [--skip-real]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const skipReal = process.argv.includes('--skip-real');
const output = 'test-results/product-direction';
const meshRoot = 'test-results/product3d-batch';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels} from './src/lib/ai-export/client';export {buildViewerFixtures, createSavedProductGeometry} from './src/lib/room-viewer/fixtures';export {makeProductMeshAsset, encodeProductMesh} from './src/lib/product3d/codec';export {ProductRenderer} from './src/lib/product3d/renderer';export {createDefaultPose, levelCameraQuaternion} from './src/lib/product3d/pose';export {poseDirection, poseForDirection} from './src/lib/product3d/direction-pose';export {estimateUprightQuaternion} from './src/lib/product3d/upright';export {DEFAULT_ROOM} from './src/lib/room-geometry';export {projectRoomFixture, productContentBounds} from './src/lib/room-fixtures';export {directionAngle} from './src/lib/product-direction';export {Box3, Vector3, Quaternion} from 'three';`,
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
  Pick<
    typeof import('../src/lib/room-viewer/fixtures'),
    'buildViewerFixtures' | 'createSavedProductGeometry'
  > &
  Pick<typeof import('../src/lib/product3d/codec'), 'makeProductMeshAsset' | 'encodeProductMesh'> &
  Pick<typeof import('../src/lib/product3d/renderer'), 'ProductRenderer'> &
  Pick<typeof import('../src/lib/product3d/pose'), 'createDefaultPose' | 'levelCameraQuaternion'> &
  Pick<typeof import('../src/lib/product3d/direction-pose'), 'poseDirection' | 'poseForDirection'> &
  Pick<typeof import('../src/lib/product3d/upright'), 'estimateUprightQuaternion'> &
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

  // ───────────────────────────── Part B: eight real meshes ─────────────────────────────
  type RealRow = {
    product: string;
    name: string;
    face: string;
    poseAngle: number;
    elevation: number;
    iou: number;
    iouOpposite: number;
    iouOthers: number;
    similarity: number;
    outline: { ownAspect: number; aspect: number; dx: number; dy: number; fill: number };
    touch: number;
    inside: boolean;
    refUrl: string;
    roomUrl: string;
  };
  const realRows: RealRow[] = [];
  if (!skipReal && existsSync(`${meshRoot}/summary.json`)) {
    const products = [
      '01-shelf',
      '02-smart-toilet',
      '03-bathtub-rect',
      '04-bathtub-scene',
      '05-bathtub-top',
      '06-paper-holder',
      '07-stool',
      '08-mirror',
    ].filter((p) => existsSync(`${meshRoot}/${p}/mesh-positions.bin`));
    for (const product of products) {
      const files: Record<string, string> = {};
      for (const name of ['mesh-positions.bin', 'mesh-indices.bin', 'mesh-colors.bin'])
        files[name] = (await readFile(`${meshRoot}/${product}/${name}`)).toString('base64');
      const rows = (await page.evaluate(
        async ({ product, files }) => {
          const lib = (window as unknown as { Direction: Lib }).Direction;
          const dataUrl = (blob: Blob) =>
            new Promise<string>((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result as string);
              r.readAsDataURL(blob);
            });
          const decode = (name: string) => Uint8Array.from(atob(files[name]), (c) => c.charCodeAt(0));
          const mesh = {
            positions: new Float32Array(decode('mesh-positions.bin').buffer),
            indices: new Uint32Array(decode('mesh-indices.bin').buffer),
            colors: new Float32Array(decode('mesh-colors.bin').buffer),
          };
          const meshAsset = await lib.makeProductMeshAsset(mesh, 'mesh', 'input');
          const upright = lib.estimateUprightQuaternion(mesh.positions);
          const { assets, snapshot, aspect, room } = await lib.buildFluxRoomScene();
          const empty = () => ({ polygon: [], strokes: [] });
          const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
          const reader = async (id: string) => (id === 'mesh' ? meshAsset : assets[id]);
          // 2D reference: the 360° editor's capture of a pose, from a level camera, as an alpha mask.
          const canvas = document.createElement('canvas');
          document.body.append(canvas);
          const productRenderer = new lib.ProductRenderer(canvas, mesh);
          productRenderer.resize(384, 384, 1);
          const capture = async (pose: ReturnType<typeof lib.createDefaultPose>) => {
            productRenderer.setShading('baked');
            productRenderer.setPose({
              objectQuaternion: pose.objectQuaternion,
              cameraQuaternion: lib
                .levelCameraQuaternion(new lib.Quaternion(...pose.cameraQuaternion))
                .toArray() as typeof pose.cameraQuaternion,
              zoom: 1,
            });
            const { blob } = await productRenderer.capture();
            const pixels = await lib.readPixels(blob);
            return { blob, pixels };
          };
          const alphaBox = (p: { width: number; height: number; data: ArrayLike<number> }) => {
            let x0 = p.width,
              x1 = -1,
              y0 = p.height,
              y1 = -1;
            for (let y = 0; y < p.height; y++)
              for (let x = 0; x < p.width; x++) {
                if (p.data[(y * p.width + x) * 4 + 3] < 128) continue;
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
              }
            return { x0, x1, y0, y1 };
          };
          const GRID = 64;
          // The mask over its own bounding box, sampled on a GRID × GRID grid.
          const grid = (inside: (x: number, y: number) => boolean, box: ReturnType<typeof alphaBox>) => {
            const out = new Uint8Array(GRID * GRID);
            const w = box.x1 - box.x0 + 1,
              h = box.y1 - box.y0 + 1;
            for (let j = 0; j < GRID; j++)
              for (let i = 0; i < GRID; i++)
                out[j * GRID + i] = inside(
                  box.x0 + Math.min(w - 1, Math.floor(((i + 0.5) / GRID) * w)),
                  box.y0 + Math.min(h - 1, Math.floor(((j + 0.5) / GRID) * h)),
                )
                  ? 1
                  : 0;
            return out;
          };
          const iou = (a: Uint8Array, b: Uint8Array) => {
            let both = 0,
              either = 0;
            for (let i = 0; i < a.length; i++) {
              if (a[i] && b[i]) both++;
              if (a[i] || b[i]) either++;
            }
            return either ? both / either : 0;
          };
          // Outline, in numbers: width:height of the bounding box, the mass's centre inside it, how much of it is filled.
          const shape = (g: Uint8Array, box: ReturnType<typeof alphaBox>) => {
            let n = 0,
              sx = 0,
              sy = 0;
            for (let j = 0; j < GRID; j++)
              for (let i = 0; i < GRID; i++)
                if (g[j * GRID + i]) {
                  n++;
                  sx += (i + 0.5) / GRID;
                  sy += (j + 0.5) / GRID;
                }
            return {
              aspect: (box.x1 - box.x0 + 1) / (box.y1 - box.y0 + 1),
              cx: n ? sx / n : 0,
              cy: n ? sy / n : 0,
              fill: n / (GRID * GRID),
            };
          };
          const refGrid = async (pose: ReturnType<typeof lib.createDefaultPose>) => {
            const { pixels, blob } = await capture(pose);
            const box = alphaBox(pixels);
            const g = grid((x, y) => pixels.data[(y * pixels.width + x) * 4 + 3] >= 128, box);
            return { grid: g, shape: shape(g, box), url: await dataUrl(blob) };
          };
          const names = ['정면', '오른쪽', '왼쪽', '뒤'] as const;
          const opposite = { 정면: '뒤', 뒤: '정면', 오른쪽: '왼쪽', 왼쪽: '오른쪽' } as const;
          const poses = Object.fromEntries(
            names.map((n) => [
              n,
              { ...lib.poseForDirection(lib.createDefaultPose(), n), objectQuaternion: upright },
            ]),
          ) as Record<(typeof names)[number], ReturnType<typeof lib.createDefaultPose>>;
          // One capture at a time: the renderer's capture is not re-entrant.
          const refs = {} as Record<(typeof names)[number], Awaited<ReturnType<typeof refGrid>>>;
          for (const n of names) refs[n] = await refGrid(poses[n]);
          const half = lib.DEFAULT_ROOM.widthMm / 2;
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
          const out: Record<string, unknown>[] = [];
          for (const name of names) {
            const pose = poses[name];
            const read = lib.poseDirection(pose);
            // The mesh's natural outline at this pose, fitted into 1000 × 1000 mm, then shrunk.
            const fit = (width: number, height: number) => ({
              ...snapshot.materials.standard,
              id: 'real',
              materialId: 'real',
              name: product,
              category: 'basin' as const,
              installation: 'wall' as const,
              widthMm: width,
              heightMm: height,
              depthMm: 300,
              textureAssetIds: [],
              views: [
                {
                  assetId: 'input',
                  direction: name,
                  anchor: { x: 0.5, y: 0.5 },
                  product3d: {
                    version: 1 as const,
                    meshAssetId: 'mesh',
                    inputAssetId: 'input',
                    modelId: 'saved',
                    modelRevision: 'saved',
                    pose,
                  },
                },
              ],
            });
            for (const face of ['left', 'back', 'floor'] as const) {
              const base = {
                id: 'real',
                name: product,
                materialVersionId: 'real',
                viewIndex: 0,
                position: { x: 0.5, y: 0.5 },
                width: 0.1,
                height: 0.1,
                rotation: 0,
                anchor: { x: 0.5, y: face === 'floor' ? 1 : 0.5 },
                locked: false,
                shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
                occlusion: empty(),
                color: { ...color },
                roomPlacement: {
                  face,
                  u: 0.5,
                  v: face === 'floor' ? 0.5 : 0.45,
                  scale: 1,
                  widthMm: 1000,
                  heightMm: 1000,
                  imageAspect: 1,
                  contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
                },
              };
              // Natural outline: fit into 1000 × 1000, read its size, then shrink to a 450 mm box.
              const geometry = lib.createSavedProductGeometry(
                mesh,
                fit(1000, 1000).views[0].product3d,
                base as never,
              );
              const size = geometry.boundingBox!.getSize(new lib.Vector3());
              geometry.dispose();
              const shrink = 650 / Math.max(size.x, size.y);
              const widthMm = size.x * shrink,
                heightMm = size.y * shrink;
              base.roomPlacement.widthMm = widthMm;
              base.roomPlacement.heightMm = heightMm;
              base.roomPlacement.imageAspect = widthMm / heightMm;
              const next = structuredClone(snapshot);
              next.materials.real = fit(widthMm, heightMm);
              for (const scene of [next.scene, next.beforeScene]) {
                scene.fixtures = [structuredClone(base)];
                lib.projectRoomFixture(room, scene.fixtures[0], aspect);
              }
              // Contact and room: the fixtures as built.
              const built = await lib.buildViewerFixtures(next.scene, next.materials, reader);
              const bounds = shownBounds(built.group);
              const touch =
                face === 'left'
                  ? Math.abs(bounds.min.x + half)
                  : face === 'back'
                    ? Math.abs(bounds.min.z)
                    : Math.abs(bounds.min.y);
              const inside = bounds.min.x >= -half - 0.5 && bounds.max.x <= half + 0.5;
              built.dispose();
              let iouValue = -1,
                iouOpposite = -1,
                iouOthers = -1,
                outline = { ownAspect: 0, aspect: 0, dx: 9, dy: 9, fill: 0 },
                roomUrl = '';
              if (face === 'left' || face === 'back') {
                const viewer = new lib.RoomViewerRenderer();
                try {
                  await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
                  const view = lib.fluxOrbitView({ azimuth: 0, elevation: 0 });
                  const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1536 });
                  const pixels = await lib.readPixels(blob);
                  const mask = viewer.regionMask(pixels.width, pixels.height, view);
                  const box = (() => {
                    let x0 = pixels.width,
                      x1 = -1,
                      y0 = pixels.height,
                      y1 = -1;
                    for (let y = 0; y < pixels.height; y++)
                      for (let x = 0; x < pixels.width; x++)
                        if (mask.data[y * pixels.width + x] === 255) {
                          x0 = Math.min(x0, x);
                          x1 = Math.max(x1, x);
                          y0 = Math.min(y0, y);
                          y1 = Math.max(y1, y);
                        }
                    return { x0, x1, y0, y1 };
                  })();
                  if (box.x1 >= 0) {
                    const g = grid((x, y) => mask.data[y * pixels.width + x] === 255, box);
                    iouValue = iou(g, refs[name].grid);
                    iouOpposite = iou(g, refs[opposite[name]].grid);
                    iouOthers = Math.max(...names.filter((n) => n !== name).map((n) => iou(g, refs[n].grid)));
                    const seen = shape(g, box),
                      own = refs[name].shape;
                    outline = {
                      ownAspect: own.aspect,
                      aspect: seen.aspect / own.aspect,
                      dx: seen.cx - own.cx,
                      dy: seen.cy - own.cy,
                      fill: own.fill,
                    };
                  }
                  roomUrl = await dataUrl(blob);
                } finally {
                  viewer.dispose();
                }
              }
              out.push({
                product,
                name,
                face,
                poseAngle: read.angle,
                elevation: read.elevation,
                iou: iouValue,
                iouOpposite,
                iouOthers,
                // How alike this pose's capture and the opposite name's are: a side that looks like
                // its opposite cannot be told apart by an outline.
                similarity: Math.max(
                  ...names.filter((n) => n !== name).map((n) => iou(refs[name].grid, refs[n].grid)),
                ),
                outline,
                touch,
                inside,
                refUrl: refs[name].url,
                roomUrl,
              });
            }
          }
          productRenderer.dispose();
          canvas.remove();
          return out;
        },
        { product, files },
      )) as RealRow[];
      realRows.push(...rows);
    }
    console.log(
      '\nPart B — real meshes, back wall centre: IoU with the 360° capture of its own pose / best of the other names (~ outline too alike to tell apart)',
    );
    for (const r of realRows) {
      if (r.face === 'left') {
        await writeFile(`${output}/real-${r.product}-${r.name}-room.png`, toPng(r.roomUrl));
        await writeFile(`${output}/real-${r.product}-${r.name}-2d.png`, toPng(r.refUrl));
      }
    }
    for (const product of new Set(realRows.map((r) => r.product))) {
      const mine = realRows.filter((r) => r.product === product && r.face === 'back');
      console.log(
        `${product.padEnd(18)} ${mine.map((r) => `${r.name} ${r.iou.toFixed(2)}/${r.iouOthers.toFixed(2)}${r.similarity >= 0.88 ? '~' : ''}`).join('  ')}`,
      );
    }
    for (const r of realRows) {
      const target = { 정면: 0, 오른쪽: 90, 왼쪽: -90, 뒤: 180 }[r.name]!;
      const turn = Math.abs(((r.poseAngle - target + 540) % 360) - 180);
      check(turn < 1, `${r.product} ${r.name}: the pose reads back as the name (off by ${turn.toFixed(2)}°)`);
      check(
        r.touch < 0.5,
        `${r.product} ${r.name} ${r.face}: touches its wall/floor (${r.touch.toFixed(2)} mm off)`,
      );
      check(r.inside, `${r.product} ${r.name} ${r.face}: stays inside the room's width`);
      if (r.face === 'back') {
        // The room is seen in perspective and the capture straight on, and thin parts (a pole, stool
        // legs) lose pixels: the outlines are close, not equal. Every product must keep the capture's
        // width:height and where its mass sits; a solid one must also overlap it.
        const o = r.outline;
        // (An edge-on plate has no width to compare.)
        if (o.ownAspect > 0.3 && o.ownAspect < 3.5)
          check(
            Math.abs(o.aspect - 1) < 0.2,
            `${r.product} ${r.name}: the outline's width:height is the capture's (x${o.aspect.toFixed(2)})`,
          );
        check(
          Math.abs(o.dx) < 0.08 && Math.abs(o.dy) < 0.08,
          `${r.product} ${r.name}: the mass sits where the capture has it (${o.dx.toFixed(2)}, ${o.dy.toFixed(2)})`,
        );
        if (o.fill >= 0.25)
          check(
            r.iou >= 0.7,
            `${r.product} ${r.name}: the room shows what the 360 capture shows (IoU ${r.iou.toFixed(2)})`,
          );
        // Names whose captures look alike (a stool, a mirror seen edge on) cannot be told apart by an outline.
        if (r.similarity < 0.88)
          check(
            r.iou >= r.iouOthers - 0.02,
            `${r.product} ${r.name}: closer to its own capture than to another name's (${r.iou.toFixed(2)} vs ${r.iouOthers.toFixed(2)})`,
          );
      }
    }
    // Contact sheet: one row per product; per name the 360° capture and the room's front view.
    {
      const names = ['정면', '오른쪽', '왼쪽', '뒤'];
      const list = [...new Set(realRows.map((r) => r.product))];
      const tile = 200;
      const cells: OverlayOptions[] = [];
      for (const [row, product] of list.entries())
        for (const [column, name] of names.entries()) {
          const r = realRows.find((x) => x.product === product && x.name === name && x.face === 'left')!;
          cells.push({
            input: await sharp(toPng(r.refUrl))
              .resize(tile, tile, { fit: 'contain', background: '#ffffff' })
              .flatten({ background: '#ffffff' })
              .png()
              .toBuffer(),
            left: column * 2 * tile,
            top: row * tile,
          });
          cells.push({
            input: await sharp(toPng(r.roomUrl)).resize(tile, tile, { fit: 'cover' }).png().toBuffer(),
            left: (column * 2 + 1) * tile,
            top: row * tile,
          });
        }
      await sharp({
        create: { width: tile * 8, height: tile * list.length, channels: 3, background: '#ffffff' },
      })
        .composite(cells)
        .png()
        .toFile(`${output}/real-sheet${gpu ? '-gpu' : ''}.png`);
    }
  }

  await writeFile(
    `${output}/summary${gpu ? '-gpu' : ''}.json`,
    JSON.stringify(
      {
        photo: photoRows.map((r) => ({ ...r, url: undefined })),
        real: realRows.map((r) => ({ ...r, refUrl: undefined, roomUrl: undefined })),
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
