// A region of several pictures of one result side by side, enlarged (no AI call). The region is
// x0,y0,x1,y1 in 0..1 of the picture. Pictures come from <dir>/<id>.<rule>.png (this trial's
// pictures first, then the fixture-streaks pictures).
// Usage: node tests/fixture-shadows/crop.mjs <out.png> <id> <x0,y0,x1,y1> <rule,rule,...> [scale]
//   env PICS=<dir> to read another picture folder; a rule may be a path ending in .png.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, STREAKS } from './paths.mjs';

const [out, id, regionArg, ruleArg, scaleArg = '3'] = process.argv.slice(2);
const [x0, y0, x1, y1] = regionArg.split(',').map(Number);
const scale = Number(scaleArg);
const dirs = process.env.PICS ? [process.env.PICS] : [join(OUT, 'pictures'), join(STREAKS, 'pictures')];
const find = (rule) =>
  dirs.map((d) => join(d, `${id}.${rule}.png`)).find((f) => existsSync(f)) ??
  join(dirs[0], `${id}.${rule}.png`);
const tiles = [];
const GAP = 6,
  LABEL = 18;
let width = 0,
  height = 0;
for (const rule of ruleArg.split(',')) {
  const file = rule.endsWith('.png') ? rule : find(rule);
  const meta = await sharp(file).metadata();
  const left = Math.max(0, Math.floor(x0 * meta.width)),
    top = Math.max(0, Math.floor(y0 * meta.height));
  const w = Math.min(meta.width - left, Math.ceil((x1 - x0) * meta.width)),
    h = Math.min(meta.height - top, Math.ceil((y1 - y0) * meta.height));
  const buf = await sharp(file)
    .extract({ left, top, width: w, height: h })
    .resize({ width: Math.round(w * scale), kernel: 'nearest' })
    .png()
    .toBuffer();
  const m = await sharp(buf).metadata();
  const label = Buffer.from(
    `<svg width="${m.width}" height="${LABEL}"><rect width="100%" height="100%" fill="black"/><text x="4" y="13" font-size="13" fill="white" font-family="sans-serif">${(rule.split(/[\/]/).pop() ?? rule).replace(/&/g, '&amp;')}</text></svg>`,
  );
  tiles.push({ input: label, left: width, top: 0 }, { input: buf, left: width, top: LABEL });
  width += m.width + GAP;
  height = Math.max(height, m.height + LABEL);
}
await sharp({ create: { width, height, channels: 3, background: '#ff00ff' } })
  .composite(tiles)
  .png()
  .toFile(out);
console.log(out, width, height);
