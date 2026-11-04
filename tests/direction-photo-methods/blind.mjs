// Blind grading sheets for the direction-photo methods trial: pictures in a seeded random order, numbered,
// each at least 480 px on its long side, six to a sheet; which picture a number is stays in key.json
// (opened only after grading). Used for Claude's grading (docs section 7) and the review screen.
//
//   node tests/direction-photo-methods/blind.mjs <name> <list.json> [per-sheet]
//     list.json: [{ "file": "...", "group"?: "...", "ref"?: "<photo shown beside it>" }]
//   → review/<name>/sheet-NN.png and review/<name>/key.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [name, listFile, perSheetArg] = process.argv.slice(2);
const perSheet = Number(perSheetArg ?? 6);
const items = JSON.parse(readFileSync(listFile, 'utf8'));
const dir = join(OUT, 'review', name);
mkdirSync(dir, { recursive: true });

// A seeded shuffle (mulberry32), so a sheet can be made again in the same order.
let seed = 20261105;
const random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const order = items.map((item, i) => ({ item, r: random(), i })).sort((a, b) => a.r - b.r);
const key = order.map(({ item }, n) => ({ n: n + 1, ...item }));
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));

const CELL = 480,
  LABEL = 26,
  cols = 3;
for (let s = 0; s * perSheet < key.length; s++) {
  const part = key.slice(s * perSheet, (s + 1) * perSheet);
  const rows = Math.ceil(part.length / cols);
  const tiles = [];
  for (const [i, entry] of part.entries()) {
    const x = (i % cols) * (CELL + 8),
      y = Math.floor(i / cols) * (CELL + LABEL + 8);
    tiles.push({
      input: await sharp(entry.file)
        .flatten({ background: '#ffffff' })
        .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
        .png()
        .toBuffer(),
      left: x,
      top: y + LABEL,
    });
    if (entry.ref)
      tiles.push({
        input: await sharp(entry.ref)
          .flatten({ background: '#ffffff' })
          .resize(120, 120, { fit: 'contain', background: '#ffffff' })
          .extend({ top: 2, bottom: 2, left: 2, right: 2, background: '#999999' })
          .png()
          .toBuffer(),
        left: x,
        top: y + LABEL,
      });
    tiles.push({
      input: Buffer.from(
        `<svg width="${CELL}" height="${LABEL}"><text x="4" y="20" font-size="20" font-weight="bold">#${entry.n}</text></svg>`,
      ),
      left: x,
      top: y,
    });
  }
  await sharp({
    create: {
      width: cols * (CELL + 8),
      height: rows * (CELL + LABEL + 8),
      channels: 3,
      background: '#e8e8e8',
    },
  })
    .composite(tiles)
    .png()
    .toFile(join(dir, `sheet-${String(s + 1).padStart(2, '0')}.png`));
}
console.log(`${key.length} pictures → ${dir}`);
