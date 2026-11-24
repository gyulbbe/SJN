// Backlog item 6, step 16: does today's app still show light streaks or shadows over a big fixture?
// Blind pairs of the big-fixture scenes' front views (local FLUX, seeds 424242 and 777001): the model's
// answer with the backdrop back ("AI 원본", what "AI 원본 보기" shows) against the app's finished picture,
// each as the full picture and the bath enlarged (zoom-refined-<id>.png from streaks.mjs gives the crop
// box). Which is which only in key.json.
// Usage: SIDE_TILE_OUT=test-results/big-fixture-20261124 node tests/big-fixture/pairs.mjs [--seed 20261124]
// Output: docs/plans/pictures/6/blind-step-16/pair-NN.png, key.json
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261124;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '6', 'blind-step-16');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const ids = ['beige', 'black', 'olive', 'white'].flatMap((w) =>
  [424242, 777001].map((seed) => `bath-${w}-0-${seed}`),
);
for (let i = ids.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [ids[i], ids[j]] = [ids[j], ids[i]];
}
const W = 720,
  GAP = 16,
  LABEL = 40;
const text = (s, size = 28, width = W) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}"><text x="4" y="${size}" font-family="Malgun Gothic, sans-serif" font-size="${size}" font-weight="700" fill="#111">${s}</text></svg>`,
  );
const key = {};
for (const [n, id] of ids.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const scene = id.replace(/-\d+$/, '');
  const file = (kind) => join(OUT, 'app', kind, `${id}.png`);
  for (const kind of ['original', 'refined'])
    if (!existsSync(file(kind))) throw new Error(`no ${file(kind)}`);
  const [l, r] = random() < 0.5 ? ['original', 'refined'] : ['refined', 'original'];
  // The bath's box (grounding.json) with a margin, on the 992 × 672 result.
  const grounding = JSON.parse(readFileSync(join(OUT, 'app', 'scenes', scene, 'grounding.json'), 'utf8'));
  const layout = JSON.parse(readFileSync(join(OUT, 'app', 'scenes', scene, 'layout.json'), 'utf8')).layout;
  const [bx0, by0, bx1, by1] = grounding.scene.fixtures.find((f) => f.kind === 'bath').box;
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * 992),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * 672),
  ];
  const [x0, y0] = px(Math.max(0, bx0 - 0.04), Math.max(0, by0 - 0.04));
  const [x1, y1] = px(Math.min(1, bx1 + 0.04), Math.min(1, by1 + 0.04));
  const full = (kind) => sharp(file(kind)).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
  const zoom = (kind) =>
    sharp(file(kind))
      .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
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
      { input: text('A · 욕조 확대', 22), left: 0, top: 2 * LABEL + h + GAP },
      { input: text('B · 욕조 확대', 22), left: W + GAP, top: 2 * LABEL + h + GAP },
      { input: za.data, left: 0, top: 3 * LABEL + h + GAP },
      { input: zb.data, left: W + GAP, top: 3 * LABEL + h + GAP },
    ])
    .png()
    .toFile(join(dir, `${name}.png`));
  const label = { original: 'AI original (backdrop back)', refined: 'app final (today)' };
  key[name] = { id, A: label[l], B: label[r], files: { A: file(l), B: file(r) } };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
