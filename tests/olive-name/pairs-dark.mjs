// Backlog item 5, step 31: blind pairs of the Cloudflare answers (seed 424242, dark-setup.mjs, cloud.ts
// --dark) on today's app inputs: the app's "dark olive" (a1, after 3208c5a) against main's "grey" (saved
// step-29 answers, same input and prompt hashes) for the four scenes, the model's answer ("AI 원본") and the
// app's finished result ("앱 최종"), plus a1 against step 29's rejected "olive" on the bath front (10 pairs).
// Each pair-NN.png: a header naming the stage, the app picture (설계) with A and B beside it; below, the
// middle of the back wall enlarged and the fixtures with the wall around them (bath front shading).
// Usage: node tests/olive-name/pairs-dark.mjs [--seed 20261131]
// Output: docs/plans/pictures/5/blind-step-31/pair-NN.png, key.json
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { DARK_OUT } from './dark-setup.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261131;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '5', 'blind-step-31');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const NAMES = { cur: 'main "grey"', n2: 'n2 "olive"', a1: 'a1 "dark olive"' };
const STAGES = { raw: 'AI 원본', refined: '앱 최종' };
const P = (scene, seed, stage, y = 'cur') => ({ scene, seed, stage, x: 'a1', y });
const pairs = [
  ...['bath-olive-0', 'bath-olive-90', 'olive-0', 'olive-90'].flatMap((scene) =>
    ['raw', 'refined'].map((stage) => P(scene, 424242, stage)),
  ),
  P('bath-olive-0', 424242, 'raw', 'n2'),
  P('bath-olive-0', 424242, 'refined', 'n2'),
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
const text = (s, width = W) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}"><text x="4" y="29" font-family="Malgun Gothic, sans-serif" font-size="28" font-weight="700" fill="#111">${s}</text></svg>`,
  );
const key = {};
for (const [n, pair] of pairs.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const id = `${pair.scene}-${pair.seed}`;
  const sceneDir = join(DARK_OUT, 'a1', 'scenes', pair.scene);
  const [l, r] = random() < 0.5 ? [pair.x, pair.y] : [pair.y, pair.x];
  const files = [
    join(sceneDir, 'capture.png'),
    join(DARK_OUT, l, pair.stage, `${id}.png`),
    join(DARK_OUT, r, pair.stage, `${id}.png`),
  ];
  const layout = JSON.parse(readFileSync(join(sceneDir, 'layout.json'), 'utf8')).layout;
  const grounding = JSON.parse(readFileSync(join(sceneDir, 'grounding.json'), 'utf8'));
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * AW),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * AH),
  ];
  // The back wall's middle (x 30–70%, y 12–45% of the content) and the fixtures' union with a margin.
  const boxes = grounding.scene.fixtures.filter((f) => f.box).map((f) => f.box);
  const u = [0, 1, 2, 3].map((k) => (k < 2 ? Math.min : Math.max)(...boxes.map((b) => b[k])));
  const crops = [
    [px(0.3, 0.12), px(0.7, 0.45)],
    [
      px(Math.max(0, u[0] - 0.04), Math.max(0, u[1] - 0.12)),
      px(Math.min(1, u[2] + 0.04), Math.min(1, u[3] + 0.02)),
    ],
  ];
  const at = (f) => sharp(f).removeAlpha().resize(AW, AH, { fit: 'fill' }).png().toBuffer();
  const pics = await Promise.all(files.map(at));
  const full = await Promise.all(pics.map((p) => sharp(p).resize({ width: W }).png().toBuffer()));
  const zooms = await Promise.all(
    crops.map(([[x0, y0], [x1, y1]]) =>
      Promise.all(
        pics.map((p) =>
          sharp(p)
            .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
            .resize({ width: W })
            .png()
            .toBuffer({ resolveWithObject: true }),
        ),
      ),
    ),
  );
  const h = Math.round((W * AH) / AW);
  const composite = [{ input: text(`${STAGES[pair.stage]} 비교`, 3 * W), left: 0, top: 0 }];
  let top = LABEL;
  ['설계(앱 그림)', 'A', 'B'].forEach((label, i) => {
    composite.push({ input: text(label), left: i * (W + GAP), top });
    composite.push({ input: full[i], left: i * (W + GAP), top: top + LABEL });
  });
  top += LABEL + h + GAP;
  for (const zoom of zooms) {
    zoom.forEach((z, i) => composite.push({ input: z.data, left: i * (W + GAP), top }));
    top += zoom[0].info.height + GAP;
  }
  await sharp({ create: { width: 3 * W + 2 * GAP, height: top, channels: 3, background: '#ffffff' } })
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
