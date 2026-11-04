// A labelled (not blind) look at a round's answers: rows are products, columns "<method>/<view>-<seed>"
// or "photo". For round 1's type check only; graded rounds use review-build.mjs.
//
//   node tests/direction-photo-methods/compare-sheet.mjs <round> <ids,...> <columns,...> <out.png> [cell px]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [round, ids, cols, out, cellArg] = process.argv.slice(2);
const W = Number(cellArg ?? 240);
const tiles = [];
const rows = ids.split(','),
  columns = cols.split(',');
for (const [r, id] of rows.entries())
  for (const [c, col] of columns.entries()) {
    const file =
      col === 'photo' ? join(OUT, 'prep', id, 'refs', '1.png') : join(OUT, 'runs', round, id, `${col}.png`);
    if (!existsSync(file)) continue;
    tiles.push({
      input: await sharp(file)
        .flatten({ background: '#fff' })
        .resize(W - 4, W - 4, { fit: 'contain', background: '#fff' })
        .png()
        .toBuffer(),
      left: c * W,
      top: r * W,
    });
  }
await sharp({
  create: { width: columns.length * W, height: rows.length * W, channels: 3, background: '#bbbbbb' },
})
  .composite(tiles)
  .png()
  .toFile(out);
console.log(out);
