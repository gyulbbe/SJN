// Backlog item 10, step 43: blind pairs of the app's finished results (no AI call, the same saved answer
// on both sides) under today's refine (refine.ts --suffix h43) and the trial outline step "c12m5"
// (refine.ts --tuning '{"clipCuts":12,"minIou":0.5}' --suffix c12m5: each cut-out clipped to 12 px around
// the render's own fixture before it is scored, used from overlap 0.5): the 9 ceramics whose cut-out the
// trial uses where today keeps the render's outline, and 3 that both use (controls).
// Each pair-NN.png: the design (app picture), A and B; below, the fixture with the wall around it enlarged
// in all three.
// With --step 44: today against g1 (refine.ts --tuning '{"clipCuts":12,"minIou":0.5,"rescueGuard":{"recall":0.75,
// "top":0.5,"ratio":2.5}}' --suffix g1: only a cut-out failing 0.6 as it is gets clipped, and is used only if
// it covers 75% of the render's fixture and half its top quarter, at most 2.5 times its area): the 6
// pictures g1 changes, the 4 step 43 lost (now as today), and 2 controls.
// Usage: node tests/cutout-haze/pairs.mjs [--step 44] [--seed 20261143]
// Output: docs/plans/pictures/10/blind-step-<step>/pair-NN.png, key.json
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
const stepAt = process.argv.indexOf('--step');
const step = stepAt > 0 ? process.argv[stepAt + 1] : '43';
const trial = step === '44' ? 'refined-g1' : 'refined-c12m5';
let state = at > 0 ? Number(process.argv[at + 1]) : 20261100 + Number(step);
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '10', `blind-step-${step}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const T = (p) => join(ROOT, 'test-results', ...p.split('/'));
// [tree, answer id, fixture index, why]
const CASES44 = [
  ['big-fixture-20261124/app', 'bath-olive-90-424242', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-olive-90-777001', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-white-90-424242', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-white-90-777001', 0, 'changed'],
  ['olive-dark-cf-20261125/cur', 'bath-olive-90-424242', 0, 'changed'],
  ['side-tile-ai-20261121/after', 'olive-90-424242', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-white-0-424242', 0, 'step-43 loss'],
  ['photo-colour-20261126/cur', 'shower-white-0-424242', 0, 'step-43 loss'],
  ['photo-colour-20261126/cur', 'shower-white-0-777001', 0, 'step-43 loss'],
  ['basin-shape-20261124/app', 'basin-thin-olive-0-777001', 0, 'step-43 loss'],
  ['side-tile-ai-20261121/after', 'white-0-424242', 0, 'control'],
  ['olive-dark-cf-20261125/cur', 'bath-olive-0-424242', 1, 'control'],
];
const CASES43 = [
  ['basin-shape-20261124/app', 'basin-thin-olive-0-777001', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-olive-90-424242', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-olive-90-777001', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-white-90-424242', 0, 'changed'],
  ['big-fixture-20261124/app', 'bath-white-90-777001', 0, 'changed'],
  ['olive-dark-cf-20261125/cur', 'bath-olive-90-424242', 0, 'changed'],
  ['photo-colour-20261126/cur', 'shower-white-0-424242', 0, 'changed'],
  ['photo-colour-20261126/cur', 'shower-white-0-777001', 0, 'changed'],
  ['side-tile-ai-20261121/after', 'olive-90-424242', 0, 'changed'],
  ['side-tile-ai-20261121/after', 'white-0-424242', 0, 'control'],
  ['olive-dark-cf-20261125/cur', 'bath-olive-0-424242', 1, 'control'],
  ['big-fixture-20261124/app', 'bath-white-0-424242', 0, 'control'],
];
const pairs = (step === '44' ? CASES44 : CASES43).map(([tree, id, fixture, why]) => ({
  tree,
  id,
  fixture,
  why,
}));
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
const NAMES = {
  'refined-h43': 'today',
  'refined-c12m5': 'c12m5 (clip 12 px, overlap 0.5)',
  'refined-g1': 'g1 (rescue only failing cut-outs, guarded)',
};
const key = {};
for (const [n, pair] of pairs.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const root = T(pair.tree);
  const scene = pair.id.replace(/-\d+$/, '');
  const sceneDir = join(root, 'scenes', scene);
  const [l, r] = random() < 0.5 ? ['refined-h43', trial] : [trial, 'refined-h43'];
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
  const [x0, y0] = px(Math.max(0, box[0] - 0.05), Math.max(0, box[1] - 0.05));
  const [x1, y1] = px(Math.min(1, box[2] + 0.05), Math.min(1, box[3] + 0.04));
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
  key[name] = {
    id: pair.id,
    tree: pair.tree,
    fixture: pair.fixture,
    case: pair.why,
    A: NAMES[l],
    B: NAMES[r],
    files: { A: files[1], B: files[2] },
  };
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
console.log(pairs.length, 'pairs in', dir);
