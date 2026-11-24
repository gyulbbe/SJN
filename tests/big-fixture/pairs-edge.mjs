// Backlog item 6, step 17: blind pairs of the big-fixture scenes where an edge candidate changes the
// finished picture: today's refine against E1 (the fixtures' boxes moved by the model's shift where they
// meet the shifted render mask) and E2 (E1 + a bath piece within 70 of the model's wall colour is wall).
// Each pair-NN.png: A and B full pictures, and the bath with the wall above it enlarged. key.json only
// says which is which.
// Usage: SIDE_TILE_OUT=test-results/big-fixture-20261124 node tests/big-fixture/pairs-edge.mjs [--seed 20261125]
// Output: docs/plans/pictures/6/blind-step-17/pair-NN.png, key.json
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261125;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '6', 'blind-step-17');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const pairs = [
  ...[
    'bath-olive-0-424242',
    'bath-olive-0-777001',
    'bath-beige-0-424242',
    'bath-black-0-424242',
    'bath-black-0-777001',
    'bath-white-0-424242',
    'bath-olive-90-424242',
    'bath-white-90-424242',
  ].map((id) => ({ id, x: 'refined', y: 'refined-e2' })),
  ...['bath-olive-0-424242', 'bath-white-0-424242', 'bath-olive-90-424242', 'bath-white-90-424242'].map(
    (id) => ({ id, x: 'refined', y: 'refined-e1' }),
  ),
];
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
  refined: 'today',
  'refined-e1': 'E1 boxes moved',
  'refined-e2': 'E2 boxes moved + wall-like bath pieces',
};
const key = {};
for (const [n, pair] of pairs.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const scene = pair.id.replace(/-\d+$/, '');
  const file = (d) => join(OUT, 'app', d, `${pair.id}.png`);
  const [l, r] = random() < 0.5 ? [pair.x, pair.y] : [pair.y, pair.x];
  for (const d of [l, r]) if (!existsSync(file(d))) throw new Error(`no ${file(d)}`);
  const sceneDir = join(OUT, 'app', 'scenes', scene);
  const grounding = JSON.parse(readFileSync(join(sceneDir, 'grounding.json'), 'utf8'));
  const layout = JSON.parse(readFileSync(join(sceneDir, 'layout.json'), 'utf8')).layout;
  // The fixtures' union box (the bath, and the toilet in front of it at 90°), with the wall above.
  const boxes = grounding.scene.fixtures.filter((f) => f.box).map((f) => f.box);
  const bath = grounding.scene.fixtures.find((f) => f.kind === 'bath').box;
  const u = scene.endsWith('-90')
    ? [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ]
    : bath;
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * 992),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * 672),
  ];
  const [x0, y0] = px(Math.max(0, u[0] - 0.03), Math.max(0, u[1] - 0.1));
  const [x1, y1] = px(Math.min(1, u[2] + 0.03), Math.min(1, u[3] + 0.02));
  const full = (d) => sharp(file(d)).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
  const zoom = (d) =>
    sharp(file(d))
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
      { input: text('A · 욕조와 그 위 벽 확대', 22), left: 0, top: 2 * LABEL + h + GAP },
      { input: text('B · 욕조와 그 위 벽 확대', 22), left: W + GAP, top: 2 * LABEL + h + GAP },
      { input: za.data, left: 0, top: 3 * LABEL + h + GAP },
      { input: zb.data, left: W + GAP, top: 3 * LABEL + h + GAP },
    ])
    .png()
    .toFile(join(dir, `${name}.png`));
  key[name] = { id: pair.id, A: label[l], B: label[r], files: { A: file(l), B: file(r) } };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
