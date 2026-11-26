// Backlog item 8, step 50: blind pairs of the app's finished results (no AI call, the same saved answer on
// both sides) under today's refine and the trial "k3" (refine.ts --tuning '{"carried":{"detached":{"near":3,
// "min":200,"side":6},"side":false}}' --suffix k3: a piece of a used cut-out of at least 200 px, 6 px both
// ways, with no pixel within 3 px of the render's fixture, leaves the cut-out — a toilet brush standing
// beside the toilet). The one picture k3 changes of 95, and normal scenes (k3 changes nothing there).
// Each pair-NN.png: the design, A and B; below, the fixture with the floor and wall around it enlarged.
// Usage: node tests/extra-objects/pairs.mjs [--seed 20261150]
// Output: docs/plans/pictures/8/blind-step-50/pair-NN.png, key.json
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261150;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '8', 'blind-step-50');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
// [tree, today's folder, answer id, fixture index to enlarge, case]
const CASES = [
  ['side-tile-ai-20261121/after', 'refined-app45', 'white-0-424242', 0, 'changed'],
  ['big-fixture-20261124/app', 'refined-app45', 'bath-white-0-424242', 0, 'normal'],
  ['basin-shape-20261124/app', 'refined-app45', 'basin-ped-white-0-424242', 0, 'normal'],
  ['extra-objects-20261126/local/app', 'refined-base', 'tank-white-0-101', 0, 'normal'],
  ['photo-colour-20261126/cur', 'refined-app45', 'shower-white-0-424242', 0, 'normal'],
  ['cutout-held-20261126/app', 'refined-new46', 'side-beige-90-424242', 0, 'normal'],
];
const pairs = CASES.map(([tree, base, id, fixture, why]) => ({ tree, base, id, fixture, why }));
for (let i = pairs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
}
const W = 620,
  GAP = 12,
  LABEL = 40,
  AW = 992,
  AH = 672;
const text = (s) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LABEL}"><text x="4" y="29" font-family="Malgun Gothic, sans-serif" font-size="28" font-weight="700" fill="#111">${s}</text></svg>`,
  );
const key = {};
for (const [n, pair] of pairs.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const root = join(ROOT, 'test-results', ...pair.tree.split('/'));
  const sceneDir = join(root, 'scenes', pair.id.replace(/-\d+$/, ''));
  const [l, r] = random() < 0.5 ? [pair.base, 'refined-k3'] : ['refined-k3', pair.base];
  const files = [
    join(sceneDir, 'capture.png'),
    join(root, l, `${pair.id}.png`),
    join(root, r, `${pair.id}.png`),
  ];
  const layout = JSON.parse(readFileSync(join(sceneDir, 'layout.json'), 'utf8')).layout;
  const box = JSON.parse(readFileSync(join(sceneDir, 'grounding.json'), 'utf8')).scene.fixtures[pair.fixture]
    .box;
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * AW),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * AH),
  ];
  const [x0, y0] = px(Math.max(0, box[0] - 0.12), Math.max(0, box[1] - 0.06));
  const [x1, y1] = px(Math.min(1, box[2] + 0.12), Math.min(1, box[3] + 0.06));
  const pics = await Promise.all(
    files.map((f) => sharp(f).removeAlpha().resize(AW, AH, { fit: 'fill' }).png().toBuffer()),
  );
  const h = Math.round((W * AH) / AW);
  const zh = Math.min(560, Math.round((W * (y1 - y0)) / (x1 - x0)));
  const full = await Promise.all(pics.map((p) => sharp(p).resize(W, h).png().toBuffer()));
  const zoom = await Promise.all(
    pics.map((p) =>
      sharp(p)
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .resize(W, zh, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
        .png()
        .toBuffer(),
    ),
  );
  const composite = [];
  ['설계(앱 그림)', 'A', 'B'].forEach((label, i) => {
    const left = i * (W + GAP);
    composite.push({ input: text(label), left, top: 0 });
    composite.push({ input: full[i], left, top: LABEL });
    composite.push({ input: zoom[i], left, top: LABEL + h + GAP });
  });
  await sharp({
    create: { width: 3 * W + 2 * GAP, height: LABEL + h + GAP + zh, channels: 3, background: '#ffffff' },
  })
    .composite(composite)
    .png()
    .toFile(join(dir, `${name}.png`));
  const name2 = (f) => (f === 'refined-k3' ? 'k3 (detached cut-out pieces off)' : 'today');
  key[name] = {
    id: pair.id,
    tree: pair.tree,
    case: pair.why,
    A: name2(l),
    B: name2(r),
    files: { A: files[1], B: files[2] },
  };
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
console.log(pairs.length, 'pairs in', dir);
