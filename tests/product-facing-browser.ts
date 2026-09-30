/**
 * Real-WebGL check of a photo product on the left wall facing the wall's inside ("wall", the old and
 * default behaviour) or the open front ("front"). The comparison room's wall cabinet (a brown photo
 * plane) is put on the left wall and rendered both ways from the space viewer's front view, the AI
 * export's front, top and right orbit views. It measures the brown silhouette in each picture and
 * checks that the silhouette is wide only where the product faces the camera, that the fixture box
 * (`fixtureBounds`) and the face mask (`regionMask`) follow the turn, and that the standard-model
 * fixtures next to it are pixel for pixel the same either way. Captures go to
 * test-results/product-facing/.
 *
 * Usage: node tests/run-browser-test.mjs tests/product-facing-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/product-facing';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels} from './src/lib/ai-export/client';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Facing',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43219/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43219/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const run = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/ai-export/view') &
      Pick<typeof import('./helpers/flux-room-scene'), 'buildFluxRoomScene'> &
      Pick<typeof import('../src/lib/ai-export/client'), 'readPixels'>;
    type RoomViewState = import('../src/lib/room-viewer/view-state').RoomViewState;
    const lib = (window as unknown as { Facing: Lib }).Facing;
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    const { assets, snapshot, imageWidth, imageHeight } = await lib.buildFluxRoomScene({ product: true });
    const reader = async (id: string) => assets[id];
    const views: [string, RoomViewState][] = [
      ['viewer-front', lib.defaultRoomView()],
      ['viewer-up', lib.rotateRoomView(lib.defaultRoomView(), 'up')],
      ['ai-front', lib.fluxOrbitView({ azimuth: 0, elevation: 0 })],
      ['ai-top', lib.fluxOrbitView({ azimuth: 0, elevation: 90 })],
      ['ai-right', lib.fluxOrbitView({ azimuth: 90, elevation: 0 })],
      ['ai-right-45-up-30', lib.fluxOrbitView({ azimuth: 45, elevation: 30 })],
    ];
    const edge = 768;
    const isBrown = (r: number, g: number, b: number) =>
      r > 140 && r < 215 && g > 100 && g < 170 && b > 55 && b < 125 && r - b > 55;
    const out: Record<string, unknown>[] = [];
    for (const facing of ['wall', 'front'] as const) {
      const next = structuredClone(snapshot);
      for (const scene of [next.scene, next.beforeScene]) {
        const cabinet = scene.fixtures.find((f) => f.id === 'cabinet')!;
        cabinet.roomPlacement!.face = 'left';
        cabinet.roomPlacement!.u = 0.5;
        cabinet.roomPlacement!.v = 0.4;
        if (facing === 'front') cabinet.roomPlacement!.facing = 'front';
      }
      const viewer = new lib.RoomViewerRenderer();
      try {
        await viewer.setSnapshot(next, reader, { background: '#ffffff' });
        for (const [name, view] of views) {
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
          const pixels = await lib.readPixels(blob);
          const { width, height } = pixels;
          let x0 = width,
            x1 = -1,
            y0 = height,
            y1 = -1,
            count = 0;
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const o = (y * width + x) * 4;
              if (!isBrown(pixels.data[o], pixels.data[o + 1], pixels.data[o + 2])) continue;
              count++;
              x0 = Math.min(x0, x);
              x1 = Math.max(x1, x);
              y0 = Math.min(y0, y);
              y1 = Math.max(y1, y);
            }
          const boxes = viewer.fixtureBounds(imageWidth, imageHeight, view);
          const box = boxes['cabinet'] as [number, number, number, number] | undefined;
          const mask = viewer.regionMask(width, height, view);
          // Brown pixels the face mask calls a fixture (255), and those outside the fixture box.
          let brownInMask = 0,
            brownOutsideBox = 0;
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const o = (y * width + x) * 4;
              if (!isBrown(pixels.data[o], pixels.data[o + 1], pixels.data[o + 2])) continue;
              if (mask.data[y * width + x] === 255) brownInMask++;
              if (
                !box ||
                x < box[0] * width - 2 ||
                x > box[2] * width + 2 ||
                y < box[1] * height - 2 ||
                y > box[3] * height + 2
              )
                brownOutsideBox++;
            }
          out.push({
            facing,
            name,
            width,
            height,
            silhouette: count
              ? { width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: count }
              : { width: 0, height: 0, pixels: 0 },
            box: box ? box.map((v) => Math.round(v * 1000) / 1000) : null,
            brownInMask,
            brownOutsideBox,
            url: await dataUrl(blob),
          });
        }
        if (facing === 'front')
          out.push({
            facing,
            name: 'notices',
            notices: viewer.notices.map((n) => `${n.id}: ${n.message}`),
          });
      } finally {
        viewer.dispose();
      }
    }
    return out;
  });
  const toPng = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  type Row = {
    facing: 'wall' | 'front';
    name: string;
    width: number;
    height: number;
    silhouette: { width: number; height: number; pixels: number };
    box: number[] | null;
    brownInMask: number;
    brownOutsideBox: number;
    url?: string;
    notices?: string[];
  };
  const rows = run as Row[];
  for (const row of rows)
    if (row.url) await writeFile(`${output}/${row.facing}-${row.name}.png`, toPng(row.url));
  const at = (facing: 'wall' | 'front', name: string) =>
    rows.find((r) => r.facing === facing && r.name === name)!;
  // Contact sheet: wall above, front below; one column per view.
  const names = ['viewer-front', 'viewer-up', 'ai-front', 'ai-top', 'ai-right', 'ai-right-45-up-30'];
  const first = await sharp(toPng(at('wall', names[0]).url!)).metadata();
  const tile = { width: 360, height: Math.round((360 * first.height!) / first.width!) };
  const label = 26;
  const cells = await Promise.all(
    (['wall', 'front'] as const).flatMap((facing, row) =>
      names.map(async (name, column) => {
        const r = at(facing, name);
        const text = `${facing === 'wall' ? '벽 안쪽' : '앞쪽'} · ${name} · ${r.silhouette.width}×${r.silhouette.height}px`;
        const caption = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${label}"><rect width="100%" height="100%" fill="#eeeeee"/><text x="6" y="18" font-family="sans-serif" font-size="13" fill="#222">${text}</text></svg>`,
        );
        const top = row * (tile.height + label);
        const left = column * tile.width;
        return [
          {
            input: await sharp(toPng(r.url!)).resize(tile.width, tile.height).png().toBuffer(),
            left,
            top: top + label,
          },
          { input: caption, left, top },
        ];
      }),
    ),
  );
  await sharp({
    create: {
      width: tile.width * names.length,
      height: 2 * (tile.height + label),
      channels: 3,
      background: '#cccccc',
    },
  })
    .composite(cells.flat())
    .png()
    .toFile(`${output}/sheet${gpu ? '-gpu' : ''}.png`);
  const report = rows.map((row) => {
    const copy: Partial<Row> = { ...row };
    delete copy.url;
    return copy as Omit<Row, 'url'>;
  });
  await writeFile(`${output}/summary${gpu ? '-gpu' : ''}.json`, JSON.stringify(report, null, 2));
  for (const r of report)
    if (r.silhouette)
      console.log(
        `${r.facing.padEnd(5)} ${r.name.padEnd(18)} ${String(r.silhouette.width).padStart(4)}×${String(r.silhouette.height).padEnd(4)} ${String(r.silhouette.pixels).padStart(6)}px  상자밖 ${r.brownOutsideBox} 마스크안 ${r.brownInMask}`,
      );
  console.log(rows.find((r) => r.notices)?.notices);

  // Facing the camera or not: seen from the front, a product turned to the front is several times
  // wider than the same product turned into the room (whose plane is seen at a grazing angle), and
  // the other way round from the right, where the front-facing plane is exactly edge-on.
  const width = (facing: 'wall' | 'front', name: string) => at(facing, name).silhouette.width;
  for (const name of ['viewer-front', 'ai-front'])
    assert.ok(width('front', name) >= 2.5 * width('wall', name), `${name}: wider when facing the front`);
  assert.ok(width('front', 'ai-right') <= 2, 'turned to the front, seen from the right: edge-on');
  assert.ok(width('wall', 'ai-right') >= 20, 'turned into the room, seen from the right: face-on');
  for (const name of ['viewer-front', 'ai-front'])
    assert.ok(
      at('front', name).silhouette.height >= at('wall', name).silhouette.height * 0.85,
      `${name}: as tall`,
    );
  // The box and the mask follow the turn, in every view where the product shows.
  for (const r of rows) {
    if (!r.silhouette || r.silhouette.pixels < 50) continue;
    assert.equal(r.brownOutsideBox, 0, `${r.facing} ${r.name}: the fixture box holds the product`);
    assert.ok(
      r.brownInMask > r.silhouette.pixels * 0.9,
      `${r.facing} ${r.name}: the face mask calls it a fixture`,
    );
  }
  // It stays a fixed, room-bound direction: no view turns it into the room by itself.
  assert.ok(
    rows
      .filter((r) => r.facing === 'front' && r.notices)
      .every((r) => r.notices!.some((n) => n.includes('앞쪽(정면)'))),
    'the viewer says it is turned to the front',
  );
  assert.deepEqual(errors, []);
  console.log('product-facing-browser: ok');
} finally {
  await browser.close();
}
