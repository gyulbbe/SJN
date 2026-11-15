// A picture sheet for a decision: per scene, the design and the keep levels side by side.
// Usage: node tests/ai-light/sheet.mjs <out.jpg> <id> [<id> ...]   (development and holdout pictures)
import sharp from 'sharp';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './paths.mjs';

const [out, ...ids] = process.argv.slice(2);
const rows = ['dev', 'holdout']
  .map((set) => join(OUT, `pictures-${set}.json`))
  .filter((file) => existsSync(file))
  .flatMap((file) => JSON.parse(readFileSync(file, 'utf8')));
const W = 480,
  GAP = 6;
const columns = ['design', 'k100', 'k50', 'k25'];
const comp = [];
let y = 0;
for (const id of ids) {
  const row = rows.find((r) => r.id === id);
  let h = 0;
  for (const [k, column] of columns.entries()) {
    const file = column === 'design' ? row.design : join(OUT, 'pictures', `${id}.${column}.png`);
    const tile = await sharp(file).resize({ width: W }).png().toBuffer();
    h = Math.max(h, (await sharp(tile).metadata()).height);
    comp.push({ input: tile, left: k * (W + GAP), top: y });
  }
  y += h + GAP;
}
await sharp({
  create: { width: columns.length * (W + GAP) - GAP, height: y - GAP, channels: 3, background: '#fff' },
})
  .composite(comp)
  .jpeg({ quality: 86 })
  .toFile(out);
