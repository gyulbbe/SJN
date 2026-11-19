// Ceramics of chosen results in several pictures side by side (no AI call). Usage:
// node tests/fixture-glare/sheet.mjs <out.jpg> <rule,rule> <id[.variant]> ...   (env H, PAD)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { MATERIAL, OUT, SHADOWS, STREAKS } from './paths.mjs';

const [out, ruleArg, ...ids] = process.argv.slice(2);
const H = Number(process.env.H ?? 240),
  PAD = Number(process.env.PAD ?? 0.12);
const rows = ['new', 'reg', 'dev', 'bath', 'new-holdout'].flatMap((s) => {
  try {
    return JSON.parse(readFileSync(join(STREAKS, `pictures-${s}.json`), 'utf8'));
  } catch {
    return [];
  }
});
const find = (name) =>
  [join(OUT, 'pictures'), join(MATERIAL, 'pictures'), join(SHADOWS, 'pictures'), join(STREAKS, 'pictures')]
    .map((d) => join(d, name))
    .find((f) => existsSync(f));
const comp = [];
let y = 0,
  width = 0;
for (const full of ids) {
  const base = full.split('.')[0];
  const row = rows.find((r) => r.id === base);
  const boxes = row.boxes.filter((b) => b.box && ['toilet', 'basin', 'bath'].includes(b.kind)).map((b) => b.box);
  const l = Math.min(...boxes.map((b) => b[0])),
    t = Math.min(...boxes.map((b) => b[1])),
    r = Math.max(...boxes.map((b) => b[2])),
    b = Math.max(...boxes.map((b) => b[3]));
  let x = 0;
  for (const rule of ruleArg.split(',')) {
    const file = find(`${full}.${rule}.png`) ?? find(`${base}.${rule}.png`);
    if (!file) continue;
    const meta = await sharp(file).metadata();
    const pw = (r - l) * PAD,
      ph = (b - t) * PAD;
    const left = Math.max(0, Math.floor((l - pw) * meta.width)),
      top = Math.max(0, Math.floor((t - ph) * meta.height));
    const w = Math.min(meta.width, Math.ceil((r + pw) * meta.width)) - left,
      h = Math.min(meta.height, Math.ceil((b + ph) * meta.height)) - top;
    const W = Math.round((w / h) * H);
    comp.push({ input: await sharp(file).extract({ left, top, width: w, height: h }).resize(W, H).toBuffer(), left: x, top: y + 16 });
    comp.push({
      input: Buffer.from(`<svg width="${W}" height="16"><rect width="100%" height="100%" fill="black"/><text x="3" y="12" font-size="11" fill="white" font-family="sans-serif">${full} ${rule}</text></svg>`),
      left: x,
      top: y,
    });
    x += W + 6;
  }
  width = Math.max(width, x);
  y += H + 22;
}
await sharp({ create: { width, height: y, channels: 3, background: '#ff00ff' } }).composite(comp).jpeg({ quality: 88 }).toFile(out);
console.log(out, width, y);
