/**
 * The 3D room (and so the AI conversion input and the export, which draw the same room) with a saved
 * product glazed and not: a saved TripoSR mesh (test-results/product3d-batch, no new AI run) standing
 * on the floor of the FLUX comparison room, saved as "mixed" with no gloss (as older saves are),
 * "약하게" and "보통", seen from the front and from behind. Per picture it prints the product's mean
 * lightness and the share of its pixels blown out to white, and it measures what the glaze costs: the
 * time of one export of the room with the product, and with four of it.
 *
 * Writes test-results/product3d-gloss/room-<product>.png (rows: no gloss, 약하게, 보통; columns:
 * front, back).
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-gloss-room-browser.ts [--gpu]
 *   MESH=02-smart-toilet    the mesh folder (default 02-smart-toilet; bear-a-original-500 is the cat toilet)
 *   CATEGORY=toilet         the material's category (default toilet); a category that is not ceramic is not glazed
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const product = process.env.MESH ?? '02-smart-toilet';
const category = process.env.CATEGORY ?? 'toilet';
const directory = `test-results/product3d-batch/${product}/`;
if (!existsSync(`${directory}mesh-positions.bin`)) {
  console.log(`${product}: no mesh in test-results/product3d-batch, skipped`);
  process.exit(0);
}
const output = 'test-results/product3d-gloss';
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
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const glosses = ['none', 'light', 'normal'] as const;
const views = [
  ['front', 0],
  ['back', 180],
] as const;
type Shot = {
  gloss: string;
  view: string;
  url: string;
  lightness: number;
  blown: number;
  share: number;
  box: [number, number, number, number];
};
type Timing = { gloss: string; count: number; first: number; ms: number };
let shots: Shot[] = [];
let timings: Timing[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43226/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43226/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const b64 = (file: string) => readFileSync(directory + file).toString('base64');
  const result = await page.evaluate(
    async ({ data, glosses, views, category }) => {
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
      const reader = async (id: string) => (id === 'mesh' ? meshAsset : assets[id]);
      const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
      const material = (gloss?: string) => ({
        ...snapshot.materials.standard,
        id: 'real',
        materialId: 'real',
        name: 'real',
        category,
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
              shading: 'mixed' as const,
              ...(gloss && gloss !== 'none' ? { gloss } : {}),
            },
          },
        ],
      });
      const fixture = (index: number, count: number) => ({
        id: `real-${index}`,
        name: `real-${index}`,
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
        color: { ...color },
        roomPlacement: {
          face: 'floor' as const,
          u: count === 1 ? 0.5 : 0.2 + (0.6 * index) / (count - 1),
          v: 0.5,
          scale: count === 1 ? 1 : 0.6,
          widthMm: 700,
          heightMm: 700,
          imageAspect: 1,
          contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
        },
      });
      const draw = async (gloss: string | undefined, count: number, azimuth: number) => {
        const next = structuredClone(snapshot);
        next.materials.real = material(gloss);
        for (const scene of [next.scene, next.beforeScene]) {
          scene.fixtures = Array.from({ length: count }, (_, i) => fixture(i, count));
          for (const f of scene.fixtures) lib.projectRoomFixture(room, f, aspect);
        }
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
          const view = lib.fluxOrbitView({ azimuth, elevation: 18 });
          const started = performance.now();
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1000 });
          const ms = performance.now() - started;
          return { blob, ms, pixels: await lib.readPixels(blob) };
        } finally {
          viewer.dispose();
        }
      };
      const shots: unknown[] = [];
      const timings: unknown[] = [];
      for (const [view, azimuth] of views) {
        // The room without the product: what differs from it in a picture is the product.
        const empty = await (async () => {
          const next = structuredClone(snapshot);
          for (const scene of [next.scene, next.beforeScene]) scene.fixtures = [];
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
            const blob = await viewer.export(lib.fluxOrbitView({ azimuth, elevation: 18 }), {
              format: 'png',
              mode: 'after',
              longEdge: 1000,
            });
            return lib.readPixels(blob);
          } finally {
            viewer.dispose();
          }
        })();
        for (const gloss of glosses) {
          const shot = await draw(gloss, 1, azimuth);
          let sum = 0,
            count = 0,
            blown = 0;
          const box = [1e9, 1e9, -1, -1];
          const { data: now, width, height } = shot.pixels;
          for (let i = 0; i < width * height; i++) {
            const o = i * 4;
            const change =
              Math.abs(now[o] - empty.data[o]) +
              Math.abs(now[o + 1] - empty.data[o + 1]) +
              Math.abs(now[o + 2] - empty.data[o + 2]);
            if (change < 45) continue;
            count++;
            box[0] = Math.min(box[0], i % width);
            box[1] = Math.min(box[1], Math.floor(i / width));
            box[2] = Math.max(box[2], i % width);
            box[3] = Math.max(box[3], Math.floor(i / width));
            sum += 0.2126 * now[o] + 0.7152 * now[o + 1] + 0.0722 * now[o + 2];
            if (now[o] >= 254 && now[o + 1] >= 254 && now[o + 2] >= 254) blown++;
          }
          shots.push({
            gloss,
            view,
            url: await dataUrl(shot.blob),
            lightness: sum / Math.max(1, count),
            blown: blown / Math.max(1, count),
            share: count / (width * height),
            box,
          });
        }
      }
      // What the glaze costs: the room with one product and with four, in one viewer. The first export
      // includes compiling the shaders; the next three show what each further export costs.
      for (const gloss of glosses)
        for (const count of [1, 4]) {
          const next = structuredClone(snapshot);
          next.materials.real = material(gloss);
          for (const scene of [next.scene, next.beforeScene]) {
            scene.fixtures = Array.from({ length: count }, (_, i) => fixture(i, count));
            for (const f of scene.fixtures) lib.projectRoomFixture(room, f, aspect);
          }
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
            const view = lib.fluxOrbitView({ azimuth: 0, elevation: 18 });
            const times: number[] = [];
            for (let run = 0; run < 4; run++) {
              const started = performance.now();
              await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1000 });
              times.push(performance.now() - started);
            }
            const later = times.slice(1).sort((x, y) => x - y);
            timings.push({ gloss, count, first: Math.round(times[0]), ms: Math.round(later[1]) });
          } finally {
            viewer.dispose();
          }
        }
      return { shots, timings };
    },
    {
      data: { p: b64('mesh-positions.bin'), c: b64('mesh-colors.bin'), i: b64('mesh-indices.bin') },
      glosses: [...glosses],
      views,
      category,
    },
  );
  shots = result.shots as Shot[];
  timings = result.timings as Timing[];
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
}
const png = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const first = await sharp(png(shots[0].url)).metadata();
const tile = { width: 600, height: Math.round((600 * first.height!) / first.width!) };
const label = 22;
const composites: OverlayOptions[] = [];
for (const [row, gloss] of glosses.entries())
  for (const [column, [view]] of views.entries()) {
    const shot = shots.find((s) => s.gloss === gloss && s.view === view)!;
    const left = column * tile.width,
      top = row * (tile.height + label);
    composites.push({
      input: await sharp(png(shot.url)).resize(tile.width, tile.height).toBuffer(),
      left,
      top: top + label,
    });
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${label}"><rect width="100%" height="100%" fill="#e6e6e0"/><text x="6" y="16" font-family="sans-serif" font-size="13" fill="#222">${product} (${category}) · gloss ${gloss} · ${view}</text></svg>`,
      ),
      left,
      top,
    });
  }
await sharp({
  create: { width: tile.width * 2, height: (tile.height + label) * 3, channels: 3, background: '#f4f4f0' },
})
  .composite(composites)
  .png()
  .toFile(`${output}/room-${product}.png`);
// The product up close: the picture cut round the pixels that differ from the empty room, enlarged.
const close: OverlayOptions[] = [];
const closeTile = 420;
for (const [row, gloss] of glosses.entries())
  for (const [column, [view]] of views.entries()) {
    const shot = shots.find((s) => s.gloss === gloss && s.view === view)!;
    const pad = 0.15 * Math.max(shot.box[2] - shot.box[0], shot.box[3] - shot.box[1]);
    const side = Math.round(Math.max(shot.box[2] - shot.box[0], shot.box[3] - shot.box[1]) + 2 * pad);
    const left = Math.max(0, Math.round((shot.box[0] + shot.box[2]) / 2 - side / 2));
    const top = Math.max(0, Math.round((shot.box[1] + shot.box[3]) / 2 - side / 2));
    const info = await sharp(png(shot.url)).metadata();
    close.push({
      input: await sharp(png(shot.url))
        .extract({
          left,
          top,
          width: Math.min(side, info.width! - left),
          height: Math.min(side, info.height! - top),
        })
        .resize(closeTile, closeTile, { fit: 'contain', background: '#f4f4f0' })
        .toBuffer(),
      left: column * closeTile,
      top: row * closeTile,
    });
  }
await sharp({ create: { width: closeTile * 2, height: closeTile * 3, channels: 3, background: '#f4f4f0' } })
  .composite(close)
  .png()
  .toFile(`${output}/room-close-${product}.png`);
console.log('gloss   view   product share   lightness   blown');
for (const shot of shots) {
  console.log(
    `${shot.gloss.padEnd(7)} ${shot.view.padEnd(6)} ${(shot.share * 100).toFixed(1).padStart(8)}%   ${shot.lightness.toFixed(1).padStart(8)}   ${(shot.blown * 100).toFixed(2)}%`,
  );
  assert.ok(shot.share > 0.003, `${shot.gloss} ${shot.view}: the product shows in the picture`);
}
console.log(
  'export time (ms), one product / four: first export (with shader compile) / a later export (median of 3):',
);
for (const gloss of glosses)
  console.log(
    gloss.padEnd(7),
    timings
      .filter((t) => t.gloss === gloss)
      .map((t) => `${t.count}: ${t.first} / ${t.ms}`)
      .join('   '),
  );
writeFileSync(
  `${output}/room-${product}.json`,
  JSON.stringify(
    {
      category,
      shots: shots.map(({ gloss, view, lightness, blown, share }) => ({
        gloss,
        view,
        lightness,
        blown,
        share,
      })),
      timings,
    },
    null,
    2,
  ),
);
const urlOf = (gloss: string, view: string) => shots.find((s) => s.gloss === gloss && s.view === view)!.url;
const ceramic = ['toilet', 'basin', 'bath'].includes(category);
for (const [view] of views) {
  if (ceramic) {
    assert.notEqual(urlOf('none', view), urlOf('light', view), `gloss makes a different room (${view})`);
    assert.notEqual(urlOf('light', view), urlOf('normal', view), `the two levels differ (${view})`);
    // A glaze does not blow the white product out: little of it is pure white beyond the matte one.
    const matte = shots.find((s) => s.gloss === 'none' && s.view === view)!;
    for (const gloss of ['light', 'normal']) {
      const glazed = shots.find((s) => s.gloss === gloss && s.view === view)!;
      assert.ok(
        glazed.blown <= matte.blown + 0.03,
        `${gloss} ${view}: ${(glazed.blown * 100).toFixed(2)}% blown, matte ${(matte.blown * 100).toFixed(2)}%`,
      );
    }
  } else {
    // Not ceramic: the same room whatever gloss was saved.
    assert.equal(urlOf('none', view), urlOf('light', view), `not glazed (${view})`);
    assert.equal(urlOf('none', view), urlOf('normal', view), `not glazed (${view})`);
  }
}
console.log('compare images:', `${output}/room-${product}.png`);
