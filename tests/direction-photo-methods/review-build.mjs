// Blind grading sheets of a round (docs section 7): one sheet per product and view, the product's photo
// at the top left, then every candidate of the given methods and seeds at 480 px, in a seeded random
// order and lettered A, B, C…; which method and seed a letter is stays in key.json (read only after
// grading). The review screen (review/server.mjs) shows the same sets.
//
//   node tests/direction-photo-methods/review-build.mjs <round> <set-name> <products> <methods> [views]
//   → review/<set-name>/<product>-<view>.png, review/<set-name>/key.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [round, setName, productList, methodList, viewList] = process.argv.slice(2);
const RUNS = join(OUT, 'runs', round);
const dir = join(OUT, 'review', setName);
mkdirSync(dir, { recursive: true });
let seed = 1105;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const keyFile = join(dir, 'key.json');
const key = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : {};
const CELL = 480,
  LABEL = 30,
  cols = 4;
for (const product of productList.split(',')) {
  const photo = join(OUT, 'prep', product, 'refs', '1.png');
  const views = viewList ? viewList.split(',') : ['front', 'left', 'right', 'back'];
  for (const view of views) {
    const candidates = [];
    for (const method of methodList.split(','))
      for (const s of [1001, 1002, 1003, 1004]) {
        const file = join(RUNS, product, method, `${view}-${s}.png`);
        if (existsSync(file)) candidates.push({ method, seed: s, file });
      }
    if (!candidates.length) continue;
    const order = candidates
      .map((c) => ({ c, r: random() }))
      .sort((a, b) => a.r - b.r)
      .map(({ c }) => c);
    key[`${product}-${view}`] = order.map((c, i) => ({
      letter: LETTERS[i],
      method: c.method,
      seed: c.seed,
      file: c.file,
    }));
    const rows = Math.ceil((order.length + 1) / cols);
    const tiles = [];
    const place = async (file, i, label, size = CELL) => {
      const x = (i % cols) * (CELL + 8),
        y = Math.floor(i / cols) * (CELL + LABEL + 8);
      tiles.push({
        input: await sharp(file)
          .flatten({ background: '#ffffff' })
          .resize(size, size, { fit: 'contain', background: '#ffffff' })
          .png()
          .toBuffer(),
        left: x,
        top: y + LABEL,
      });
      tiles.push({
        input: Buffer.from(
          `<svg width="${CELL}" height="${LABEL}"><text x="4" y="22" font-size="22" font-weight="bold">${label}</text></svg>`,
        ),
        left: x,
        top: y,
      });
    };
    await place(photo, 0, `${product} ${view} — 입력 사진`, 360);
    for (const [i, c] of order.entries()) await place(c.file, i + 1, LETTERS[i]);
    await sharp({
      create: {
        width: cols * (CELL + 8),
        height: rows * (CELL + LABEL + 8),
        channels: 3,
        background: '#e6e6e6',
      },
    })
      .composite(tiles)
      .png()
      .toFile(join(dir, `${product}-${view}.png`));
  }
}
writeFileSync(keyFile, JSON.stringify(key, null, 1));
console.log(`sheets → ${dir}`);
