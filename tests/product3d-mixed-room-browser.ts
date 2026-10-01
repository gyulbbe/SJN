/**
 * The 3D room (and so the AI conversion input and the export, which draw the same room) with a saved
 * product in each view mode: a saved TripoSR mesh (test-results/product3d-batch, no new AI run)
 * standing on the floor of the FLUX comparison room, saved as the original colours (no field),
 * "lit" and "mixed", seen from the front and from behind. The three modes use one colour
 * calculation (src/lib/product3d/shading.ts); this shows what it makes in the room: the back of the
 * product is the product's colour in "mixed", the model's dull guess in the original colours.
 *
 * Writes test-results/product3d-mixed/room-<product>.png (rows: original, lit, mixed; columns: front,
 * back) and prints the mean colour of the product's pixels.
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-mixed-room-browser.ts [--gpu]
 *   MESH=02-smart-toilet   the mesh folder (default 02-smart-toilet)
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';
import { srgbToLab } from '../src/lib/product3d/albedo';

const gpu = process.argv.includes('--gpu');
const product = process.env.MESH ?? '02-smart-toilet';
const directory = `test-results/product3d-batch/${product}/`;
if (!existsSync(`${directory}mesh-positions.bin`)) {
  console.log(`${product}: no mesh in test-results/product3d-batch, skipped`);
  process.exit(0);
}
const output = 'test-results/product3d-mixed';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels} from './src/lib/ai-export/client';export {makeProductMeshAsset} from './src/lib/product3d/codec';export {createDefaultPose} from './src/lib/product3d/pose';export {estimateUprightQuaternion} from './src/lib/product3d/upright';export {projectRoomFixture} from './src/lib/room-fixtures';`,
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
const modes = ['baked', 'lit', 'mixed'] as const;
const views = [
  ['front', 0],
  ['back', 180],
] as const;
type Shot = { mode: string; view: string; url: string; mean: number[]; share: number };
let shots: Shot[] = [];
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
  shots = (await page.evaluate(
    async ({ data, modes, views }) => {
      type Lib = typeof import('../src/lib/room-viewer/renderer') &
        typeof import('../src/lib/ai-export/view') &
        Pick<typeof import('./helpers/flux-room-scene'), 'buildFluxRoomScene'> &
        Pick<typeof import('../src/lib/ai-export/client'), 'readPixels'> &
        Pick<typeof import('../src/lib/product3d/codec'), 'makeProductMeshAsset'> &
        Pick<typeof import('../src/lib/product3d/pose'), 'createDefaultPose'> &
        Pick<typeof import('../src/lib/product3d/upright'), 'estimateUprightQuaternion'> &
        Pick<typeof import('../src/lib/room-fixtures'), 'projectRoomFixture'>;
      const lib = (window as unknown as { Room: Lib }).Room;
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
      type Shading = import('../src/lib/product3d/state-types').ProductShading;
      const material = (shading?: Shading) => ({
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
              ...(shading && shading !== 'baked' ? { shading } : {}),
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
        color: { ...color },
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
      const draw = async (shading: Shading | undefined, withProduct: boolean, azimuth: number) => {
        const next = structuredClone(snapshot);
        next.materials.real = material(shading);
        for (const scene of [next.scene, next.beforeScene]) {
          scene.fixtures = withProduct ? [fixture() as never] : [];
          if (withProduct) lib.projectRoomFixture(room, scene.fixtures[0], aspect);
        }
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(next, reader, { background: '#ffffff', exportAngles: true });
          const view = lib.fluxOrbitView({ azimuth, elevation: 18 });
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1000 });
          return { blob, pixels: await lib.readPixels(blob) };
        } finally {
          viewer.dispose();
        }
      };
      const out: { mode: string; view: string; url: string; mean: number[]; share: number }[] = [];
      for (const [view, azimuth] of views) {
        // The room without the product: what differs from it in a picture is the product.
        const empty = await draw(undefined, false, azimuth);
        for (const mode of modes) {
          const shot = await draw(mode as Shading, true, azimuth);
          const sum = [0, 0, 0];
          let count = 0;
          const { data: now, width, height } = shot.pixels;
          for (let i = 0; i < width * height; i++) {
            const o = i * 4;
            const change =
              Math.abs(now[o] - empty.pixels.data[o]) +
              Math.abs(now[o + 1] - empty.pixels.data[o + 1]) +
              Math.abs(now[o + 2] - empty.pixels.data[o + 2]);
            if (change < 45) continue;
            count++;
            for (let c = 0; c < 3; c++) sum[c] += now[o + c];
          }
          out.push({
            mode,
            view,
            url: await dataUrl(shot.blob),
            mean: sum.map((s) => s / Math.max(1, count) / 255),
            share: count / (width * height),
          });
        }
      }
      return out;
    },
    {
      data: { p: b64('mesh-positions.bin'), c: b64('mesh-colors.bin'), i: b64('mesh-indices.bin') },
      modes,
      views,
    },
  )) as Shot[];
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
}
const png = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const first = await sharp(png(shots[0].url)).metadata();
const tile = { width: 600, height: Math.round((600 * first.height!) / first.width!) };
const label = 22;
const composites: OverlayOptions[] = [];
for (const [row, mode] of modes.entries())
  for (const [column, [view]] of views.entries()) {
    const shot = shots.find((s) => s.mode === mode && s.view === view)!;
    const left = column * tile.width,
      top = row * (tile.height + label);
    composites.push({
      input: await sharp(png(shot.url)).resize(tile.width, tile.height).toBuffer(),
      left,
      top: top + label,
    });
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${label}"><rect width="100%" height="100%" fill="#e6e6e0"/><text x="6" y="16" font-family="sans-serif" font-size="13" fill="#222">${product} · ${mode} · ${view}</text></svg>`,
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
// How far from neutral the product's pixels are, and how light (Lab of the mean colour).
const lab = (mean: number[]) => srgbToLab(mean[0], mean[1], mean[2]);
console.log('mode    view   product share   L*     chroma a*b*');
const chroma: Record<string, number> = {};
for (const shot of shots) {
  const [l, a, b] = lab(shot.mean);
  chroma[`${shot.mode}-${shot.view}`] = Math.hypot(a, b);
  console.log(
    `${shot.mode.padEnd(7)} ${shot.view.padEnd(6)} ${(shot.share * 100).toFixed(1).padStart(8)}%   ${l.toFixed(1).padStart(5)}  ${Math.hypot(a, b).toFixed(1).padStart(6)}`,
  );
  assert.ok(shot.share > 0.01, `${shot.mode} ${shot.view}: the product shows in the picture`);
}
// Seen from behind, the original colours are the model's dull guess; mixed is the product's own colour.
assert.ok(
  chroma['mixed-back'] < chroma['baked-back'] || chroma['baked-back'] < 3,
  `the back in mixed (${chroma['mixed-back'].toFixed(1)}) is not more tinted than in the original colours (${chroma['baked-back'].toFixed(1)})`,
);
// The three modes draw three different rooms.
const urlOf = (mode: string, view: string) => shots.find((s) => s.mode === mode && s.view === view)!.url;
for (const [a, b] of [
  ['baked', 'lit'],
  ['baked', 'mixed'],
  ['lit', 'mixed'],
] as const)
  for (const [view] of views)
    assert.notEqual(urlOf(a, view), urlOf(b, view), `${a} and ${b} differ (${view})`);
console.log('compare images:', `${output}/room-${product}.png`);
