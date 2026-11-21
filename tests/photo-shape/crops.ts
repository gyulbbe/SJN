/**
 * Close-ups for the photo-shape trial (no AI call, docs/photo-shape-20261121.md): per fixture, the
 * render, the model's picture, and the model's picture with the render's outline (green) and the
 * cut-out's (red), with its shape.ts numbers, so a low shape score can be told apart as a changed
 * shape or a bad cut-out.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-shape/crops.ts <set> [--only a,b] [--kind basin] [--below 0.92] [--out name]
 * Output: test-results/photo-shape-20261121/<name>.png (default crops-<set>.png) and its list in the console
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  FIXTURE_REGION,
  framing,
  projectCapture,
  projectMask,
  shiftMask,
  type Pixels,
} from '../../src/lib/ai-export/color';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { trimProtrusions } from '../../src/lib/ai-export/fixture-shape';
import { FLUX_FIXTURE_KINDS } from '../../src/lib/ai-export/scene-contract';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { OUT } from './paths.mjs';
import { shapeRows } from './shape';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const set = process.argv
  .slice(2)
  .find((a, k, all) => !a.startsWith('--') && !all[k - 1]?.startsWith('--') && !/[\\/.]/.test(a))!;
const only = arg('--only')?.split(',');
const kind = arg('--kind');
const below = Number(arg('--below') ?? 2);
const H = 150;

const rows = (await shapeRows(set as HazeSet, only)).filter(
  (r) => r.iou >= 0.6 && (!kind || r.kind === kind) && r.shape < below,
);
const tiles: { input: Buffer; width: number }[][] = [];
for (const source of haze(set as HazeSet)) {
  const mine = rows.filter((r) => r.id === source.id);
  if (!mine.length) continue;
  const loaded = await loadInput(source);
  if (!loaded?.input.cuts) continue;
  const { input } = loaded;
  const { width, height } = input.raw;
  const size = { width, height };
  const frame = framing(projectCapture(input.capture, input.layout, size), input.raw);
  const render = projectCapture(input.capture, input.layout, size);
  const renderMask = shiftMask(projectMask(input.mask, input.layout, size), frame.dx, frame.dy);
  const { cuts } = trimProtrusions({ cuts: input.cuts, renderMask, fixtures: input.fixtures });
  const own = fixtureMask(renderMask, input.fixtures, FLUX_FIXTURE_KINDS).mask.data;
  const chosen = input.fixtures.filter((f) => f.box && FLUX_FIXTURE_KINDS.includes(f.kind));
  for (const row of mine) {
    const fixture = input.fixtures[row.fixture];
    const cut = cuts.find((c) => c.fixture === row.fixture)!;
    const label = chosen.indexOf(fixture) + 1;
    const [l, t, r, b] = fixture.box!;
    const pw = (r - l) * 0.35,
      ph = (b - t) * 0.35;
    const left = Math.max(0, Math.floor((l - pw) * width)),
      top = Math.max(0, Math.floor((t - ph) * height)),
      right = Math.min(width, Math.ceil((r + pw) * width)),
      bottom = Math.min(height, Math.ceil((b + ph) * height));
    const w = right - left,
      h = bottom - top;
    const crop = (image: Pixels, shift = { dx: 0, dy: 0 }, overlay = false) => {
      const data = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = Math.max(0, Math.min(width - 1, left + x - shift.dx)),
            sy = Math.max(0, Math.min(height - 1, top + y - shift.dy));
          const o = (sy * width + sx) * 4;
          let rgb = [image.data[o], image.data[o + 1], image.data[o + 2]];
          if (overlay) {
            const i = (top + y) * width + left + x;
            const inside = (m: (j: number) => boolean) =>
              m(i) && [-1, 1, -width, width].some((d) => i + d >= 0 && i + d < width * height && !m(i + d));
            const isRender = (j: number) => own[j] === label && renderMask.data[j] === FIXTURE_REGION;
            const isCut = (j: number) => {
              const cx = (j % width) - cut.left,
                cy = Math.floor(j / width) - cut.top;
              return (
                cx >= 0 &&
                cy >= 0 &&
                cx < cut.width &&
                cy < cut.height &&
                cut.alpha[cy * cut.width + cx] >= 128
              );
            };
            if (inside(isRender)) rgb = [0, 200, 0];
            if (inside(isCut)) rgb = [230, 0, 0];
          }
          data.set(rgb, (y * w + x) * 3);
        }
      return sharp(data, { raw: { width: w, height: h, channels: 3 } })
        .resize({ height: H })
        .png()
        .toBuffer();
    };
    const parts = [
      await crop(render, { dx: frame.dx, dy: frame.dy }),
      await crop(input.raw),
      await crop(input.raw, undefined, true),
    ];
    const line: { input: Buffer; width: number }[] = [];
    for (const p of parts) line.push({ input: p, width: (await sharp(p).metadata()).width! });
    tiles.push(line);
    console.log(
      `${String(tiles.length).padStart(2)} ${row.id} #${row.fixture} ${row.kind} shape ${row.shape} iou ${row.iou} out ${row.out} miss ${row.miss} aspect ${row.aspect}`,
    );
  }
}
if (tiles.length) {
  const W = Math.max(...tiles.map((line) => line.reduce((s, t) => s + t.width + 6, 0)));
  const composite: { input: Buffer; left: number; top: number }[] = [];
  tiles.forEach((line, k) => {
    let x = 0;
    for (const t of line) {
      composite.push({ input: t.input, left: x, top: k * (H + 6) });
      x += t.width + 6;
    }
  });
  const file = join(OUT as string, `${arg('--out') ?? `crops-${set}`}.png`);
  await sharp({ create: { width: W, height: tiles.length * (H + 6), channels: 3, background: '#fff' } })
    .composite(composite)
    .png()
    .toFile(file);
  writeFileSync(
    file.replace(/\.png$/, '.txt'),
    rows.map((r) => `${r.id} #${r.fixture} ${r.shape}`).join('\n'),
  );
}
