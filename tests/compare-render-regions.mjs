/**
 * Compares a render capture folder with its baseline when tile pixels may change but nothing else
 * may (docs/tile-mipmap-results-20261105.md). compare-render-baseline.mjs stays as it is. Here an
 * image with a `<name>-mask.png` beside it (face labels: 0 none, 1–254 a tiled surface, 255 a
 * fixture) is split by that mask:
 *  - outside the tiled surfaces, grown by --grow pixels (default 2, for the mask's soft edge and
 *    antialiased borders), every pixel must be identical;
 *  - inside, the mean and largest difference and the face mean's ΔE2000 are reported.
 * Images without a mask are reported only.
 * Usage: node tests/compare-render-regions.mjs <baselineDir> <dir> [--grow N]
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const growAt = args.indexOf('--grow');
const grow = growAt >= 0 ? Number(args[growAt + 1]) : 2;
const [baselineDir, dir] = args.filter((arg, i) => !arg.startsWith('--') && (growAt < 0 || i !== growAt + 1));
if (!baselineDir || !dir || !Number.isInteger(grow) || grow < 0)
  throw new Error('usage: compare-render-regions.mjs <baselineDir> <dir> [--grow N]');

const raw = async (file, channels = 3) => {
  const image = sharp(file);
  const { data, info } = await (channels === 1 ? image.extractChannel(0) : image.removeAlpha())
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lab = (rgb) => {
  const [r, g, b] = rgb.map(linear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
/** CIEDE2000 on sRGB 8-bit colours, as tests/helpers/delta-e.ts. */
const deltaE2000 = (p, q) => {
  const [L1, a1, b1] = lab(p),
    [L2, a2, b2] = lab(q);
  const rad = Math.PI / 180;
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1,
    a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1),
    C2p = Math.hypot(a2p, b2);
  const hue = (b, a) => {
    const v = Math.atan2(b, a) / rad;
    return v < 0 ? v + 360 : v;
  };
  const h1p = hue(b1, a1p),
    h2p = hue(b2, a2p);
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dLp = L2 - L1,
    dCp = C2p - C1p,
    dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lm = (L1 + L2) / 2,
    Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (C1p * C2p !== 0)
    hm = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2),
    Sc = 1 + 0.045 * Cmp,
    Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
};
/** Mean colour over a mask, averaged in linear light. */
const meanRgb = (image, mask) => {
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      for (let c = 0; c < 3; c++) sum[c] += linear(image.data[i * 3 + c]);
      n++;
    }
  return sum.map((s) => {
    const v = s / Math.max(1, n);
    return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  });
};

let failed = 0;
const rows = [];
for (const file of readdirSync(baselineDir)
  .filter((f) => /\.(png|jpe?g)$/.test(f) && !f.endsWith('-mask.png'))
  .sort()) {
  const other = join(dir, file);
  if (!existsSync(other)) {
    rows.push({ file, result: 'missing' });
    failed++;
    continue;
  }
  const a = await raw(join(baselineDir, file));
  const b = await raw(other);
  if (a.width !== b.width || a.height !== b.height) {
    rows.push({ file, result: 'size' });
    failed++;
    continue;
  }
  const maskFile = join(dir, file.replace(/\.(png|jpe?g)$/, '-mask.png'));
  const labels = existsSync(maskFile) ? await raw(maskFile, 1) : undefined;
  const pixels = a.width * a.height;
  const tiles = new Uint8Array(pixels);
  if (labels) {
    if (labels.width !== a.width || labels.height !== a.height) throw new Error(`${maskFile}: size`);
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        const label = labels.data[y * a.width + x];
        if (label === 0 || label === 255) continue;
        for (let dy = -grow; dy <= grow; dy++)
          for (let dx = -grow; dx <= grow; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < a.width && yy < a.height) tiles[yy * a.width + xx] = 1;
          }
      }
  }
  let outsideChanged = 0,
    outsideMax = 0,
    insideSum = 0,
    insideCount = 0,
    insideMax = 0;
  for (let i = 0; i < pixels; i++) {
    let diff = 0;
    for (let c = 0; c < 3; c++) diff = Math.max(diff, Math.abs(a.data[i * 3 + c] - b.data[i * 3 + c]));
    if (labels && tiles[i]) {
      insideSum += diff;
      insideCount++;
      insideMax = Math.max(insideMax, diff);
    } else if (diff) {
      outsideChanged++;
      outsideMax = Math.max(outsideMax, diff);
    }
  }
  const faces = labels ? Uint8Array.from(labels.data, (l) => (l > 0 && l < 255 ? 1 : 0)) : undefined;
  const faceDeltaE = faces ? deltaE2000(meanRgb(a, faces), meanRgb(b, faces)) : undefined;
  const ok = !labels || outsideChanged === 0;
  if (!ok) failed++;
  rows.push({
    file,
    result: labels ? (ok ? 'ok' : 'FAIL') : 'report',
    outsideChanged,
    outsideMax,
    insideMean: insideCount ? Number((insideSum / insideCount).toFixed(2)) : undefined,
    insideMax,
    faceDeltaE: faceDeltaE === undefined ? undefined : Number(faceDeltaE.toFixed(2)),
  });
}
console.table(rows);
if (failed) {
  console.error(`${failed} image(s) changed outside the tile faces, or are missing or resized`);
  process.exit(1);
}
