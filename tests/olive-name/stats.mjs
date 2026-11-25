// Item 5's wall numbers (no AI call): over each scene's wall pixels (the capture's mask and regions,
// scaled to the answer), the mean CIELAB L*, chroma C* and hue angle h of the app picture (capture.png)
// and of the model's raw answer under each sentence (prepare.mjs), and of the app's finished result where refine.ts made it. Olive #6a6b51 sits near h 100°; a
// grey stone answer keeps L* but loses C*.
//   node tests/olive-name/stats.mjs [--cf | --alt | --dark]
// Output: test-results/olive-name-20261124/stats.json (--cf: olive-name-cf-20261124) and a table on stdout
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, SENTENCES } from './prepare.mjs';
import { CF_OUT } from './reuse.mjs';
import { ALT_OUT, ALTERNATIVES } from './alt.mjs';
import { DARK_OUT } from './dark-setup.mjs';

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
  let n = 0,
    bright = 0;
  for (let i = 0; i < mask.length; i++) {
    const k = mask[i];
    if (!k || k === 255 || regions[k - 1]?.kind !== 'wall') continue;
    const L = lab(pic.data[i * 3], pic.data[i * 3 + 1], pic.data[i * 3 + 2]);
    for (let c = 0; c < 3; c++) s[c] += L[c];
    if (L[0] > 92) bright++;
    n++;
  }
  const [L, A, B] = s.map((v) => v / n);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  // bright: the share of wall pixels above L* 92 (reflections and glare; light grout is about 84), in percent.
  return {
    L: +L.toFixed(1),
    C: +Math.hypot(A, B).toFixed(1),
    h: Math.round(h),
    bright: +((100 * bright) / n).toFixed(2),
  };
}
// --cf: the step-29 Cloudflare tree (reuse.mjs, cloud.ts), today's prompt (cur) and the app's (n2) only.
// --alt: the step-30 local alternatives (alt.mjs), with the bath front's patchiness.
const cf = process.argv.includes('--cf');
const alt = process.argv.includes('--alt');
// --dark: the step-31 Cloudflare tree (dark-setup.mjs): main, "olive" and the app's "dark olive".
const dark = process.argv.includes('--dark');
const TREE = cf ? CF_OUT : alt ? ALT_OUT : dark ? DARK_OUT : OUT;
/**
 * The bath front (step 30): the lower 60% of the bath's box (the rim left out), mapped like the pairs.
 * spread: the L* standard deviation; bright: % above L* 92 (reflections); patch: % more than 12 L* below
 * the front's median (dark shading patches). Undefined in a scene without a bath.
 */
async function bathFront(image, dir) {
  const grounding = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8'));
  const bath = grounding.scene.fixtures.find((f) => f.kind === 'bath');
  if (!bath) return undefined;
  const layout = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')).layout;
  const pic = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = pic.info;
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * W),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * H),
  ];
  const [l, t, r, b] = bath.box;
  const [x0, y0] = px(l + 0.01, t + 0.4 * (b - t));
  const [x1, y1] = px(r - 0.01, b - 0.01);
  const Ls = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      Ls.push(lab(pic.data[i], pic.data[i + 1], pic.data[i + 2])[0]);
    }
  const mean = Ls.reduce((a, v) => a + v, 0) / Ls.length;
  const spread = Math.sqrt(Ls.reduce((a, v) => a + (v - mean) ** 2, 0) / Ls.length);
  const median = [...Ls].sort((a, b) => a - b)[Ls.length >> 1];
  const share = (f) => +((100 * Ls.filter(f).length) / Ls.length).toFixed(2);
  return { spread: +spread.toFixed(1), bright: share((v) => v > 92), patch: share((v) => v < median - 12) };
}
const rows = {};
const revs = cf
  ? ['cur', 'n2']
  : alt
    ? Object.keys(ALTERNATIVES)
    : dark
      ? ['cur', 'n2', 'a1']
      : Object.keys(SENTENCES);
const ids = readdirSync(join(TREE, 'cur', 'raw'))
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.slice(0, -4))
  .sort();
console.log('scene-seed'.padEnd(26), 'app', ...revs.map((r) => r.padEnd(18)));
for (const id of ids) {
  const scene = id.replace(/-\d+$/, '');
  const dir = join(TREE, 'cur', 'scenes', scene);
  const row = { app: await wallColour(join(dir, 'capture.png'), dir) };
  for (const rev of revs) row[rev] = await wallColour(join(TREE, rev, 'raw', `${id}.png`), dir);
  // The app's finished result (refine.ts), where it was made.
  for (const rev of revs) {
    const file = join(TREE, rev, 'refined', `${id}.png`);
    if (existsSync(file)) row[`${rev}/refined`] = await wallColour(file, dir);
  }
  if (alt || dark)
    for (const rev of revs)
      for (const [stage, sub] of [
        ['raw', ''],
        ['refined', '/refined'],
      ]) {
        const front = await bathFront(join(TREE, rev, stage, `${id}.png`), dir);
        if (front) row[`${rev}${sub}`].front = front;
      }
  rows[id] = row;
  const cell = (c) => `L${c.L} C${c.C} h${c.h} b${c.bright}`.padEnd(24);
  console.log(id.padEnd(26), cell(row.app), ...revs.map((r) => cell(row[r])));
}
const mean = (rev, key) => +(ids.reduce((a, id) => a + rows[id][rev][key], 0) / ids.length).toFixed(1);
const keys = Object.keys(rows[ids[0]]).filter((k) => ids.every((id) => rows[id][k]));
const summary = Object.fromEntries(
  keys.map((r) => [r, { L: mean(r, 'L'), C: mean(r, 'C'), bright: mean(r, 'bright') }]),
);
console.log('mean', JSON.stringify(summary));
writeFileSync(join(TREE, 'stats.json'), JSON.stringify({ rows, summary }, null, 1));
