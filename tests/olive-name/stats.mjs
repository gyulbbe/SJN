// Item 5's wall numbers (no AI call): over each scene's wall pixels (the capture's mask and regions,
// scaled to the answer), the mean CIELAB L*, chroma C* and hue angle h of the app picture (capture.png)
// and of the model's raw answer under each sentence (prepare.mjs), and of the app's finished result where refine.ts made it. Olive #6a6b51 sits near h 100°; a
// grey stone answer keeps L* but loses C*.
//   node tests/olive-name/stats.mjs
// Output: test-results/olive-name-20261124/stats.json and a table on stdout
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, SENTENCES } from './prepare.mjs';

const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const lab = (r, g, b) => {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B,
    Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
export async function wallColour(image, dir) {
  const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')).regions;
  const pic = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(join(dir, 'mask.png'))
    .extractChannel(0)
    .resize(pic.info.width, pic.info.height, { kernel: 'nearest' })
    .raw()
    .toBuffer();
  const s = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    const k = mask[i];
    if (!k || k === 255 || regions[k - 1]?.kind !== 'wall') continue;
    const L = lab(pic.data[i * 3], pic.data[i * 3 + 1], pic.data[i * 3 + 2]);
    for (let c = 0; c < 3; c++) s[c] += L[c];
    n++;
  }
  const [L, A, B] = s.map((v) => v / n);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { L: +L.toFixed(1), C: +Math.hypot(A, B).toFixed(1), h: Math.round(h) };
}
const rows = {};
const revs = Object.keys(SENTENCES);
const ids = readdirSync(join(OUT, 'cur', 'raw'))
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.slice(0, -4))
  .sort();
console.log('scene-seed'.padEnd(26), 'app', ...revs.map((r) => r.padEnd(18)));
for (const id of ids) {
  const scene = id.replace(/-\d+$/, '');
  const dir = join(OUT, 'cur', 'scenes', scene);
  const row = { app: await wallColour(join(dir, 'capture.png'), dir) };
  for (const rev of revs) row[rev] = await wallColour(join(OUT, rev, 'raw', `${id}.png`), dir);
  // The app's finished result (refine.ts), where it was made.
  for (const rev of revs) {
    const file = join(OUT, rev, 'refined', `${id}.png`);
    if (existsSync(file)) row[`${rev}/refined`] = await wallColour(file, dir);
  }
  rows[id] = row;
  const cell = (c) => `L${c.L} C${c.C} h${c.h}`.padEnd(18);
  console.log(id.padEnd(26), cell(row.app), ...revs.map((r) => cell(row[r])));
}
const mean = (rev, key) => +(ids.reduce((a, id) => a + rows[id][rev][key], 0) / ids.length).toFixed(1);
const keys = Object.keys(rows[ids[0]]).filter((k) => ids.every((id) => rows[id][k]));
const summary = Object.fromEntries(keys.map((r) => [r, { L: mean(r, 'L'), C: mean(r, 'C') }]));
console.log('mean', JSON.stringify(summary));
writeFileSync(join(OUT, 'stats.json'), JSON.stringify({ rows, summary }, null, 1));
