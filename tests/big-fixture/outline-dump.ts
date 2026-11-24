/**
 * Backlog item 6, step 17: where a mark next to a big fixture comes from. Runs the app's refine
 * (current-refine.ts) on one saved answer of the big-fixture trial, with the cut-outs refine.ts saved,
 * and writes the refine's stages and masks around a box (fractions of the picture):
 *   dump-<id>.png, left to right: render (capture on the result grid), the model's answer, after the
 *   joints step, after the colour check, the finished picture, and the masks — red where the render
 *   has a fixture, green where the cut-out holds one, blue where the refine's mask (outline.mask) calls
 *   it fixture.
 * Usage: SIDE_TILE_OUT=test-results/big-fixture-20261124 node tests/run-browser-test.mjs \
 *   tests/big-fixture/outline-dump.ts --id bath-olive-0-424242 --box 0.17,0.6,0.4,0.72 [--tuning '{…}']
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import {
  framing,
  projectCapture,
  projectMask,
  shiftMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { outlineCrops, type Cut } from '../../src/lib/ai-export/fixture-outline';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { OUT } from '../side-tile-ai/paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const id = arg('id')!;
const [bx0, by0, bx1, by1] = (arg('box') ?? '0,0,1,1').split(',').map(Number);
const tuning = arg('tuning') ? JSON.parse(arg('tuning')!) : undefined;
const root = join(OUT as string, 'app');
const scene = id.replace(/-\d+$/, '');
const dir = join(root, 'scenes', scene);
async function rgba(file: string): Promise<Pixels> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
const gray = async (file: string) => new Uint8Array(await sharp(file).extractChannel(0).raw().toBuffer());
const capture = await rgba(join(dir, 'capture.png'));
const mask: RegionMask = {
  ...JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')),
  data: await gray(join(dir, 'mask.png')),
  outside: await gray(join(dir, 'mask-outside.png')),
};
const behindMask: RegionMask = {
  ...JSON.parse(readFileSync(join(dir, 'regions-behind.json'), 'utf8')),
  data: await gray(join(dir, 'mask-behind.png')),
  outside: await gray(join(dir, 'mask-behind-outside.png')),
};
const { layout } = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as { layout: FluxInputLayout };
const fixtures =
  (JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8')).scene as FluxScene).fixtures ?? [];
const answer = await rgba(join(root, 'raw', `${id}.png`));
const frame = framing(projectCapture(capture, layout, answer), answer);
const raw =
  (frame.aligned && mask.outside
    ? restoreBackdrop({ result: answer, capture, mask, layout, shift: frame })
    : undefined) ?? answer;
const cuts: Cut[] = [];
for (const crop of outlineCrops(fixtures, raw)) {
  const file = join(root, 'cuts', `${id}-${crop.fixture}.png`);
  if (!existsSync(file)) continue;
  const cut = await rgba(file);
  const alpha = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++) {
      const sx = Math.min(cut.width - 1, Math.floor(((x + 0.5) * cut.width) / crop.width)),
        sy = Math.min(cut.height - 1, Math.floor(((y + 0.5) * cut.height) / crop.height));
      alpha[y * crop.width + x] = cut.data[(sy * cut.width + sx) * 4 + 3];
    }
  cuts.push({ ...crop, alpha });
}
const refined = refineCurrentResult({
  raw,
  capture,
  mask,
  layout,
  fixtures,
  joints: await rgba(join(dir, 'joints.png')),
  behind: { image: await rgba(join(dir, 'behind.png')), mask: behindMask },
  cuts,
  soft: await rgba(join(dir, 'soft.png')),
  ...(tuning ? { tuning } : {}),
});
const { width, height } = raw;
const renderOnResult = projectCapture(capture, layout, { width, height });
const renderMask = shiftMask(projectMask(mask, layout, { width, height }), frame.dx, frame.dy);
const masks = new Uint8ClampedArray(width * height * 4);
const cutAt = new Uint8Array(width * height);
for (const cut of cuts)
  for (let y = 0; y < cut.height; y++)
    for (let x = 0; x < cut.width; x++)
      if (cut.alpha[y * cut.width + x] > 127) cutAt[(cut.top + y) * width + cut.left + x] = 1;
const outMask = refined.outline?.mask;
for (let i = 0; i < width * height; i++) {
  masks[i * 4] = renderMask.data[i] === 255 ? 220 : 0;
  masks[i * 4 + 1] = cutAt[i] ? 200 : 0;
  masks[i * 4 + 2] = outMask && outMask.data[i] === 255 ? 230 : 0;
  masks[i * 4 + 3] = 255;
}
const box = {
  left: Math.round(bx0 * width),
  top: Math.round(by0 * height),
  width: Math.round((bx1 - bx0) * width),
  height: Math.round((by1 - by0) * height),
};
const stages: [string, Pixels | undefined][] = [
  ['render', renderOnResult],
  ['model', raw],
  ['joints', refined.joints?.image],
  ['colour', refined.review.corrected],
  ['shown', refined.shown],
  ['masks', { width, height, data: masks }],
];
const tiles = [];
for (const [, p] of stages) {
  if (!p) continue;
  tiles.push(
    await sharp(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.length), {
      raw: { width: p.width, height: p.height, channels: 4 },
    })
      .extract(box)
      .resize({ width: 400, kernel: 'nearest' })
      .png()
      .toBuffer({ resolveWithObject: true }),
  );
}
const h = Math.max(...tiles.map((t) => t.info.height));
await sharp({ create: { width: tiles.length * 406, height: h, channels: 3, background: '#ffffff' } })
  .composite(tiles.map((t, i) => ({ input: t.data, left: i * 406, top: 0 })))
  .png()
  .toFile(join(OUT as string, `dump-${id}.png`));
console.log(
  JSON.stringify({
    stages: stages.filter(([, p]) => p).map(([n]) => n),
    verdicts: refined.outline?.verdicts,
    metal: refined.metal,
    frame,
  }),
);
