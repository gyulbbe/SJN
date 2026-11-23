// Backlog item 3, step 13: blind pairs of the editor's 3D view (tests/side-tile-ai/capture.ts
// editor-3d.png): today's main against the candidates where the ceiling light's highlight on walls is
// spread (r50, r35: the direct light sees a rougher wall). Each pair-NN.png: A and B full views, and under
// them the top of the back wall enlarged. Which is which only in key.json.
// Usage: node tests/editor-glare/pairs.mjs [--seed 20261127]
// Output: docs/plans/pictures/3/blind-step-13/pair-NN.png, key.json
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT as TRIAL, ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261127;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '3', 'blind-step-13');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const file = (rev, scene) => join(TRIAL, rev, 'scenes', scene, 'editor-3d.png');
const pairs = [];
for (const y of ['r50', 'r35'])
  for (const scene of ['olive-0', 'black-0', 'beige-90', 'white-0']) pairs.push({ scene, x: 'app', y });
for (let i = pairs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
}
const W = 720,
  GAP = 16,
  LABEL = 40;
const text = (s, size = 28, width = W) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}"><text x="4" y="${size}" font-family="Malgun Gothic, sans-serif" font-size="${size}" font-weight="700" fill="#111">${s}</text></svg>`,
  );
const label = {
  app: 'today e86f980',
  r50: 'r50 direct-light roughness ≥ 0.5',
  r35: 'r35 direct-light roughness ≥ 0.35',
};
const key = {};
for (const [n, pair] of pairs.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const [l, r] = random() < 0.5 ? [pair.x, pair.y] : [pair.y, pair.x];
  for (const rev of [l, r])
    if (!existsSync(file(rev, pair.scene))) throw new Error(`no ${file(rev, pair.scene)}`);
  const full = (rev) =>
    sharp(file(rev, pair.scene)).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
  // The top of the back wall, where the ceiling light's spot sits (editor view 1200 × 800).
  const zoom = (rev) =>
    sharp(file(rev, pair.scene))
      .extract({ left: 400, top: 200, width: 400, height: 225 })
      .resize({ width: W })
      .png()
      .toBuffer({ resolveWithObject: true });
  const [a, b, za, zb] = await Promise.all([full(l), full(r), zoom(l), zoom(r)]);
  const h = a.info.height,
    zh = za.info.height;
  await sharp({
    create: { width: 2 * W + GAP, height: 3 * LABEL + h + zh + GAP, channels: 3, background: '#ffffff' },
  })
    .composite([
      { input: text(name, 24, 2 * W + GAP), left: 0, top: 0 },
      { input: text('A'), left: 0, top: LABEL },
      { input: text('B'), left: W + GAP, top: LABEL },
      { input: a.data, left: 0, top: 2 * LABEL },
      { input: b.data, left: W + GAP, top: 2 * LABEL },
      { input: text('A · 뒷벽 위 확대', 22), left: 0, top: 2 * LABEL + h + GAP },
      { input: text('B · 뒷벽 위 확대', 22), left: W + GAP, top: 2 * LABEL + h + GAP },
      { input: za.data, left: 0, top: 3 * LABEL + h + GAP },
      { input: zb.data, left: W + GAP, top: 3 * LABEL + h + GAP },
    ])
    .png()
    .toFile(join(dir, `${name}.png`));
  key[name] = {
    scene: pair.scene,
    A: label[l],
    B: label[r],
    files: { A: file(l, pair.scene), B: file(r, pair.scene) },
  };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
