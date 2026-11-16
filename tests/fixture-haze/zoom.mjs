// Per result and fixture: today's view (p0) and a rule's (default f1) around the fixture box, enlarged,
// side by side (the raw model picture first). Usage: node tests/fixture-haze/zoom.mjs <out.jpg> <rule> <id> ...
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT } from './paths.mjs';

const [out, rule, ...ids] = process.argv.slice(2);
const rows = ['dev', 'holdout', 'new', 'new-holdout'].flatMap((set) => {
  try {
    return JSON.parse(readFileSync(join(OUT, `pictures-${set}.json`), 'utf8'));
  } catch {
    return [];
  }
});
const H = Number(process.env.ZOOM_H ?? 300),
  GAP = 6,
  PAD = 0.35;
const comp = [];
let y = 0,
  width = 0;
for (const id of ids) {
  const row = rows.find((r) => r.id === id);
  const sceneDir = join(row.design, '..');
  const { scene } = JSON.parse(readFileSync(join(sceneDir, 'grounding.json'), 'utf8'));
  const files = ['raw', 'p0', rule].map((k) => join(OUT, 'pictures', `${id}.${k}.png`));
  const meta = await sharp(files[0]).metadata();
  for (const fixture of scene.fixtures) {
    if (!fixture.box) continue;
    const [l, t, r, b] = fixture.box;
    const bw = r - l,
      bh = b - t;
    const left = Math.max(0, Math.floor((l - bw * PAD) * meta.width)),
      top = Math.max(0, Math.floor((t - bh * PAD) * meta.height)),
      right = Math.min(meta.width, Math.ceil((r + bw * PAD) * meta.width)),
      bottom = Math.min(meta.height, Math.ceil((b + bh * PAD) * meta.height));
    const w = Math.round(((right - left) / (bottom - top)) * H);
    let x = 0;
    for (const file of files) {
      comp.push({
        input: await sharp(file)
          .extract({ left, top, width: right - left, height: bottom - top })
          .resize(w, H, { kernel: 'nearest' })
          .toBuffer(),
        left: x,
        top: y,
      });
      x += w + GAP;
    }
    width = Math.max(width, x);
    y += H + GAP;
  }
}
await sharp({ create: { width, height: y, channels: 3, background: '#ff00ff' } })
  .composite(comp)
  .jpeg({ quality: 90 })
  .toFile(out);
console.log(out, width, y);
