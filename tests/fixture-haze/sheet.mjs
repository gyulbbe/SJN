// Per result: the design, the model's picture, today's view and the candidate's, cropped (fractions).
// Usage: node tests/fixture-haze/sheet.mjs <out.jpg> <rule> <x0,y0,x1,y1> <id> ...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [out, rule, boxArg, ...ids] = process.argv.slice(2);
const box = boxArg.split(',').map(Number);
const rows = ['dev', 'holdout', 'new'].flatMap((set) => {
  try {
    return JSON.parse(readFileSync(join(OUT, `pictures-${set}.json`), 'utf8'));
  } catch {
    return [];
  }
});
const W = Number(process.env.SHEET_W ?? 440),
  GAP = 6;
const comp = [];
let y = 0;
for (const id of ids) {
  const row = rows.find((r) => r.id === id);
  const files = [
    row.design,
    join(OUT, 'pictures', `${id}.raw.png`),
    join(OUT, 'pictures', `${id}.p0.png`),
    join(OUT, 'pictures', `${id}.${rule}.png`),
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
await sharp({ create: { width: 4 * (W + GAP) - GAP, height: y - GAP, channels: 3, background: '#fff' } })
  .composite(comp)
  .jpeg({ quality: 86 })
  .toFile(out);
