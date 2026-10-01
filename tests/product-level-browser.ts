/**
 * Real check of the outline level (levelByOutline) and of standing a 3D product on the floor.
 *
 * Part A, the two tilted 360° captures the bug was reported with (test-results/tilt-samples, a
 * toilet about 14° and a basin about −20° rolled on the screen): the outline's roll is read, the
 * picture is turned back by it and read again. Before and after go to
 * test-results/product3d-level/samples/.
 *
 * Part B, the eight real meshes (test-results/product3d-batch, saved TripoSR output, no new AI),
 * in the browser with the production renderer: the automatic level (shape estimate, then outline)
 * as the editor does it, the picture before and after, a roll of ±15° and ±35° put on top and
 * levelled again (the roll must come back to within 2°), and the product placed on the floor of the
 * room at anchor heights 1, 0.95, 0.9 and 0.5: its lowest point at y = 0 (0.5 mm), inside the
 * room's width, and the in-room front view's outline roll.
 *
 * Usage: node tests/run-browser-test.mjs tests/product-level-browser.ts [--gpu] [--skip-real]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';
import { estimateSilhouetteTilt } from '../src/lib/product3d/silhouette-tilt';

const gpu = process.argv.includes('--gpu');
const skipReal = process.argv.includes('--skip-real');
const output = 'test-results/product3d-level';
const meshRoot = 'test-results/product3d-batch';
await mkdir(`${output}/samples`, { recursive: true });
const failures: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) {
    failures.push(message);
    console.log('  ✗', message);
  }
};

// ───────────────────────────── Part A: the two tilted captures ─────────────────────────────
console.log('Part A — the tilted captures');
const alphaOf = async (input: string | Buffer) => {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(info.width * info.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return { alpha, width: info.width, height: info.height };
};
const samples = [
  { name: 'toilet', file: 'test-results/tilt-samples/toilet-tilted-15deg.png' },
  { name: 'basin', file: 'test-results/tilt-samples/basin-tilted-29deg.png' },
];
const sampleRows: { name: string; before: number; after: number }[] = [];
for (const sample of samples) {
  if (!existsSync(sample.file)) {
    console.log(`  ${sample.name}: ${sample.file} not found, skipped`);
    continue;
  }
  const before = await alphaOf(sample.file);
  const first = estimateSilhouetteTilt(before.alpha, before.width, before.height);
  check(first, `${sample.name}: the outline gives a clear reading`);
  if (!first) continue;
  // The outline leans clockwise by first.degrees: turn the picture back counter-clockwise.
  const fixed = await sharp(sample.file)
    .rotate(-first.degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const after = await alphaOf(fixed);
  const second = estimateSilhouetteTilt(after.alpha, after.width, after.height);
  const left = second ? second.degrees : Number.NaN;
  console.log(
    `  ${sample.name}: ${first.degrees.toFixed(2)}° → ${Number.isNaN(left) ? 'no reading' : left.toFixed(2) + '°'}`,
  );
  check(
    second && Math.abs(second.degrees) <= 2,
    `${sample.name}: after the turn the outline is level (≤ 2°)`,
  );
  sampleRows.push({ name: sample.name, before: first.degrees, after: left });
  await copyFile(sample.file, `${output}/samples/${sample.name}-before.png`);
  await writeFile(`${output}/samples/${sample.name}-after.png`, fixed);
  const label = (text: string) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="28"><rect width="100%" height="100%" fill="#eee"/><text x="8" y="19" font-family="sans-serif" font-size="14" fill="#222">${text}</text></svg>`,
    );
  const tile = async (png: string | Buffer) =>
    sharp(png)
      .resize(512, 512, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  await sharp({ create: { width: 1024, height: 540, channels: 3, background: '#cccccc' } })
    .composite([
      { input: await tile(sample.file), left: 0, top: 28 },
      { input: await tile(fixed), left: 512, top: 28 },
      {
        input: label(`${sample.name} before: outline turned ${first.degrees.toFixed(1)}° clockwise`),
        left: 0,
        top: 0,
      },
      {
        input: label(`${sample.name} after: ${Number.isNaN(left) ? 'no reading' : left.toFixed(2)}°`),
        left: 512,
        top: 0,
      },
    ])
    .png()
    .toFile(`${output}/samples/${sample.name}-sheet.png`);
}

// ───────────────────────────── Part B: eight real meshes ─────────────────────────────
type Row = {
  product: string;
  shape: { degrees: number | null; accepted: boolean; dominance: number | null; peakShare: number | null };
  raw: {
    before: number | null;
    accepted: boolean;
    status: string;
    turned: number;
    after: number | null;
    m1: { degrees: number; lineShare: number; peakShare: number; dominance: number } | null;
    m2: { degrees: number; lineShare: number; peakShare: number; dominance: number } | null;
  };
  status: string;
  turned: number;
  after: number | null;
  rolls: { roll: number; status: string; backBy: number; residual: number | null }[];
  floor: { anchor: number; minY: number; inside: boolean }[];
  room: number | null;
  /** How far the in-room outline moves when the product is rolled 12° clockwise. */
  roomFollows: number | null;
  beforeUrl: string;
  afterUrl: string;
  roomUrl: string;
};
const rows: Row[] = [];
if (!skipReal && existsSync(`${meshRoot}/summary.json`)) {
  const bundle = await build({
    stdin: {
      contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels} from './src/lib/ai-export/client';export {buildViewerFixtures, createSavedProductGeometry} from './src/lib/room-viewer/fixtures';export {makeProductMeshAsset} from './src/lib/product3d/codec';export {ProductRenderer} from './src/lib/product3d/renderer';export {createDefaultPose, levelCameraQuaternion, rotateInScreen} from './src/lib/product3d/pose';export {estimateUprightQuaternion} from './src/lib/product3d/upright';export {levelByOutline} from './src/lib/product3d/outline-level';export {estimateSilhouetteTilt, measureSilhouetteTilt} from './src/lib/product3d/silhouette-tilt';export {DEFAULT_ROOM} from './src/lib/room-geometry';export {projectRoomFixture} from './src/lib/room-fixtures';export {Box3, Vector3, Quaternion} from 'three';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'Level',
  });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: gpu
      ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
      : [
          '--enable-webgl',
          '--ignore-gpu-blocklist',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
        ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (e) => {
      if (e.type() === 'error') errors.push(e.text());
    });
    await page.route('http://127.0.0.1:43223/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
    );
    await page.goto('http://127.0.0.1:43223/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
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
      const row = (await page.evaluate(
        async ({ product, files }) => {
          type Lib = typeof import('../src/lib/room-viewer/renderer') &
            typeof import('../src/lib/room-viewer/view-state') &
            typeof import('../src/lib/ai-export/view') &
            Pick<typeof import('./helpers/flux-room-scene'), 'buildFluxRoomScene'> &
            Pick<typeof import('../src/lib/ai-export/client'), 'readPixels'> &
            Pick<
              typeof import('../src/lib/room-viewer/fixtures'),
              'buildViewerFixtures' | 'createSavedProductGeometry'
            > &
            Pick<typeof import('../src/lib/product3d/codec'), 'makeProductMeshAsset'> &
            Pick<typeof import('../src/lib/product3d/renderer'), 'ProductRenderer'> &
            Pick<
              typeof import('../src/lib/product3d/pose'),
              'createDefaultPose' | 'levelCameraQuaternion' | 'rotateInScreen'
            > &
            Pick<typeof import('../src/lib/product3d/upright'), 'estimateUprightQuaternion'> &
            Pick<typeof import('../src/lib/product3d/outline-level'), 'levelByOutline'> &
            Pick<
              typeof import('../src/lib/product3d/silhouette-tilt'),
              'estimateSilhouetteTilt' | 'measureSilhouetteTilt'
            > &
            Pick<typeof import('../src/lib/room-geometry'), 'DEFAULT_ROOM'> &
            Pick<typeof import('../src/lib/room-fixtures'), 'projectRoomFixture'> &
            Pick<typeof import('three'), 'Box3' | 'Vector3' | 'Quaternion'>;
          type Pose = ReturnType<Lib['createDefaultPose']>;
          const lib = (window as unknown as { Level: Lib }).Level;
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
          const canvas = document.createElement('canvas');
          document.body.append(canvas);
          const renderer = new lib.ProductRenderer(canvas, mesh);
          renderer.resize(512, 512, 1);
          renderer.setShading('baked');
          const level = (pose: Pose): Pose => ({
            ...pose,
            cameraQuaternion: lib
              .levelCameraQuaternion(new lib.Quaternion(...pose.cameraQuaternion))
              .toArray() as Pose['cameraQuaternion'],
          });
          const draw = (pose: Pose) => renderer.silhouette(pose, 512);
          const read = (pose: Pose) => {
            const p = draw(level(pose));
            const measure = lib.measureSilhouetteTilt(p.alpha, p.width, p.height);
            const accepted = lib.estimateSilhouetteTilt(p.alpha, p.width, p.height);
            return { measure, accepted };
          };
          const rolled = (pose: Pose, degrees: number): Pose => ({
            ...pose,
            objectQuaternion: lib.rotateInScreen(level(pose), (degrees * Math.PI) / 180).objectQuaternion,
          });
          const between = (a: number[], b: number[]) =>
            (2 *
              Math.acos(Math.min(1, Math.abs(new lib.Quaternion(...a).dot(new lib.Quaternion(...b))))) *
              180) /
            Math.PI;
          // What the editor's button does: the shape estimate, then the outline.
          const shape = {
            ...lib.createDefaultPose(),
            objectQuaternion: lib.estimateUprightQuaternion(mesh.positions),
          };
          const first = read(shape);
          const result = lib.levelByOutline(shape, draw);
          const after = read(result.pose);
          // The model as reconstructed, with no shape estimate (what a mesh that the estimate gave up
          // on, like the reported toilet and basin, is left as): the outline alone.
          const raw = lib.createDefaultPose();
          const rawFirst = read(raw);
          const rawLevelled = lib.levelByOutline(raw, draw);
          const rawAfter = read(rawLevelled.pose);
          // The picture of the shape estimate (before) and of the levelled pose (after), as saved.
          renderer.setPose(shape);
          const beforeCapture = await renderer.capture();
          renderer.setPose(result.pose);
          const afterCapture = await renderer.capture();
          // A roll put on top of the levelled pose comes back to the same place (outline products).
          const rolls: { roll: number; status: string; backBy: number; residual: number | null }[] = [];
          for (const roll of [-35, -15, 15, 35]) {
            const start = rolled(result.pose, roll);
            const fixed = lib.levelByOutline(start, draw);
            rolls.push({
              roll,
              status: fixed.status,
              backBy: between(fixed.pose.objectQuaternion, result.pose.objectQuaternion),
              residual: read(fixed.pose).accepted?.degrees ?? null,
            });
          }
          // On the floor of the room at several anchor heights.
          const { assets, snapshot, aspect, room } = await lib.buildFluxRoomScene();
          const meshAsset = await lib.makeProductMeshAsset(mesh, 'mesh', 'input');
          const reader = async (id: string) => (id === 'mesh' ? meshAsset : assets[id]);
          const half = lib.DEFAULT_ROOM.widthMm / 2;
          const empty = () => ({ polygon: [], strokes: [] });
          const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
          const fit = (width: number, height: number, pose: Pose = result.pose) => ({
            ...snapshot.materials.standard,
            id: 'real',
            materialId: 'real',
            name: product,
            category: 'toilet' as const,
            installation: 'floor' as const,
            widthMm: width,
            heightMm: height,
            depthMm: 300,
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
                },
              },
            ],
          });
          const makeFixture = (anchorY: number, width: number, height: number) => ({
            id: 'real',
            name: product,
            materialVersionId: 'real',
            viewIndex: 0,
            position: { x: 0.5, y: 0.5 },
            width: 0.1,
            height: 0.1,
            rotation: 0,
            anchor: { x: 0.5, y: anchorY },
            locked: false,
            shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
            occlusion: empty(),
            color: { ...color },
            roomPlacement: {
              face: 'floor' as const,
              u: 0.5,
              v: 0.5,
              scale: 1,
              widthMm: width,
              heightMm: height,
              imageAspect: width / height,
              contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
            },
          });
          // The outline's natural size at this pose, fitted into 1000 × 1000 mm and then to 650 mm.
          const probe = lib.createSavedProductGeometry(
            mesh,
            fit(1000, 1000).views[0].product3d,
            makeFixture(1, 1000, 1000) as never,
          );
          const size = probe.boundingBox!.getSize(new lib.Vector3());
          probe.dispose();
          const shrink = 650 / Math.max(size.x, size.y);
          const [width, height] = [size.x * shrink, size.y * shrink];
          const shown = (root: import('three').Object3D) => {
            const box = new lib.Box3();
            root.updateWorldMatrix(true, true);
            root.traverse((o) => {
              if (!(o as import('three').Mesh).isMesh) return;
              for (let n: import('three').Object3D | null = o; n; n = n.parent) if (!n.visible) return;
              box.union(new lib.Box3().setFromObject(o, true));
            });
            return box;
          };
          const floor: { anchor: number; minY: number; inside: boolean }[] = [];
          // The in-room front view's outline roll, and the picture, for a pose standing on the floor.
          const roomView = async (pose: Pose) => {
            const next = structuredClone(snapshot);
            next.materials.real = fit(width, height, pose);
            for (const scene of [next.scene, next.beforeScene]) {
              scene.fixtures = [makeFixture(1, width, height) as never];
              lib.projectRoomFixture(room, scene.fixtures[0], aspect);
            }
            const viewer = new lib.RoomViewerRenderer();
            try {
              await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
              const view = lib.fluxOrbitView({ azimuth: 0, elevation: 0 });
              const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1536 });
              const pixels = await lib.readPixels(blob);
              const mask = viewer.regionMask(pixels.width, pixels.height, view);
              const alpha = new Uint8Array(pixels.width * pixels.height);
              for (let i = 0; i < alpha.length; i++) alpha[i] = mask.data[i] === 255 ? 255 : 0;
              return {
                roll: lib.estimateSilhouetteTilt(alpha, pixels.width, pixels.height)?.degrees ?? null,
                url: await dataUrl(blob),
              };
            } finally {
              viewer.dispose();
            }
          };
          for (const anchor of [1, 0.95, 0.9, 0.5]) {
            const next = structuredClone(snapshot);
            next.materials.real = fit(width, height);
            for (const scene of [next.scene, next.beforeScene]) {
              scene.fixtures = [makeFixture(anchor, width, height) as never];
              lib.projectRoomFixture(room, scene.fixtures[0], aspect);
            }
            const built = await lib.buildViewerFixtures(next.scene, next.materials, reader);
            const box = shown(built.group);
            floor.push({
              anchor,
              minY: box.min.y,
              inside: box.min.x >= -half - 0.5 && box.max.x <= half + 0.5 && box.min.z >= -0.5,
            });
            built.dispose();
          }
          const standing = await roomView(result.pose);
          const lean = await roomView(rolled(result.pose, 12));
          const roomRoll = standing.roll;
          const roomFollows = standing.roll !== null && lean.roll !== null ? lean.roll - standing.roll : null;
          const roomUrl = standing.url;
          renderer.dispose();
          canvas.remove();
          return {
            product,
            shape: {
              degrees: first.measure?.degrees ?? null,
              accepted: Boolean(first.accepted),
              dominance:
                first.measure && Number.isFinite(first.measure.dominance) ? first.measure.dominance : null,
              peakShare: first.measure?.peakShare ?? null,
            },
            raw: {
              before: rawFirst.measure?.degrees ?? null,
              accepted: Boolean(rawFirst.accepted),
              status: rawLevelled.status,
              turned: rawLevelled.degrees,
              after: rawAfter.accepted?.degrees ?? null,
              m1: rawFirst.measure ?? null,
              m2: rawAfter.measure ?? null,
            },
            status: result.status,
            turned: result.degrees,
            after: after.accepted?.degrees ?? null,
            rolls,
            floor,
            room: roomRoll,
            roomFollows,
            beforeUrl: await dataUrl(beforeCapture.blob),
            afterUrl: await dataUrl(afterCapture.blob),
            roomUrl,
          } satisfies Row;
        },
        { product, files },
      )) as Row;
      rows.push(row);
    }
    const toPng = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    console.log('\nPart B — real meshes');
    console.log(
      'product            without the shape estimate: read → outline level → after      |  after the shape estimate: read, status, turned, after',
    );
    for (const r of rows) {
      await writeFile(`${output}/real-${r.product}-before.png`, toPng(r.beforeUrl));
      await writeFile(`${output}/real-${r.product}-after.png`, toPng(r.afterUrl));
      if (r.roomUrl) await writeFile(`${output}/real-${r.product}-room.png`, toPng(r.roomUrl));
      console.log(
        `${r.product.padEnd(18)} raw ${(r.raw.before === null ? '--' : r.raw.before.toFixed(1) + '°').padStart(7)} ${r.raw.status.padEnd(8)} turned ${r.raw.turned.toFixed(1).padStart(6)}° → ${r.raw.after === null ? '--' : r.raw.after.toFixed(1) + '°'}`,
      );
      const f = (m: Row['raw']['m1']) =>
        m
          ? `${m.degrees.toFixed(1)}° line ${m.lineShare.toFixed(2)} peak ${m.peakShare.toFixed(2)} dom ${m.dominance.toFixed(1)}`
          : 'none';
      console.log(`${' '.repeat(18)} raw measure ${f(r.raw.m1)}  →  ${f(r.raw.m2)}`);
      console.log(
        `${' '.repeat(18)} ${(r.shape.degrees === null ? '--' : r.shape.degrees.toFixed(1) + '°').padEnd(8)} ${r.shape.accepted ? 'ok ' : 'weak'}  ${r.status.padEnd(8)} ${r.turned.toFixed(1).padStart(6)}° ${r.after === null ? '   --' : r.after.toFixed(1).padStart(5) + '°'}   ${r.rolls
          .map(
            (x) =>
              `${x.roll}:${x.status === 'turned' ? x.backBy.toFixed(1) + '/' + (x.residual === null ? '--' : x.residual.toFixed(1)) : x.status}`,
          )
          .join(
            ' ',
          )}   ${r.floor.map((f) => f.minY.toExponential(0)).join(' ')}   ${r.room === null ? '--' : r.room.toFixed(1) + '°'} (+12°: ${r.roomFollows === null ? '--' : r.roomFollows.toFixed(1) + '°'})`,
      );
      // Floor contact and the room's width hold for every product, whatever the outline says.
      for (const f of r.floor) {
        check(
          Math.abs(f.minY) <= 0.5,
          `${r.product}: anchor ${f.anchor}: lowest point on the floor (${f.minY.toFixed(3)} mm)`,
        );
        check(f.inside, `${r.product}: anchor ${f.anchor}: inside the room's width`);
      }
      if (r.raw.status === 'turned')
        check(
          r.raw.after !== null && Math.abs(r.raw.after) <= 2,
          `${r.product}: from the raw model the outline ends level (${r.raw.after})`,
        );
      if (r.status === 'turned' || r.status === 'level') {
        check(
          r.after !== null && Math.abs(r.after) <= 2,
          `${r.product}: after the level the outline reads level (${r.after})`,
        );
        for (const x of r.rolls) {
          check(x.status === 'turned', `${r.product}: a ${x.roll}° roll is read`);
          check(
            x.backBy <= 2,
            `${r.product}: a ${x.roll}° roll comes back to within 2° (${x.backBy.toFixed(2)}°)`,
          );
          check(
            x.residual !== null && Math.abs(x.residual) <= 2,
            `${r.product}: a ${x.roll}° roll ends level (${x.residual})`,
          );
        }
        // The room looks from a little above, in perspective: a box's edges slant a few degrees there
        // that the editor's level, straight-on view does not show. What must hold is that the room
        // follows the roll (12° on the product is about 12° in the room) and stays near level.
        if (r.room !== null)
          check(
            Math.abs(r.room) <= 6,
            `${r.product}: the in-room front view stays near level (${r.room.toFixed(1)}°)`,
          );
        if (r.roomFollows !== null)
          check(
            Math.abs(r.roomFollows - 12) <= 3,
            `${r.product}: the room follows a 12° roll (${r.roomFollows.toFixed(1)}°)`,
          );
      } else {
        // No clear outline (round or lumpy): left alone, as it was.
        check(r.turned === 0, `${r.product}: an unclear outline turns nothing`);
        for (const x of r.rolls)
          check(x.status !== 'turned' || x.backBy <= 2, `${r.product}: ${x.roll}° roll`);
      }
    }
    // Contact sheet: per product the picture before, after and in the room.
    if (rows.length) {
      const tile = 256;
      const cells: OverlayOptions[] = [];
      for (const [i, r] of rows.entries()) {
        const put = async (png: Buffer, column: number, fit: 'contain' | 'cover') =>
          cells.push({
            input: await sharp(png)
              .resize(tile, tile, { fit, background: '#ffffff' })
              .flatten({ background: '#ffffff' })
              .png()
              .toBuffer(),
            left: column * tile,
            top: i * tile,
          });
        await put(toPng(r.beforeUrl), 0, 'contain');
        await put(toPng(r.afterUrl), 1, 'contain');
        if (r.roomUrl) await put(toPng(r.roomUrl), 2, 'cover');
      }
      await sharp({
        create: { width: tile * 3, height: tile * rows.length, channels: 3, background: '#ffffff' },
      })
        .composite(cells)
        .png()
        .toFile(`${output}/real-sheet${gpu ? '-gpu' : ''}.png`);
    }
    const pageErrors = errors.filter((e) => !/WebGL|GPU stall|swiftshader/i.test(e));
    check(pageErrors.length === 0, `no page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
  } finally {
    await browser.close();
  }
}
await writeFile(
  `${output}/summary${gpu ? '-gpu' : ''}.json`,
  JSON.stringify(
    {
      samples: sampleRows,
      real: rows.map((r) => ({ ...r, beforeUrl: undefined, afterUrl: undefined, roomUrl: undefined })),
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else console.log('\nall checks passed');
assert.equal(failures.length, 0);
