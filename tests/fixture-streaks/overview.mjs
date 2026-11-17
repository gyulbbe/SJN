// A contact sheet of one picture kind (default today's app picture, now) to find streaks over fixtures.
// Usage: node tests/fixture-streaks/overview.mjs <out.jpg> <set> [rule]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [out, set, rule = 'now'] = process.argv.slice(2);
const rows = JSON.parse(readFileSync(join(OUT, `pictures-${set}.json`), 'utf8')).filter((r) => r.aligned);
const W = 300,
  COLS = 4,
  GAP = 4;
const tiles = [];
for (const row of rows) {
  const buf = await sharp(join(OUT, 'pictures', `${row.id}.${rule}.png`))
    .resize({ width: W })
    .png()
    .toBuffer();
  const { height } = await sharp(buf).metadata();
  const label = Buffer.from(
    `<svg width="${W}" height="18"><rect width="${W}" height="18" fill="black"/><text x="4" y="13" font-size="12" fill="white" font-family="sans-serif">${row.id}</text></svg>`,
  );
  tiles.push({ buf, height, label });
}
const H = Math.max(...tiles.map((t) => t.height)) + 18;
const rowsN = Math.ceil(tiles.length / COLS);
const comp = tiles.flatMap((t, k) => {
  const x = (k % COLS) * (W + GAP),
    y = Math.floor(k / COLS) * (H + GAP);
  return [
    { input: t.buf, left: x, top: y + 18 },
    { input: t.label, left: x, top: y },
  ];
});
await sharp({
  create: { width: COLS * (W + GAP), height: rowsN * (H + GAP), channels: 3, background: '#888' },
})
  .composite(comp)
  .jpeg({ quality: 85 })
  .toFile(out);
console.log(out, tiles.length);
