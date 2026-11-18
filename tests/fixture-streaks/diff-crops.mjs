// Where two rules' pictures differ strongly (no AI call): per result the count of pixels that moved more
// than 25 (sRGB, any channel) and a crop around them, the first rule beside the second, enlarged.
// Usage: node tests/fixture-streaks/diff-crops.mjs <out.jpg> <ruleA> <ruleB> <set,set> [min px]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [out, a, b, setArg, minArg = '150'] = process.argv.slice(2);
const pick = process.env.IDS ? new Set(process.env.IDS.split(',')) : undefined;
const ids = setArg.split(',').flatMap((s) =>
  JSON.parse(readFileSync(join(OUT, `pictures-${s}.json`), 'utf8'))
    .filter((r) => r.aligned && (!pick || pick.has(r.id)))
    .map((r) => r.id),
);
const pic = (id, rule) => join(OUT, 'pictures', `${id}.${rule}.png`);
const found = [];
for (const id of ids) {
  let A, B, info;
  try {
    ({ data: A, info } = await sharp(pic(id, a)).raw().toBuffer({ resolveWithObject: true }));
    B = await sharp(pic(id, b)).raw().toBuffer();
  } catch {
    continue;
  }
  let n = 0,
    x0 = 1e9,
    y0 = 1e9,
    x1 = -1,
    y1 = -1;
  for (let p = 0; p < info.width * info.height; p++) {
    const o = p * info.channels;
    if (Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2])) <= 25) continue;
    n++;
    const x = p % info.width,
      y = (p - x) / info.width;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  console.log(id.padEnd(24), n);
  if (n >= Number(minArg)) found.push({ id, n, box: [x0, y0, x1, y1], info });
}
const H = Number(process.env.CROP_H ?? 220),
  comp = [];
let y = 0,
  width = 0;
for (const f of found) {
  const [x0, y0, x1, y1] = f.box;
  const left = Math.max(0, x0 - 25),
    top = Math.max(0, y0 - 25),
    w = Math.min(f.info.width, x1 + 25) - left,
    h = Math.min(f.info.height, y1 + 25) - top;
  const W = Math.round((w / h) * H);
  let x = 0;
  for (const rule of [a, b]) {
    comp.push({ input: await sharp(pic(f.id, rule)).extract({ left, top, width: w, height: h }).resize(W, H).toBuffer(), left: x, top: y + 16 });
    x += W + 6;
  }
  comp.push({
    input: Buffer.from(`<svg width="${Math.max(200, x)}" height="16"><rect width="100%" height="16" fill="black"/><text x="3" y="12" font-size="11" fill="white" font-family="sans-serif">${f.id} (${f.n}) ${a} | ${b}</text></svg>`),
    left: 0,
    top: y,
  });
  width = Math.max(width, x, 200);
  y += H + 22;
}
if (comp.length)
  await sharp({ create: { width, height: y, channels: 3, background: '#ff00ff' } }).composite(comp).jpeg({ quality: 85 }).toFile(out);
console.log(out, found.length);
