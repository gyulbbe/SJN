// Backlog item 9, step 39: blind pairs of the shower sentences (variants.mjs) against today's, local FLUX
// answers, same input and seed: the model's answer ("AI 원본") for both scenes × both seeds × both
// candidates (8), and the app's finished result ("앱 최종", refine.ts) once per scene and candidate on
// alternating seeds (4). Each pair-NN.png: a header naming the stage; the shower's catalogue photo with its
// record (화이트 · 무광), the design (app picture), A and B; below, the shower enlarged in the design, A, B.
// With --step 40: s1 (a little lighter, the photo's shading kept) against today's, both scenes × both
// seeds × both stages (8).
// Usage: node tests/photo-colour/pairs.mjs [--step 40] [--seed 20261139]
// Output: docs/plans/pictures/9/blind-step-<step>/pair-NN.png, key.json
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { OUT, SCENES } from './variants.mjs';

const at = process.argv.indexOf('--seed');
const stepAt = process.argv.indexOf('--step');
const step = stepAt > 0 ? process.argv[stepAt + 1] : '39';
let state = at > 0 ? Number(process.argv[at + 1]) : 20261100 + Number(step);
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '9', `blind-step-${step}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const NAMES = {
  cur: 'today "grey (#8d8a87)"',
  w1: 'w1 "white" (record name)',
  w2: 'w2 "white (#ebe8e4)"',
  s1: 's1 "light grey (#a39f9c)"',
};
const STAGES = { raw: 'AI 원본', refined: '앱 최종' };
const SEEDS = [424242, 777001];
const pairs =
  step === '40'
    ? SCENES.flatMap((scene) =>
        SEEDS.flatMap((seed) => ['raw', 'refined'].map((stage) => ({ scene, seed, x: 's1', stage }))),
      )
    : [
        ...SCENES.flatMap((scene) =>
          SEEDS.flatMap((seed) => ['w1', 'w2'].map((x) => ({ scene, seed, x, stage: 'raw' }))),
        ),
        ...SCENES.flatMap((scene, i) =>
          ['w1', 'w2'].map((x, j) => ({ scene, seed: SEEDS[(i + j) % 2], x, stage: 'refined' })),
        ),
      ];
for (let i = pairs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
}
const catalog = JSON.parse(readFileSync(join(OUT, 'catalog', 'catalog.json'), 'utf8'));
const shower = catalog.placements.find((p) => p.category === 'shower');
const photoFile = readdirSync(join(OUT, 'catalog', 'images')).find((f) =>
  f.startsWith(shower.views[0].assetId),
);
const W = 480,
  GAP = 10,
  LABEL = 36,
  AW = 992,
  AH = 672;
const text = (s, width = W, size = 24) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}"><text x="4" y="${size + 4}" font-family="Malgun Gothic, sans-serif" font-size="${size}" font-weight="700" fill="#111">${s}</text></svg>`,
  );
const photo = await sharp(join(OUT, 'catalog', 'images', photoFile))
  .flatten({ background: '#d9d9d9' })
  .resize(W, Math.round((W * AH) / AW), { fit: 'contain', background: '#d9d9d9' })
  .png()
  .toBuffer();
const key = {};
for (const [n, pair] of pairs.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const id = `${pair.scene}-${pair.seed}`;
  const sceneDir = join(OUT, 'cur', 'scenes', pair.scene);
  const [l, r] = random() < 0.5 ? [pair.x, 'cur'] : ['cur', pair.x];
  const files = [
    join(sceneDir, 'capture.png'),
    join(OUT, l, pair.stage, `${id}.png`),
    join(OUT, r, pair.stage, `${id}.png`),
  ];
  const layout = JSON.parse(readFileSync(join(sceneDir, 'layout.json'), 'utf8')).layout;
  const box = JSON.parse(readFileSync(join(sceneDir, 'grounding.json'), 'utf8')).scene.fixtures.find(
    (x) => x.kind === 'shower',
  ).box;
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * AW),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * AH),
  ];
  const [x0, y0] = px(Math.max(0, box[0] - 0.03), Math.max(0, box[1] - 0.03));
  const [x1, y1] = px(Math.min(1, box[2] + 0.03), Math.min(1, box[3] + 0.03));
  const pics = await Promise.all(
    files.map((f) => sharp(f).removeAlpha().resize(AW, AH, { fit: 'fill' }).png().toBuffer()),
  );
  const full = await Promise.all(
    pics.map((p) =>
      sharp(p)
        .resize(W, Math.round((W * AH) / AW))
        .png()
        .toBuffer(),
    ),
  );
  const zh = Math.round((W * (y1 - y0)) / (x1 - x0));
  const zoom = await Promise.all(
    pics.map((p) =>
      sharp(p)
        .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
        .resize(W, zh, { kernel: 'lanczos3' })
        .png()
        .toBuffer(),
    ),
  );
  const h = Math.round((W * AH) / AW);
  const width = 4 * W + 3 * GAP;
  const composite = [
    {
      input: text(`${STAGES[pair.stage]} 비교 — 샤워 세트의 색·무광 느낌·가는 부품 모양`, width),
      left: 0,
      top: 0,
    },
  ];
  ['제품 사진 · 등록: 화이트 · 무광', '설계(앱 그림)', 'A', 'B'].forEach((label, i) =>
    composite.push({ input: text(label), left: i * (W + GAP), top: LABEL }),
  );
  composite.push({ input: photo, left: 0, top: 2 * LABEL });
  full.forEach((input, i) => composite.push({ input, left: (i + 1) * (W + GAP), top: 2 * LABEL }));
  zoom.forEach((input, i) => composite.push({ input, left: (i + 1) * (W + GAP), top: 2 * LABEL + h + GAP }));
  await sharp({ create: { width, height: 2 * LABEL + h + GAP + zh, channels: 3, background: '#ffffff' } })
    .composite(composite)
    .png()
    .toFile(join(dir, `${name}.png`));
  key[name] = {
    id,
    stage: STAGES[pair.stage],
    A: NAMES[l],
    B: NAMES[r],
    files: { A: files[1], B: files[2] },
  };
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
console.log(pairs.length, 'pairs in', dir);
