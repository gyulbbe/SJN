// Backlog item 6, step 19 (Cloudflare check): blind pairs of today's refine against the app (F2: the
// moved boxes only where no box holds a render fixture pixel, and bath pieces the wall's colour) on the
// same Cloudflare answer (tests/big-fixture/cloud.ts, refine.ts --suffix today/app). Full pictures and
// the fixtures with the wall above enlarged; key.json only says which is which.
// Usage: node tests/big-fixture/pairs-cloud.mjs [--seed 20261127]
// Output: docs/plans/pictures/6/blind-step-19/pair-NN.png, key.json
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261127;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '6', 'blind-step-19');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const CFB = join(ROOT, 'test-results', 'big-fixture-20261124', 'cf', 'app');
const pairs = [
  'bath-olive-0-424242',
  'bath-beige-0-424242',
  'bath-white-90-424242',
  'bath-white-0-424242',
].map((id) => ({ root: CFB, id, kind: 'Cloudflare big' }));
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
const key = {};
for (const [n, pair] of pairs.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const scene = pair.id.replace(/-\d+$/, '');
  const today = 'refined-today';
  const file = (d) => join(pair.root, d, `${pair.id}.png`);
  const [l, r] = random() < 0.5 ? [today, 'refined-app'] : ['refined-app', today];
  for (const d of [l, r]) if (!existsSync(file(d))) throw new Error(`no ${file(d)}`);
  const sceneDir = join(pair.root, 'scenes', scene);
  const grounding = JSON.parse(readFileSync(join(sceneDir, 'grounding.json'), 'utf8'));
  const layout = JSON.parse(readFileSync(join(sceneDir, 'layout.json'), 'utf8')).layout;
  const boxes = grounding.scene.fixtures.filter((f) => f.box).map((f) => f.box);
  const u = [0, 1, 2, 3].map((k) => (k < 2 ? Math.min : Math.max)(...boxes.map((b) => b[k])));
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
      { input: text('A · 제품과 그 위 벽 확대', 22), left: 0, top: 2 * LABEL + h + GAP },
      { input: text('B · 제품과 그 위 벽 확대', 22), left: W + GAP, top: 2 * LABEL + h + GAP },
      { input: za.data, left: 0, top: 3 * LABEL + h + GAP },
      { input: zb.data, left: W + GAP, top: 3 * LABEL + h + GAP },
    ])
    .png()
    .toFile(join(dir, `${name}.png`));
  const label = (d) => (d === 'refined-app' ? 'app F2' : 'today');
  key[name] = { id: pair.id, scenes: pair.kind, A: label(l), B: label(r), files: { A: file(l), B: file(r) } };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
