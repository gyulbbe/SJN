// The side-tile AI trial's comparison pictures (no AI call): one picture per scene and seed with the two
// revisions side by side as columns A and B, drawn at random per picture; which is before (6e0ca52) and
// which after (3037c8e) is only in key.json, so a reviewer can look without knowing. Rows: the input the
// model got (capture), the model's answer with the backdrop back (original), the app's finished result
// (refined).
//
//   node tests/side-tile-ai/sheet.mjs [--seed 1]
// Output: test-results/side-tile-ai-20261121/sheets/<scene>-<seed>.png, key.json
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261121;
const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
const dir = join(OUT, 'sheets');
mkdirSync(dir, { recursive: true });
const W = 992,
  GAP = 8,
  LABEL = 36;
const ids = readdirSync(join(OUT, 'before', 'refined'))
  .map((f) => f.slice(0, -4))
  .sort();
const key = { note: 'A/B per picture; drawn with seed ' + state, sheets: {} };
const text = (s, w) =>
  Buffer.from(
    `<svg width="${w}" height="${LABEL}"><rect width="100%" height="100%" fill="white"/><text x="8" y="26" font-family="sans-serif" font-size="22">${s}</text></svg>`,
  );
for (const id of ids) {
  const scene = id.replace(/-\d+$/, '');
  const order = random() < 0.5 ? ['before', 'after'] : ['after', 'before'];
  key.sheets[id] = { A: order[0], B: order[1] };
  const rows = [
    ['input', (rev) => join(OUT, rev, 'scenes', scene, 'capture.png')],
    ['original', (rev) => join(OUT, rev, 'original', `${id}.png`)],
    ['refined', (rev) => join(OUT, rev, 'refined', `${id}.png`)],
  ];
  const tiles = [];
  let y = 0;
  for (const [name, file] of rows) {
    const cells = await Promise.all(
      order.map((rev) => sharp(file(rev)).resize({ width: W }).png().toBuffer({ resolveWithObject: true })),
    );
    const h = Math.max(...cells.map((c) => c.info.height));
    tiles.push(
      { input: text(`${name} A`, W), left: 0, top: y },
      { input: text(`${name} B`, W), left: W + GAP, top: y },
    );
    y += LABEL;
    cells.forEach((c, i) => tiles.push({ input: c.data, left: i * (W + GAP), top: y }));
    y += h + GAP;
  }
  await sharp({ create: { width: 2 * W + GAP, height: y, channels: 3, background: 'white' } })
    .composite(tiles)
    .png()
    .toFile(join(dir, `${id}.png`));
}
writeFileSync(join(OUT, 'key.json'), JSON.stringify(key, null, 1));
console.log(`${ids.length} sheets; key in key.json`);
