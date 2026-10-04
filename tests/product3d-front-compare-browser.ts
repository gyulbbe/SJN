/**
 * What the 정면 of a product looks like, for the four registered products (docs/product3d-editor.md,
 * "정면이 대각선 사진일 때"). No AI call: the saved 3D models of the materials registered by
 * tests/product3d-auto-save-real-browser.ts are drawn again. For each product, in files named
 * test-results/product3d-front-compare/<key>-*.png:
 *   photo       the cut-out photo the model was made from
 *   now         the saved 정면: the pose the name gives (the product's front, what the editor saves)
 *   photo-side  the same model seen from the side the photo was taken from (the alternative)
 *   room-flat   the 3D room seen from the front with the original flat 정면 photo standing in it
 *   room-3d     the same room with the saved 3D 정면 instead
 * and <key>.json with the angle between the two poses. Plus sheet-poses.png and sheet-room.png.
 *
 * Needs the dev server (npm run dev), a signed-in admin session in test-results/e2e-flow/state.json and
 * the four materials. Usage: node tests/run-browser-test.mjs tests/product3d-front-compare-browser.ts
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';

const BASE = 'http://127.0.0.1:3000';
const ROOT = 'test-results/e2e-flow';
const out = 'test-results/product3d-front-compare';
mkdirSync(out, { recursive: true });
const products = JSON.parse(readFileSync(`${ROOT}/products.json`, 'utf8')) as Record<
  string,
  { name: string; category: string; width: number; height: number; depth: number; install: string }
>;
const keys = (process.argv[3] ?? 'bear-toilet,smart-toilet,bathtub,basin').split(',');

const bundle = await build({
  stdin: {
    contents: `
      import { Matrix4, Quaternion, Vector3 } from 'three';
      export * from './src/lib/room-viewer/renderer';
      export * from './src/lib/ai-export/view';
      export { buildFluxRoomScene } from './tests/helpers/flux-room-scene';
      export { decodeProductMesh } from './src/lib/product3d/codec';
      export { ProductRenderer } from './src/lib/product3d/renderer';
      export { preparePaintedMesh, prepareFittedMesh, prepareProductSurface } from './src/lib/product3d/surface';
      export { decodeProductPhoto } from './src/lib/product3d/input-cutout';
      export { fittedPhotoDirection } from './src/lib/product3d/fit';
      export { poseDirection } from './src/lib/product3d/direction-pose';
      export { projectRoomFixture, createRoomPlacement } from './src/lib/room-fixtures';
      /** The camera on the side the photo was taken from, level, at the editor's 10° height. */
      export function poseTowardPhoto(pose, fit) {
        const photo = new Vector3(...fittedPhotoDirection(fit)).applyQuaternion(new Quaternion(...pose.objectQuaternion));
        const azimuth = Math.atan2(photo.y, photo.x);
        const e = (10 * Math.PI) / 180;
        const back = new Vector3(Math.cos(azimuth) * Math.cos(e), Math.sin(azimuth) * Math.cos(e), Math.sin(e));
        const right = new Vector3(-Math.sin(azimuth), Math.cos(azimuth), 0);
        const up = new Vector3().crossVectors(back, right);
        const camera = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, back));
        return { ...pose, cameraQuaternion: camera.toArray() };
      }
      import { fittedPhotoDirection } from './src/lib/product3d/fit';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Lib',
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
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'],
});
type Shot = {
  key: string;
  photo: string;
  now: string;
  photoSide: string;
  roomFlat: string;
  room3d: string;
  frameBox: [number, number, number, number];
  flatBox: [number, number, number, number];
  poses: { now: { angle: number; elevation: number }; photoSide: { angle: number; elevation: number } };
  turn: number;
};
const shots: Shot[] = [];
try {
  const context = await browser.newContext({
    storageState: `${ROOT}/state.json`,
    viewport: { width: 1300, height: 900 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A blank page of the app's own origin: the session cookie reaches the storage API from it.
  await page.route(`${BASE}/blank-compare`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto(`${BASE}/blank-compare`);
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
  for (const key of keys) {
    const p = products[key];
    const shot = (await page.evaluate(
      async ({ key, name, category, size }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lib = (window as unknown as { Lib: Record<string, any> }).Lib;
        const post = async (resource: string, body: unknown) => {
          const response = await fetch(`/api/d1/${resource}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`${resource}: ${response.status}`);
          return response.json();
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: { material: { updatedAt: string }; version: Record<string, any> }[] = await post(
          'materials',
          { operation: 'list' },
        );
        const found = list
          .filter((entry) => entry.version.name === name)
          .sort((a, b) => b.material.updatedAt.localeCompare(a.material.updatedAt))[0];
        if (!found) throw new Error(`no material named ${name}`);
        const view = found.version.views[0];
        const ref = view.product3d;
        if (!ref) throw new Error(`${name}: the 정면 is not 3D`);
        const rawAsset = async (id: string) => {
          const meta = await (await fetch(`/api/d1/assets?id=${encodeURIComponent(id)}`)).json();
          const url = (meta.url ?? meta.asset?.url) as string;
          const response = await fetch(
            url.includes('raw=1') ? url : `${url}${url.includes('?') ? '&' : '?'}raw=1`,
          );
          return { meta: meta.asset ?? meta, blob: await response.blob() };
        };
        const meshRaw = await rawAsset(ref.meshAssetId);
        const photoRaw = await rawAsset(ref.inputAssetId);
        const captureRaw = await rawAsset(view.assetId);
        const mesh = await lib.decodeProductMesh(meshRaw.blob);
        const photoBlob = photoRaw.blob;
        const sizeOf = async (blob: Blob) => {
          const bitmap = await createImageBitmap(blob);
          const dims = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          return dims;
        };
        const photoDims = await sizeOf(photoBlob),
          captureDims = await sizeOf(captureRaw.blob);
        const asset = (id: string, kind: string, blob: Blob, extra = {}) => ({
          id,
          ownerId: 'local',
          name: id,
          kind,
          mime: blob.type,
          size: blob.size,
          width: 512,
          height: 512,
          createdAt: 'test',
          blob,
          ...extra,
        });
        const dataUrl = (blob: Blob) =>
          new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.readAsDataURL(blob);
          });
        // The model as the editor shows it: the photo's colours, the fit, mixed shading.
        const painted = ref.photoCamera
          ? await lib.preparePaintedMesh(mesh, () => lib.decodeProductPhoto(photoBlob), ref.photoCamera)
          : undefined;
        const base = painted?.status === 'ok' ? painted.mesh : mesh;
        const shown = await lib.prepareFittedMesh(base, ref.fit, size);
        await lib.prepareProductSurface(ref.shading ?? 'baked', shown);
        const canvas = document.createElement('canvas');
        document.body.append(canvas);
        const renderer = new lib.ProductRenderer(canvas, shown);
        const draw = async (pose: unknown) => {
          renderer.setShading(ref.shading ?? 'baked');
          renderer.setGloss(ref.gloss ?? 'none');
          renderer.setPose(pose);
          return dataUrl((await renderer.capture()).blob);
        };
        renderer.resize(512, 512, 1);
        const now = await draw(ref.pose);
        const side = lib.poseTowardPhoto(ref.pose, ref.fit);
        const photoSide = await draw(side);
        renderer.dispose();
        canvas.remove();
        const turnAngle = (() => {
          const a = lib.poseDirection(ref.pose).angle,
            b = lib.poseDirection(side).angle;
          return Math.abs(((a - b + 540) % 360) - 180);
        })();
        // The room, seen from the front: the flat photo standing in it, then the saved 3D 정면.
        const { assets, snapshot, aspect, room } = await lib.buildFluxRoomScene();
        const meshAsset = { ...asset('mesh', 'product-mesh', meshRaw.blob) };
        const photoAsset = asset('input', 'product', photoBlob, photoDims);
        const captureAsset = asset('capture', 'product', captureRaw.blob, captureDims);
        const reader = async (id: string) =>
          id === 'mesh'
            ? meshAsset
            : id === 'input'
              ? photoAsset
              : id === 'capture'
                ? captureAsset
                : assets[id];
        const roomShot = async (threeD: boolean) => {
          const next = structuredClone(snapshot);
          next.materials.real = {
            ...snapshot.materials.standard,
            id: 'real',
            materialId: 'real',
            name: 'real',
            category,
            installation: 'floor',
            widthMm: size.widthMm,
            heightMm: size.heightMm,
            depthMm: size.depthMm,
            textureAssetIds: [],
            views: [
              {
                // The flat 정면 is the cut-out photo; the 3D 정면 is its capture, with the model behind it.
                assetId: threeD ? 'capture' : 'input',
                direction: '정면' as const,
                anchor: { x: 0.5, y: 1 },
                ...(threeD ? { product3d: { ...ref, meshAssetId: 'mesh', inputAssetId: 'input' } } : {}),
              },
            ],
          };
          // Placed as the app places a photo: the size of the product inside the picture comes from its opaque pixels.
          const placement = await lib.createRoomPlacement(
            next.materials.real,
            threeD ? captureAsset : photoAsset,
            'floor',
          );
          const fixture = {
            id: 'real',
            name: 'real',
            materialVersionId: 'real',
            viewIndex: 0,
            position: { x: 0.5, y: 0.5 },
            width: 0.1,
            height: 0.1,
            rotation: 0,
            // The product's foot stands on the floor: for the flat photo that is the bottom of its opaque pixels.
            anchor: threeD ? view.anchor : { x: 0.5, y: placement.contentBounds.bottom },
            locked: false,
            shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
            occlusion: { polygon: [], strokes: [] },
            color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
            roomPlacement: { ...placement, u: 0.5, v: 0.5 },
          };
          for (const scene of [next.scene, next.beforeScene]) {
            scene.fixtures = [structuredClone(fixture)];
            lib.projectRoomFixture(room, scene.fixtures[0], aspect);
          }
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
            const orbit = lib.fluxOrbitView({ azimuth: 0, elevation: 12 });
            const blob = await viewer.export(orbit, { format: 'png', mode: 'after', longEdge: 1024 });
            const width = 1024,
              height = Math.round((1024 * next.scene.imageHeight) / next.scene.imageWidth);
            return { url: await dataUrl(blob), box: viewer.fixtureBounds(width, height, orbit).real };
          } finally {
            viewer.dispose();
          }
        };
        const flat = await roomShot(false);
        const solid = await roomShot(true);
        return {
          key,
          photo: await dataUrl(photoBlob),
          now,
          photoSide,
          roomFlat: flat.url,
          room3d: solid.url,
          frameBox: solid.box ?? flat.box,
          flatBox: flat.box ?? solid.box,
          poses: { now: lib.poseDirection(ref.pose), photoSide: lib.poseDirection(side) },
          turn: turnAngle,
        };
      },
      {
        key,
        name: `${p.name} 자동저장`,
        category: p.category,
        size: { widthMm: p.width, depthMm: p.depth, heightMm: p.height },
      },
    )) as Shot;
    shots.push(shot);
    const save = (name: string, url: string) =>
      writeFileSync(`${out}/${key}-${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    save('photo', shot.photo);
    save('now', shot.now);
    save('photo-side', shot.photoSide);
    save('room-flat', shot.roomFlat);
    save('room-3d', shot.room3d);
    writeFileSync(
      `${out}/${key}.json`,
      JSON.stringify({ poses: shot.poses, turnDegrees: +shot.turn.toFixed(1) }, null, 2),
    );
    console.log(key, 'angle between the saved 정면 and the photo side:', shot.turn.toFixed(1), '°');
  }
  if (errors.length) console.log('PAGE ERRORS', errors.join('\n'));
} finally {
  await browser.close();
}

// Sheets.
const decode = (url: string) => Buffer.from(url.split(',')[1], 'base64');
const label = (text: string, width: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28"><text x="4" y="20" font-family="sans-serif" font-size="16">${text}</text></svg>`,
  );
const cell = 320;
async function sheet(
  file: string,
  columns: string[],
  pick: (shot: Shot) => string[],
  crop?: (shot: Shot) => boolean,
) {
  const parts: OverlayOptions[] = [];
  for (const [r, shot] of shots.entries()) {
    const urls = pick(shot);
    for (const [c, url] of urls.entries()) {
      let image = sharp(decode(url)).flatten({ background: '#ffffff' });
      if (crop?.(shot)) {
        // The room pictures: the product's box with room around it.
        const meta = await sharp(decode(url)).metadata();
        // One window for both pictures: the two boxes together, so the scale is the same.
        const l = Math.min(shot.frameBox[0], shot.flatBox[0]),
          t = Math.min(shot.frameBox[1], shot.flatBox[1]),
          rr = Math.max(shot.frameBox[2], shot.flatBox[2]),
          b = Math.max(shot.frameBox[3], shot.flatBox[3]);
        const pad = 0.6 * Math.max(rr - l, b - t);
        const left = Math.max(0, Math.round((l - pad * (meta.height! / meta.width!)) * meta.width!));
        const top = Math.max(0, Math.round((t - pad) * meta.height!));
        const right = Math.min(
          meta.width!,
          Math.round((rr + pad * (meta.height! / meta.width!)) * meta.width!),
        );
        const bottom = Math.min(meta.height!, Math.round((b + pad * 0.3) * meta.height!));
        image = image.extract({
          left,
          top,
          width: Math.max(8, right - left),
          height: Math.max(8, bottom - top),
        });
      }
      parts.push({
        input: await image.resize(cell, cell, { fit: 'contain', background: '#ffffff' }).png().toBuffer(),
        left: c * (cell + 8),
        top: r * (cell + 36) + 30,
      });
      parts.push({
        input: label(`${shot.key} · ${columns[c]}`, cell),
        left: c * (cell + 8),
        top: r * (cell + 36),
      });
    }
  }
  await sharp({
    create: {
      width: columns.length * (cell + 8),
      height: shots.length * (cell + 36),
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(parts)
    .png()
    .toFile(`${out}/${file}`);
}
await sheet('sheet-poses.png', ['사진', '지금: 정면 이름의 자세', '대안: 사진 쪽 자세'], (s) => [
  s.photo,
  s.now,
  s.photoSide,
]);
await sheet(
  'sheet-room.png',
  ['평면 정면 사진(방)', '3D 정면(방)'],
  (s) => [s.roomFlat, s.room3d],
  () => true,
);
console.log('wrote', out);
