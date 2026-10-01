/**
 * Real-WebGL comparison of the AI input's lens: the old 40° orbit lens and the current one, on the
 * same room (the FLUX comparison room: a wall basin and handheld shower on the left wall, a toilet at
 * the back right, a wall cabinet from photos). The same renderer code draws both; the old lens is the
 * same source with the lens constant put back. For each view the two pictures go side by side
 * (before left, after right) to test-results/flux-orbit-fov/, with the room's size on the picture,
 * the wall fixtures' boxes (`fixtureBounds`) and how much of the side of a left-wall fixture shows.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-orbit-fov-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/flux-orbit-fov';
await mkdir(output, { recursive: true });
const OLD_FOV = 40;
const lens = (fov: number): Plugin => ({
  name: 'orbit-lens',
  setup(b) {
    b.onLoad({ filter: /room-viewer[\\/]view-state\.ts$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8');
      assert.match(text, /export const ORBIT_FOV = \d+;/);
      return {
        contents: text.replace(/export const ORBIT_FOV = \d+;/, `export const ORBIT_FOV = ${fov};`),
        loader: 'ts',
      };
    });
  },
});
const bundle = (fov: number | undefined) =>
  build({
    stdin: {
      contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels} from './src/lib/ai-export/client';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'Fov',
    plugins: fov === undefined ? [] : [lens(fov)],
  });
const sources = { before: await bundle(OLD_FOV), after: await bundle(undefined) };
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
type Row = {
  which: 'before' | 'after';
  view: string;
  width: number;
  height: number;
  /** Where the room's outline lies in the picture, as a share of it (non-white pixels). */
  fill: { x: number; y: number };
  /** `fixtureBounds` boxes (share of the picture) of the wall fixtures, left and back. */
  boxes: Record<string, number[] | undefined>;
  url: string;
};
const views = [
  ['front', { azimuth: 0, elevation: 0 }],
  ['right-corner', { azimuth: 35, elevation: 20 }],
  ['right', { azimuth: 90, elevation: 0 }],
  ['left-corner-high', { azimuth: -40, elevation: 35 }],
  ['top', { azimuth: 0, elevation: 90 }],
] as const;
const rows: Row[] = [];
try {
  for (const which of ['before', 'after'] as const) {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://127.0.0.1:43225/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
    );
    await page.goto('http://127.0.0.1:43225/');
    await page.addScriptTag({ content: sources[which].outputFiles[0].text });
    const out = (await page.evaluate(
      async ({ which, views }) => {
        type Lib = typeof import('../src/lib/room-viewer/renderer') &
          typeof import('../src/lib/room-viewer/view-state') &
          typeof import('../src/lib/ai-export/view') &
          Pick<typeof import('./helpers/flux-room-scene'), 'buildFluxRoomScene'> &
          Pick<typeof import('../src/lib/ai-export/client'), 'readPixels'>;
        const lib = (window as unknown as { Fov: Lib }).Fov;
        const dataUrl = (blob: Blob) =>
          new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.readAsDataURL(blob);
          });
        const { assets, snapshot, imageWidth, imageHeight } = await lib.buildFluxRoomScene({ product: true });
        const reader = async (id: string) => assets[id];
        const viewer = new lib.RoomViewerRenderer();
        const result: Omit<Row, 'which'>[] = [];
        try {
          await viewer.setSnapshot(snapshot, reader, { background: '#ffffff', exportAngles: true });
          for (const [name, orbit] of views) {
            const view = lib.fluxOrbitView(orbit);
            const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1200 });
            const pixels = await lib.readPixels(blob);
            let x0 = pixels.width,
              x1 = -1,
              y0 = pixels.height,
              y1 = -1;
            for (let y = 0; y < pixels.height; y++)
              for (let x = 0; x < pixels.width; x++) {
                const o = (y * pixels.width + x) * 4;
                if (pixels.data[o] > 250 && pixels.data[o + 1] > 250 && pixels.data[o + 2] > 250) continue;
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
              }
            const boxes = viewer.fixtureBounds(imageWidth, imageHeight, view);
            result.push({
              view: name,
              width: pixels.width,
              height: pixels.height,
              fill: { x: (x1 - x0 + 1) / pixels.width, y: (y1 - y0 + 1) / pixels.height },
              boxes: Object.fromEntries(Object.entries(boxes).map(([k, v]) => [k, v ? [...v] : undefined])),
              url: await dataUrl(blob),
            });
          }
        } finally {
          viewer.dispose();
        }
        void which;
        return result;
      },
      { which, views },
    )) as Omit<Row, 'which'>[];
    assert.deepEqual(errors, [], errors.join('\n'));
    for (const row of out) rows.push({ ...row, which });
    await page.close();
  }
} finally {
  await browser.close();
}
const toPng = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const find = (which: 'before' | 'after', view: string) =>
  rows.find((r) => r.which === which && r.view === view)!;
