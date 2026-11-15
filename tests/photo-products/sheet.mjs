// A picture sheet: per scene and seed, the design and the four rules (P0, S, P, S+P) side by side,
// cropped (fractions). Usage: node tests/photo-products/sheet.mjs <out.jpg> <x0,y0,x1,y1|full> <scene-seed> ...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [out, boxArg, ...ids] = process.argv.slice(2);
const box = boxArg === 'full' ? [0, 0, 1, 1] : boxArg.split(',').map(Number);
const rows = ['step0', 'dev', 'holdout'].flatMap((set) => {
  try {
    return JSON.parse(readFileSync(join(OUT, `pictures-${set}.json`), 'utf8'));
  } catch {
    return [];
  }
});
const RULES = [
  ['cur', 'p0'],
  ['s', 'p0'],
  ['cur', 'p'],
  ['s', 'p'],
];
const W = 420,
  GAP = 6;
const comp = [];
let y = 0;
for (const id of ids) {
  const [scene, seed] = id.split('-');
  const row = rows.find((r) => r.scene === scene && String(r.seed) === seed);
  if (!row) throw new Error(`no picture ${id}`);
  const files = [
    row.design,
    ...RULES.map(([m, s]) => join(OUT, 'pictures', `${scene}-${m}-${seed}.${s}.png`)),
  ];
  let h = 0;
  for (const [k, file] of files.entries()) {
    const image = sharp(file);
    const { width, height } = await image.metadata();
    const tile = await image
      .extract({
        left: Math.round(box[0] * width),
        top: Math.round(box[1] * height),
        width: Math.round((box[2] - box[0]) * width),
        height: Math.round((box[3] - box[1]) * height),
      })
      .resize({ width: W })
      .png()
      .toBuffer();
    h = Math.max(h, (await sharp(tile).metadata()).height);
    comp.push({ input: tile, left: k * (W + GAP), top: y });
  }
  y += h + GAP;
}
await sharp({ create: { width: 5 * (W + GAP) - GAP, height: y - GAP, channels: 3, background: '#fff' } })
  .composite(comp)
  .jpeg({ quality: 86 })
  .toFile(out);
