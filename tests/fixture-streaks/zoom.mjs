// Per result and ceramic fixture: the pictures named in --rules (default ref,raw,now) around the
// fixture box, enlarged, side by side. Usage:
// node tests/fixture-streaks/zoom.mjs <out.jpg> <rules comma list> <id>[:<fixture index>] ...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [out, ruleArg, ...ids] = process.argv.slice(2);
const rules = ruleArg.split(',');
const rows = ['dev', 'holdout', 'new', 'new-holdout', 'bath', 'reg'].flatMap((set) => {
  try {
    return JSON.parse(readFileSync(join(OUT, `pictures-${set}.json`), 'utf8'));
  } catch {
    return [];
  }
});
const H = Number(process.env.ZOOM_H ?? 300),
  GAP = 6,
  PAD = Number(process.env.ZOOM_PAD ?? 0.15),
  LABEL = 16;
const comp = [];
let y = 0,
  width = 0;
for (const spec of ids) {
  const [id, only] = spec.split(':');
  const row = rows.find((r) => r.id === id);
  const files = rules.map((k) => join(OUT, 'pictures', `${id}.${k}.png`));
  const meta = await sharp(files[0]).metadata();
  for (const [k, fixture] of row.boxes.entries()) {
    if (!fixture.box || !['toilet', 'basin', 'bath'].includes(fixture.kind)) continue;
    if (only !== undefined && Number(only) !== k) continue;
    const [l, t, r, b] = fixture.box;
    const bw = r - l,
      bh = b - t;
    const left = Math.max(0, Math.floor((l - bw * PAD) * meta.width)),
      top = Math.max(0, Math.floor((t - bh * PAD) * meta.height)),
      right = Math.min(meta.width, Math.ceil((r + bw * PAD) * meta.width)),
      bottom = Math.min(meta.height, Math.ceil((b + bh * PAD) * meta.height));
    const w = Math.round(((right - left) / (bottom - top)) * H);
    let x = 0;
    for (const [n, file] of files.entries()) {
      comp.push({
        input: await sharp(file)
          .extract({ left, top, width: right - left, height: bottom - top })
          .resize(w, H)
          .toBuffer(),
        left: x,
        top: y + LABEL,
      });
      comp.push({
        input: Buffer.from(
          `<svg width="${w}" height="${LABEL}"><rect width="${w}" height="${LABEL}" fill="black"/><text x="3" y="12" font-size="11" fill="white" font-family="sans-serif">${n === 0 ? `${id}:${k} ` : ''}${rules[n]}</text></svg>`,
        ),
        left: x,
        top: y,
      });
      x += w + GAP;
    }
    width = Math.max(width, x);
    y += H + LABEL + GAP;
  }
}
await sharp({ create: { width, height: y, channels: 3, background: '#ff00ff' } })
  .composite(comp)
  .jpeg({ quality: 90 })
  .toFile(out);
console.log(out, width, y);
