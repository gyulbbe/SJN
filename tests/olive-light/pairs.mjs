// Backlog item 4, step 34: blind pairs of the app's finished results (no AI call, the same saved answer on
// both sides) under today's refine and a trial LIGHTNESS_BAND (refine.ts --tuning '{"lightnessBand":n}'
// --suffix bn): 4 (b4) and 0 (b0) on the four Cloudflare olive scenes (main's prompt, seed 424242), and a
// few local big-room scenes with other tiles (white, black, beige) for what the band does elsewhere.
// Each pair-NN.png: the app picture (설계) with A and B beside it; below, the middle of the back wall
// enlarged and the fixtures with the wall around them.
// Usage: node tests/olive-light/pairs.mjs [--seed 20261134]
// Output: docs/plans/pictures/4/blind-step-34/pair-NN.png, key.json
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { TREES } from './faces.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261134;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '4', 'blind-step-34');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const NAMES = { main: 'today', 'refined-b4': 'band 4', 'refined-b0': 'band 0' };
const tree = (name) => TREES.find((x) => x.name === name);
const P = (name, id, x) => ({ tree: tree(name), id, x, y: 'main' });
const pairs = [
  ...['olive-0', 'olive-90', 'bath-olive-0', 'bath-olive-90'].flatMap((scene) =>
    ['refined-b4', 'refined-b0'].map((x) => P('cf', `${scene}-424242`, x)),
  ),
  P('big', 'bath-white-0-424242', 'refined-b0'),
  P('big', 'bath-black-0-424242', 'refined-b0'),
  P('big', 'bath-beige-0-777001', 'refined-b4'),
  P('big', 'bath-white-90-424242', 'refined-b4'),
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
  const { id } = pair;
  const sceneDir = join(pair.tree.dir, 'scenes', id.replace(/-\d+$/, ''));
  const folder = (set) => (set === 'main' ? pair.tree.main : set);
  const [l, r] = random() < 0.5 ? [pair.x, pair.y] : [pair.y, pair.x];
  const files = [
    join(sceneDir, 'capture.png'),
    join(pair.tree.dir, folder(l), `${id}.png`),
    join(pair.tree.dir, folder(r), `${id}.png`),
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
  const composite = [];
  let top = 0;
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
    answers: pair.tree.name,
    A: NAMES[l],
    B: NAMES[r],
    files: { A: files[1], B: files[2] },
  };
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
console.log(pairs.length, 'pairs in', dir);
