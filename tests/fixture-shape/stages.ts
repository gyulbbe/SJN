/**
 * Each step of today's refine (current-refine.ts) for one result, cropped around one fixture, to see
 * where its outline changes (no AI call, docs/fixture-shape-20261120.md): the model's picture, the
 * joints put back, colours, ceramic lightness, edges, bodies, and the masks (outline mask: what the
 * joints step keeps as fixture; colour mask; the render's fixture).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shape/stages.ts --set glare-diffsemi --id g-olive-0-424242-diffsemi --fixture 0
 * Output: test-results/fixture-shape-20261120/stages/<id>-<fixture>.png
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { projectMask, shiftMask } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { finishFixtureEdges } from '../../src/lib/ai-export/fixture-edge';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const source = haze(arg('set') as HazeSet).find((s) => s.id === arg('id'));
if (!source) throw new Error('--set <set> --id <source id>');
const k = Number(arg('fixture', '0'));
const loaded = await loadInput(source);
if (!loaded) throw new Error('framing moved');
const { input } = loaded;
const app = refineCurrentResult(input);
const outline = app.outline!;
const edges = finishFixtureEdges({
  shown: app.ceramics!.image!,
  outline,
  cuts: input.cuts,
  fixtures: input.fixtures,
});
const { width, height } = input.raw;
const frame = app.review.framing;
const render = shiftMask(projectMask(input.mask, input.layout, { width, height }), frame.dx, frame.dy);
const [l, t, r, b] = input.fixtures[k].box!;
const pad = 0.25;
const box = {
  left: Math.max(0, Math.floor((l - (r - l) * pad) * width)),
  top: Math.max(0, Math.floor((t - (b - t) * pad) * height)),
};
const right = Math.min(width, Math.ceil((r + (r - l) * pad) * width)),
  bottom = Math.min(height, Math.ceil((b + (b - t) * 0.1) * height));
const crop = { ...box, width: right - box.left, height: bottom - box.top };
const rgba = (p: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }) =>
  sharp(Buffer.from(p.data), { raw: { width: p.width, height: p.height, channels: 4 } });
// A mask as grey: 0 black, anything else white (the fixture region value as is would be dim).
const maskImage = (data: Uint8Array, on: (v: number) => boolean) => {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = on(data[i]) ? 255 : 0;
    out.set([v, v, v, 255], i * 4);
  }
  return { width, height, data: out };
};
const FIXTURE = 255;
const tiles = [
  input.raw,
  app.joints?.image ?? input.raw,
  app.review.corrected ?? app.joints?.image ?? input.raw,
  app.ceramics!.image!,
  edges.image,
  app.shown!,
  maskImage(outline.mask.data, (v) => v === FIXTURE || v === 0),
  maskImage(outline.colourMask.data, (v) => v === FIXTURE || v === 0),
  maskImage(render.data, (v) => v === FIXTURE || v === 0),
];
const scale = 4;
const parts = await Promise.all(
  tiles.map((t) =>
    rgba(t)
      .extract(crop)
      .resize({ width: crop.width * scale, kernel: 'nearest' })
      .png()
      .toBuffer(),
  ),
);
const dir = join(OUT as string, 'stages');
mkdirSync(dir, { recursive: true });
const w = crop.width * scale + 4;
await sharp({
  create: { width: w * parts.length, height: crop.height * scale, channels: 3, background: '#f0f' },
})
  .composite(parts.map((input, c) => ({ input, left: c * w, top: 0 })))
  .png()
  .toFile(join(dir, `${source.id}-${k}.png`));
console.log('fixture region values: mask', [...new Set(outline.mask.data)].slice(0, 12));
