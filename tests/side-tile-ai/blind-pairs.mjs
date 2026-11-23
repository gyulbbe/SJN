// Step 05 of the side-tile AI item: the blind pairs the supervisor judges (SUPERVISOR.md section 10).
// Each pair-NN.png holds the scene's wall tile as registered (the catalogue texture, the same for both
// sides) over A (left) and B (right), the finished pictures of the 3D light before (6e0ca52) and after
// (3037c8e), in random order. Which side is which is only in key.json, written beside the pairs.
//   - today's method, Cloudflare answers (supervisor, 2026-11-21, seed 424242), the app's refine;
//   - the empty-room composite, local FLUX answers (seed 424242), today's composite (cb4fafb).
// Usage: node tests/side-tile-ai/blind-pairs.mjs [--seed 20261123]
// Output: docs/plans/pictures/1/blind-step-05/pair-NN.png, key.json
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { CATALOG, OUT, ROOT } from './paths.mjs';
import { TILES } from './needed.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261123;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '1', 'blind-step-05');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const catalog = JSON.parse(readFileSync(join(CATALOG, 'catalog.json'), 'utf8'));
const swatch = (materialId) => {
  const record = catalog.placements.find((p) => p.materialId === materialId);
  const image = record.images.find((i) => i.kind === 'texture') ?? record.images[0];
  // The list-size file catalog.mjs saved, whatever its format.
  const file = readdirSync(join(CATALOG, 'images')).find((f) => f.startsWith(`${image.id}.`));
  if (!file) throw new Error(`no catalogue image ${image.id}`);
  return join(CATALOG, 'images', file);
};
const cloud = join(ROOT, 'test-results', 'supervisor', 'cf1', 'test-results', 'side-tile-ai-20261121');
const wall = { olive: TILES.olive, white: TILES.white };
const pairs = [];
for (const scene of ['olive-0', 'olive-90', 'white-0'])
  pairs.push({
    scene,
    method: 'today (refine), Cloudflare answer',
    seed: 424242,
    wall: wall[scene.split('-')[0]],
    old: join(cloud, 'before', 'refined', `${scene}-424242.png`),
    new: join(cloud, 'after', 'refined', `${scene}-424242.png`),
  });
for (const scene of ['olive-0', 'olive-90', 'white-0'])
  pairs.push({
    scene,
    method: 'empty-room composite, local FLUX answer',
    seed: 424242,
    wall: wall[scene.split('-')[0]],
    old: join(OUT, 'step05', `before-${scene}-local-fixed`, 'final.png'),
    new: join(OUT, 'step05', `after-${scene}-local-fixed`, 'final.png'),
  });
// Shuffle the order too, so the two methods are not read as blocks.
for (let i = pairs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
}

const W = 720,
  GAP = 16,
  LABEL = 40,
  SWATCH = 180;
const text = (s, size = 28) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LABEL}"><text x="4" y="${size}" font-family="Malgun Gothic, sans-serif" font-size="${size}" font-weight="700" fill="#111">${s}</text></svg>`,
  );
const key = {};
for (const [n, pair] of pairs.entries()) {
  for (const f of [pair.old, pair.new]) if (!existsSync(f)) throw new Error(`no ${f}`);
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const newLeft = random() < 0.5;
  const [left, right] = newLeft ? [pair.new, pair.old] : [pair.old, pair.new];
  const scaled = async (f) => sharp(f).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
  const a = await scaled(left),
    b = await scaled(right);
  const h = Math.max(a.info.height, b.info.height);
  const sw = await sharp(swatch(pair.wall))
    .resize({ height: SWATCH })
    .png()
    .toBuffer({ resolveWithObject: true });
  const width = 2 * W + GAP,
    height = LABEL + SWATCH + GAP + LABEL + h;
  await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([
      { input: text(`${name} · 벽 타일 견본(등록 이미지, 양쪽 같음)`, 24), left: 0, top: 0 },
      { input: sw.data, left: 0, top: LABEL },
      { input: text('A'), left: 0, top: LABEL + SWATCH + GAP },
      { input: text('B'), left: W + GAP, top: LABEL + SWATCH + GAP },
      { input: a.data, left: 0, top: 2 * LABEL + SWATCH + GAP },
      { input: b.data, left: W + GAP, top: 2 * LABEL + SWATCH + GAP },
    ])
    .png()
    .toFile(join(dir, `${name}.png`));
  key[name] = {
    scene: pair.scene,
    method: pair.method,
    seed: pair.seed,
    A: newLeft ? 'new 3037c8e' : 'old 6e0ca52',
    B: newLeft ? 'old 6e0ca52' : 'new 3037c8e',
    files: { A: left, B: right },
  };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
