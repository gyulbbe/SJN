// Sheets for my own look (no AI call): per result of a set, the region around its ceramics (toilet,
// basin, bath; grown by PAD) in each rule side by side, ROWS results a sheet.
// Usage: node tests/fixture-shadows/sheet.mjs <out prefix> <set> <rule,rule,...>
//   env IDS=a,b to pick results, H (row height, default 260), ROWS (default 6), PAD (default 0.15)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, STREAKS } from './paths.mjs';

const [prefix, set, ruleArg] = process.argv.slice(2);
const rules = ruleArg.split(',');
const pick = process.env.IDS ? new Set(process.env.IDS.split(',')) : undefined;
const H = Number(process.env.H ?? 260),
  ROWS = Number(process.env.ROWS ?? 6),
  PAD = Number(process.env.PAD ?? 0.15),
  GAP = 6,
  LABEL = 16;
const rows = JSON.parse(readFileSync(join(STREAKS, `pictures-${set}.json`), 'utf8')).filter(
  (r) => r.aligned && (!pick || pick.has(r.id)),
);
const pic = (id, rule) =>
  [join(OUT, 'pictures'), join(STREAKS, 'pictures')]
    .map((d) => join(d, `${id}.${rule}.png`))
    .find((f) => existsSync(f));
const label = (text, width) =>
  Buffer.from(
    `<svg width="${width}" height="${LABEL}"><rect width="100%" height="100%" fill="black"/><text x="3" y="12" font-size="11" fill="white" font-family="sans-serif">${text}</text></svg>`,
  );
let sheet = 0;
for (let start = 0; start < rows.length; start += ROWS) {
  const comp = [];
  let y = 0,
    width = 0;
  for (const row of rows.slice(start, start + ROWS)) {
    const boxes = row.boxes
      .filter((b) => b.box && ['toilet', 'basin', 'bath'].includes(b.kind))
      .map((b) => b.box);
    if (!boxes.length) continue;
    const l = Math.min(...boxes.map((b) => b[0])),
      t = Math.min(...boxes.map((b) => b[1])),
      r = Math.max(...boxes.map((b) => b[2])),
      b = Math.max(...boxes.map((b) => b[3]));
    let x = 0;
    for (const rule of rules) {
      const file = pic(row.id, rule);
      if (!file) continue;
      const meta = await sharp(file).metadata();
      const pw = (r - l) * PAD,
        ph = (b - t) * PAD;
      const left = Math.max(0, Math.floor((l - pw) * meta.width)),
        top = Math.max(0, Math.floor((t - ph) * meta.height)),
        w = Math.min(meta.width, Math.ceil((r + pw) * meta.width)) - left,
        h = Math.min(meta.height, Math.ceil((b + ph) * meta.height)) - top;
      const W = Math.round((w / h) * H);
      comp.push({
        input: await sharp(file).extract({ left, top, width: w, height: h }).resize(W, H).toBuffer(),
        left: x,
        top: y + LABEL,
      });
      comp.push({ input: label(`${row.id} ${rule}`, W), left: x, top: y });
      x += W + GAP;
    }
    width = Math.max(width, x);
    y += H + LABEL + GAP;
  }
  if (!comp.length) continue;
  const file = `${prefix}-${++sheet}.jpg`;
  await sharp({ create: { width, height: y, channels: 3, background: '#ff00ff' } })
    .composite(comp)
    .jpeg({ quality: 88 })
    .toFile(file);
  console.log(file, width, y);
}
