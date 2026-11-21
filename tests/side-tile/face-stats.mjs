// The side-tile trial's face numbers (no AI call, docs/side-tile-20261121.md): per wall and floor of a
// drawn scene (tests/fixture-haze/scenes.ts output: capture.png, mask.png, regions.json), its mean L*,
// a*, b*, chroma and L* percentiles. With --check, fails unless every wall's chroma is at least 85%
// of the most saturated wall's and their mean L* lie within 8 (the same tile reads as one).
//
//   node tests/side-tile/face-stats.mjs [--check] <scene dir> [...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const lin = (v) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
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
const check = process.argv.includes('--check');
let failed = false;
for (const dir of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')).regions;
  const cap = await sharp(join(dir, 'capture.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(join(dir, 'mask.png'))
    .extractChannel(0)
    .resize(cap.info.width, cap.info.height, { kernel: 'nearest' })
    .raw()
    .toBuffer();
  const faces = new Map();
  for (let i = 0; i < mask.length; i++) {
    const k = mask[i];
    if (!k || k === 255) continue;
    const L = lab(cap.data[i * 3], cap.data[i * 3 + 1], cap.data[i * 3 + 2]);
    let a = faces.get(k);
    if (!a) faces.set(k, (a = { n: 0, s: [0, 0, 0], Ls: [] }));
    a.n++;
    for (let c = 0; c < 3; c++) a.s[c] += L[c];
    a.Ls.push(L[0]);
  }
  console.log(dir);
  const walls = [];
  for (const [k, a] of [...faces].sort((x, y) => x[0] - y[0])) {
    a.Ls.sort((x, y) => x - y);
    const q = (p) => a.Ls[Math.floor(p * (a.Ls.length - 1))].toFixed(0);
    const [L, A, B] = a.s.map((v) => v / a.n);
    const kind = regions[k - 1]?.kind ?? '?';
    if (kind === 'wall') walls.push({ L, C: Math.hypot(A, B) });
    console.log(
      `  #${k} ${kind} L ${L.toFixed(1)} a ${A.toFixed(1)} b ${B.toFixed(1)} C ${Math.hypot(A, B).toFixed(1)}  p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)}`,
    );
  }
  if (check && walls.length > 1) {
    const maxC = Math.max(...walls.map((w) => w.C)),
      Ls = walls.map((w) => w.L);
    const ok = walls.every((w) => maxC < 2 || w.C >= 0.85 * maxC) && Math.max(...Ls) - Math.min(...Ls) <= 8;
    console.log(ok ? '  ok' : '  FAIL: the walls do not read as one tile');
    if (!ok) failed = true;
  }
}
if (failed) process.exit(1);
