/**
 * Real-WebGL check of the direction-photo guides (no AI call). Every shape of the bath, the toilet
 * and the basin is drawn from 정면·왼쪽·오른쪽·뒤 at its registered size. Checks: the guide is FLUX's
 * input size (long side 496, 16 px steps), its border is plain white, the product fills it with an
 * even margin, a floor product has a soft shadow under it and a wall product none, and 왼쪽 and
 * 오른쪽 are each other's mirror image (the models are symmetric left to right). The guides and a
 * contact sheet go to test-results/direction-guide/.
 *
 * Usage: node tests/run-browser-test.mjs tests/direction-guide-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/direction-guide';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/direction-photo/guide-render';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Guide',
});
type Case = {
  name: string;
  category: 'bath' | 'toilet' | 'basin';
  form: string;
  lid?: 'closed' | 'open' | 'seat';
  sizeMm: [number, number, number];
  installation: 'floor' | 'wall';
};
const cases: Case[] = [
  {
    name: 'bath-oval',
    category: 'bath',
    form: 'oval-freestanding',
    sizeMm: [1700, 560, 750],
    installation: 'floor',
  },
  {
    name: 'bath-rect',
    category: 'bath',
    form: 'rectangular',
    sizeMm: [1500, 550, 750],
    installation: 'floor',
  },
  {
    name: 'toilet-closed',
    category: 'toilet',
    form: 'two-piece',
    lid: 'closed',
    sizeMm: [380, 760, 700],
    installation: 'floor',
  },
  {
    name: 'toilet-open',
    category: 'toilet',
    form: 'two-piece',
    lid: 'open',
    sizeMm: [380, 760, 700],
    installation: 'floor',
  },
  {
    name: 'toilet-one-piece-seat',
    category: 'toilet',
    form: 'one-piece',
    lid: 'seat',
    sizeMm: [370, 660, 640],
    installation: 'floor',
  },
  {
    name: 'toilet-tankless-closed',
    category: 'toilet',
    form: 'tankless',
    lid: 'closed',
    sizeMm: [400, 520, 700],
    installation: 'floor',
  },
  {
    name: 'basin-wall-round',
    category: 'basin',
    form: 'wall-round',
    sizeMm: [500, 180, 420],
    installation: 'wall',
  },
  {
    name: 'basin-wall-rect',
    category: 'basin',
    form: 'wall-rectangular',
    sizeMm: [600, 200, 450],
    installation: 'wall',
  },
  {
    name: 'basin-pedestal-round',
    category: 'basin',
    form: 'pedestal-round',
    sizeMm: [520, 850, 450],
    installation: 'floor',
  },
  {
    name: 'basin-pedestal-rect',
    category: 'basin',
    form: 'pedestal-rectangular',
    sizeMm: [560, 850, 460],
    installation: 'floor',
  },
];
const DIRECTIONS = ['정면', '왼쪽', '오른쪽', '뒤'] as const;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43219/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43219/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const rendered = await page.evaluate(
    async ({ cases, directions }) => {
      const lib = (window as unknown as { Guide: typeof import('../src/lib/direction-photo/guide-render') })
        .Guide;
      const dataUrl = (blob: Blob) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      const out = [];
      for (const item of cases) {
        const started = performance.now();
        const guides = await lib.renderDirectionGuides(item as never, directions as never);
        const ms = performance.now() - started;
        for (const guide of guides)
          out.push({
            name: item.name,
            installation: item.installation,
            direction: guide.direction,
            width: guide.width,
            height: guide.height,
            share: guide.share,
            ms,
            png: await dataUrl(guide.blob),
          });
      }
      return out;
    },
    { cases, directions: DIRECTIONS },
  );
  assert.deepEqual(errors, []);
  const report = [];
  const byName = new Map<string, Map<string, Buffer>>();
  for (const guide of rendered) {
    const png = Buffer.from(guide.png.split(',')[1], 'base64');
    await writeFile(`${output}/${guide.name}-${guide.direction}.png`, png);
    if (!byName.has(guide.name)) byName.set(guide.name, new Map());
    byName.get(guide.name)!.set(guide.direction, png);
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, guide.width);
    assert.equal(Math.max(info.width, info.height), 496, `${guide.name} ${guide.direction} long side`);
    assert.equal(info.width % 16, 0);
    assert.equal(info.height % 16, 0);
    // Border: white. Product: inside with a margin (dark pixels only away from the edge).
    let left = info.width,
      right = -1,
      top = info.height,
      bottom = -1;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 3;
        const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (v < 244) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    const edge = Math.min(left, top, info.width - 1 - right, info.height - 1 - bottom);
    assert.ok(edge >= 4, `${guide.name} ${guide.direction}: margin ${edge}`);
    // The shadow's faint tail lies just under the product: a floor product has one, a wall product none.
    let tail = 0;
    for (let y = bottom + 1; y < info.height; y++)
      for (let x = left; x <= right; x++) {
        const i = (y * info.width + x) * 3;
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 253) tail++;
      }
    if (guide.installation === 'floor') assert.ok(tail > 0, `${guide.name} ${guide.direction}: no shadow`);
    else assert.equal(tail, 0, `${guide.name} ${guide.direction}: a wall product has no shadow`);
    const fill = Math.max((right - left + 1) / info.width, (bottom - top + 1) / info.height);
    assert.ok(fill > 0.85 && fill < 0.95, `${guide.name} ${guide.direction}: fills ${fill.toFixed(2)}`);
    report.push({
      name: guide.name,
      direction: guide.direction,
      size: `${info.width}x${info.height}`,
      share: Number(guide.share.toFixed(3)),
      fill: Number(fill.toFixed(3)),
      ms: Math.round(guide.ms),
    });
  }
  // Contact sheet: one row per shape, four directions.
  const cell = 248;
  const rows = [...byName.entries()];
  const sheet = await sharp({
    create: { width: cell * 4 + 50, height: rows.length * (cell + 20), channels: 3, background: '#cccccc' },
  })
    .composite(
      (
        await Promise.all(
          rows.flatMap(([, guides], row) =>
            DIRECTIONS.map(async (direction, column) => ({
              input: await sharp(guides.get(direction)!)
                .resize(cell - 8, cell - 8, { fit: 'contain', background: '#ffffff' })
                .png()
                .toBuffer(),
              left: 50 + column * cell + 4,
              top: row * (cell + 20) + 16,
            })),
          ),
        )
      ).flat(),
    )
    .png()
    .toBuffer();
  await writeFile(`${output}/sheet.png`, sheet);
  // 왼쪽 and 오른쪽 of a left–right symmetric model have mirror-image outlines (the light comes from
  // the picture's upper left in both, so the shading is not mirrored): each row's outer edges.
  const edges = async (png: Buffer, flop: boolean) => {
    const image = flop ? sharp(png).flop() : sharp(png);
    const { data, info } = await image.removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    const rows: [number, number][] = [];
    for (let y = 0; y < info.height; y++) {
      let l = -1,
        r = -1;
      for (let x = 0; x < info.width; x++)
        if (data[y * info.width + x] < 250) {
          if (l < 0) l = x;
          r = x;
        }
      rows.push([l, r]);
    }
    return rows;
  };
  for (const [name, guides] of byName) {
    const left = await edges(guides.get('왼쪽')!, false);
    const right = await edges(guides.get('오른쪽')!, true);
    let off = 0,
      rows = 0;
    left.forEach(([l, r], y) => {
      if (l < 0 && right[y][0] < 0) return;
      rows++;
      off += l < 0 || right[y][0] < 0 ? 496 : Math.abs(l - right[y][0]) + Math.abs(r - right[y][1]);
    });
    const mean = off / rows / 2;
    assert.ok(mean < 2, `${name}: 왼쪽 vs mirrored 오른쪽 edges differ by ${mean.toFixed(2)} px`);
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.table(report);
  console.log(`가이드 ${rendered.length}장 · ${output}/sheet.png`);
} finally {
  await browser.close();
}
