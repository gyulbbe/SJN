// Backlog item 5: blind pairs of the model's raw answers (local FLUX klein 4B, no refine) under two olive
// wall sentences (prepare.mjs), the same scene, input and seed on both sides. Every scene (two walls'
// views of the registered toilet, the bath at 0° and 90°, two basins) once in each comparison, the seeds
// alternating, so each scene shows both seeds (step 28, 12 pairs, the supervisor's limit):
//   - n2 "olive" against today's "grey": seed 424242 on even scenes, 777001 on odd ones (6);
//   - n1 "olive grey" against n2 "olive": the other seed (6).
// With --step 27: the first set of 18 pairs (n2 against today at both seeds, 12, and the same 6 n1 pairs).
// Each pair-NN.png: the app picture (설계) on the left, A and B beside it, and below them the middle of
// the back wall of all three enlarged (colour, grout pattern, reflections).
// Usage: node tests/olive-name/pairs.mjs [--step 28] [--seed 20261127]
// Output: docs/plans/pictures/5/blind-step-<step>/pair-NN.png, key.json
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { OUT } from './prepare.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261127;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const stepAt = process.argv.indexOf('--step');
const step = stepAt > 0 ? process.argv[stepAt + 1] : '28';
const dir = join(ROOT, 'docs', 'plans', 'pictures', '5', `blind-step-${step}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const SCENES = [
  'olive-0',
  'olive-90',
  'bath-olive-0',
  'bath-olive-90',
  'basin-ped-olive-0',
  'basin-thin-olive-0',
];
const NAMES = { cur: 'today "grey"', n1: 'n1 "olive grey"', n2: 'n2 "olive"' };
const seedOf = (i, other = false) => ((i % 2 === 1) !== other ? 777001 : 424242);
const pairs =
  step === '27'
    ? [
        ...SCENES.flatMap((s) => [424242, 777001].map((seed) => ({ id: `${s}-${seed}`, x: 'n2', y: 'cur' }))),
        ...SCENES.map((s, i) => ({ id: `${s}-${seedOf(i)}`, x: 'n1', y: 'n2' })),
      ]
    : [
        ...SCENES.map((s, i) => ({ id: `${s}-${seedOf(i)}`, x: 'n2', y: 'cur' })),
        ...SCENES.map((s, i) => ({ id: `${s}-${seedOf(i, true)}`, x: 'n1', y: 'n2' })),
      ];
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
  const scene = pair.id.replace(/-\d+$/, '');
  const sceneDir = join(OUT, 'cur', 'scenes', scene);
  const [l, r] = random() < 0.5 ? [pair.x, pair.y] : [pair.y, pair.x];
  const files = [
    join(sceneDir, 'capture.png'),
    join(OUT, l, 'raw', `${pair.id}.png`),
    join(OUT, r, 'raw', `${pair.id}.png`),
  ];
  // The back wall's middle: the content box of the capture's layout, x 30–70%, y 12–45%.
  const layout = JSON.parse(readFileSync(join(sceneDir, 'layout.json'), 'utf8')).layout;
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * AW),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * AH),
  ];
  const [x0, y0] = px(0.3, 0.12);
  const [x1, y1] = px(0.7, 0.45);
  const at = (f) => sharp(f).removeAlpha().resize(AW, AH, { fit: 'fill' }).png().toBuffer();
  const full = await Promise.all(
    files.map(async (f) =>
      sharp(await at(f))
        .resize({ width: W })
        .png()
        .toBuffer(),
    ),
  );
  const zoom = await Promise.all(
    files.map(async (f) =>
      sharp(await at(f))
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .resize({ width: W })
        .png()
        .toBuffer({ resolveWithObject: true }),
    ),
  );
  const h = Math.round((W * AH) / AW),
    zh = zoom[0].info.height;
  const composite = [];
  ['설계(앱 그림)', 'A', 'B'].forEach((label, i) => {
    const left = i * (W + GAP);
    composite.push({ input: text(label), left, top: 0 });
    composite.push({ input: full[i], left, top: LABEL });
    composite.push({ input: zoom[i].data, left, top: LABEL + h + GAP });
  });
  await sharp({
    create: { width: 3 * W + 2 * GAP, height: LABEL + h + GAP + zh, channels: 3, background: '#ffffff' },
  })
    .composite(composite)
    .png()
    .toFile(join(dir, `${name}.png`));
  key[name] = { id: pair.id, A: NAMES[l], B: NAMES[r], files: { A: files[1], B: files[2] } };
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
console.log(pairs.length, 'pairs in', dir);
