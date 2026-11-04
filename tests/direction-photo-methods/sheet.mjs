// A look-at sheet of the prepared guides and photos (prep/manifest.json): rows are products, columns are
// "photo" or "<variant>:<view>" (app, b0, b2, b3, b4, b2b3, b2b4, or any folder under prep/<product>/).
//
//   node tests/direction-photo-methods/sheet.mjs <ids,...> <columns,...> <out.png> [cell px]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [ids, cols, out, cell] = [
  process.argv[2].split(','),
  process.argv[3].split(','),
  process.argv[4],
  Number(process.argv[5] ?? 200),
];
const PREP = join(OUT, 'prep');
const manifest = JSON.parse(readFileSync(join(PREP, 'manifest.json'), 'utf8'));
const W = cell,
  H = Math.round(cell * 0.85);
const tiles = [];
for (const [r, id] of ids.entries()) {
  const entry = manifest[id];
  for (const [c, col] of cols.entries()) {
    let file;
    if (col === 'photo') file = entry.refs[0];
    else {
      const [variant, view] = col.split(':');
      file = entry.guides[variant]?.[view] ?? join(PREP, id, variant, `${view}.png`);
    }
    if (file && existsSync(file))
      tiles.push({
        input: await sharp(file)
          .flatten({ background: '#fff' })
          .resize(W - 6, H - 24, { fit: 'contain', background: '#fff' })
          .png()
          .toBuffer(),
        left: c * W + 3,
        top: r * H + 22,
      });
    tiles.push({
      input: Buffer.from(
        `<svg width="${W}" height="20"><text x="3" y="15" font-size="13">${id} ${col}</text></svg>`,
      ),
      left: c * W,
      top: r * H,
    });
  }
}
await sharp({
  create: { width: W * cols.length, height: H * ids.length, channels: 3, background: '#f4f4f4' },
})
  .composite(tiles)
  .png()
  .toFile(out);
console.log(out);
