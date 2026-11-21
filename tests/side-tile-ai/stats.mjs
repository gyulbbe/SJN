// The side-tile AI trial's face numbers (no AI call): per wall of each scene, mean L* and chroma of the
// input (capture), the model's answer with the backdrop back (original) and the finished result
// (refined), for both revisions, with tests/side-tile/face-stats.mjs's check (every wall's chroma at
// least 85% of the most saturated wall's, mean L* within 8). The region mask is the capture's, scaled
// to the answer (all answers kept the framing, refine.json `aligned`).
//
//   node tests/side-tile-ai/stats.mjs
// Output: test-results/side-tile-ai-20261121/stats.json and a table on stdout
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, REVISIONS } from './paths.mjs';

const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const lab = (r, g, b) => {
  const R = lin(r),
    G = lin(g),
    B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B,
    Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
async function walls(image, dir) {
  const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')).regions;
  const cap = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(join(dir, 'mask.png'))
    .extractChannel(0)
    .resize(cap.info.width, cap.info.height, { kernel: 'nearest' })
    .raw()
    .toBuffer();
  const faces = new Map();
  for (let i = 0; i < mask.length; i++) {
    const k = mask[i];
    if (!k || k === 255 || regions[k - 1]?.kind !== 'wall') continue;
    const L = lab(cap.data[i * 3], cap.data[i * 3 + 1], cap.data[i * 3 + 2]);
    const a = faces.get(k) ?? { n: 0, s: [0, 0, 0] };
    a.n++;
    for (let c = 0; c < 3; c++) a.s[c] += L[c];
    faces.set(k, a);
  }
  const out = [...faces]
    .sort((x, y) => x[0] - y[0])
    .map(([k, a]) => {
      const [L, A, B] = a.s.map((v) => v / a.n);
      return { face: regions[k - 1].key, L: +L.toFixed(1), C: +Math.hypot(A, B).toFixed(1) };
    });
  const maxC = Math.max(...out.map((w) => w.C)),
    Ls = out.map((w) => w.L);
  const ok = out.every((w) => maxC < 2 || w.C >= 0.85 * maxC) && Math.max(...Ls) - Math.min(...Ls) <= 8;
  return { walls: out, ok };
}
const rows = {};
const ids = readdirSync(join(OUT, 'before', 'refined'))
  .map((f) => f.slice(0, -4))
  .sort();
for (const id of ids) {
  const scene = id.replace(/-\d+$/, '');
  for (const rev of Object.keys(REVISIONS)) {
    const dir = join(OUT, rev, 'scenes', scene);
    for (const [kind, file] of [
      ['input', join(dir, 'capture.png')],
      ['original', join(OUT, rev, 'original', `${id}.png`)],
      ['refined', join(OUT, rev, 'refined', `${id}.png`)],
    ]) {
      const r = await walls(file, dir);
      rows[`${id}/${rev}/${kind}`] = r;
      console.log(
        `${id.padEnd(16)} ${rev.padEnd(6)} ${kind.padEnd(8)} ${r.walls
          .map((w) => `L ${w.L} C ${w.C}`)
          .join(' | ')
          .padEnd(56)} ${r.ok ? 'ok' : 'FAIL'}`,
      );
    }
  }
}
writeFileSync(join(OUT, 'stats.json'), JSON.stringify(rows, null, 1));