for (const row of rows) await writeFile(`${output}/${row.which}-${row.view}.png`, toPng(row.url));
// The room's outline in the picture: the same size within a few percent (the lens is flatter, the room not smaller).
console.log('view               room fills (x × y)          before → after');
for (const [name] of views) {
  const b = find('before', name),
    a = find('after', name);
  console.log(
    `${name.padEnd(18)} ${(b.fill.x * 100).toFixed(0)}% × ${(b.fill.y * 100).toFixed(0)}%  →  ${(a.fill.x * 100).toFixed(0)}% × ${(a.fill.y * 100).toFixed(0)}%`,
  );
}
// How wide a wall fixture's box is in the front view (its side shows more with a wide lens).
const sideWidth = (which: 'before' | 'after', id: string) => {
  const box = find(which, 'front').boxes[id];
  return box ? (box[2] - box[0]) * find(which, 'front').width : undefined;
};
const report: Record<string, unknown> = {
  oldFov: OLD_FOV,
  rows: rows.map((r) => ({ ...r, url: undefined })),
};
for (const id of ['basin', 'shower', 'toilet', 'cabinet']) {
  const b = sideWidth('before', id),
    a = sideWidth('after', id);
  console.log(`${id.padEnd(8)} front-view box width ${b?.toFixed(0)}px → ${a?.toFixed(0)}px`);
  report[`${id}Width`] = { before: b, after: a };
}
// Side by side: before left, after right, one row per view.
const label = 26;
const tiles: OverlayOptions[] = [];
const sample = await sharp(toPng(rows[0].url)).metadata();
const tile = { width: 640, height: Math.round((640 * sample.height!) / sample.width!) };
const cell = (text: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${label}"><rect width="100%" height="100%" fill="#eeeeee"/><text x="8" y="18" font-family="sans-serif" font-size="14" fill="#222">${text}</text></svg>`,
  );
for (const [row, [name]] of views.entries())
  for (const [column, which] of (['before', 'after'] as const).entries()) {
    const r = find(which, name);
    const top = row * (tile.height + label),
      left = column * tile.width;
    tiles.push({
      input: await sharp(toPng(r.url)).resize(tile.width, tile.height).png().toBuffer(),
      left,
      top: top + label,
    });
    tiles.push({
      input: cell(`${which === 'before' ? `before (${OLD_FOV}° lens)` : 'after'} · ${name}`),
      left,
      top,
    });
  }
await sharp({
  create: {
    width: tile.width * 2,
    height: views.length * (tile.height + label),
    channels: 3,
    background: '#cccccc',
  },
})
  .composite(tiles)
  .png()
  .toFile(`${output}/sheet${gpu ? '-gpu' : ''}.png`);
await writeFile(`${output}/summary${gpu ? '-gpu' : ''}.json`, JSON.stringify(report, null, 2));
// The room is the same size on the picture (it was fitted to fill the frame at both lenses) and the
// white backdrop stays pure white around it.
for (const [name] of views) {
  const b = find('before', name),
    a = find('after', name);
  assert.ok(
    Math.abs(a.fill.x - b.fill.x) < 0.1 && Math.abs(a.fill.y - b.fill.y) < 0.1,
    `${name}: the room fills the frame as before`,
  );
}
console.log('compare images:', `${output}/sheet.png`);
