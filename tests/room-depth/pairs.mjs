// Backlog item 2, step 08: blind pairs for the supervisor (SUPERVISOR.md section 10), about depth: do the
// AI's finished pictures of the new 3D light (3037c8e) read flatter than the old (6e0ca52)?
//   - the six pairs of item 1's step 05 (docs/plans/pictures/1/blind-step-05/key.json) with left and right
//     swapped, as the step file asks;
//   - four more of today's method on local FLUX answers (black 0°, beige 90°, seeds 424242 and 777001),
//     scenes step 05 did not show, sides at random.
// Each pair-NN.png is the scene's A (left) and B (right), full pictures; which is which only in key.json.
// Usage: node tests/room-depth/pairs.mjs [--seed 20261124]
// Output: docs/plans/pictures/2/blind-step-08/pair-NN.png, key.json
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT as TRIAL, ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261124;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '2', 'blind-step-08');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const pairs = [];
const earlier = JSON.parse(
  readFileSync(join(ROOT, 'docs', 'plans', 'pictures', '1', 'blind-step-05', 'key.json'), 'utf8'),
);
for (const [name, k] of Object.entries(earlier)) {
  const newWasLeft = k.A.startsWith('new');
  const [oldFile, newFile] = newWasLeft ? [k.files.B, k.files.A] : [k.files.A, k.files.B];
  pairs.push({
    from: `step-05 ${name}`,
    scene: k.scene,
    method: k.method,
    seed: k.seed,
    old: oldFile,
    new: newFile,
    newLeft: !newWasLeft,
  });
}
for (const scene of ['black-0', 'beige-90'])
  for (const seed of [424242, 777001])
    pairs.push({
      from: 'new',
      scene,
      method: 'today (refine), local FLUX answer',
      seed,
      old: join(TRIAL, 'before', 'refined', `${scene}-${seed}.png`),
      new: join(TRIAL, 'after', 'refined', `${scene}-${seed}.png`),
      newLeft: random() < 0.5,
    });
// Shuffle the order so the earlier pairs do not come in their earlier places.
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
  for (const f of [pair.old, pair.new]) if (!existsSync(f)) throw new Error(`no ${f}`);
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const [left, right] = pair.newLeft ? [pair.new, pair.old] : [pair.old, pair.new];
  const scaled = async (f) => sharp(f).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
  const a = await scaled(left),
    b = await scaled(right);
  const h = Math.max(a.info.height, b.info.height);
  await sharp({ create: { width: 2 * W + GAP, height: 2 * LABEL + h, channels: 3, background: '#ffffff' } })
    .composite([
      { input: text(name, 24, 2 * W + GAP), left: 0, top: 0 },
      { input: text('A'), left: 0, top: LABEL },
      { input: text('B'), left: W + GAP, top: LABEL },
      { input: a.data, left: 0, top: 2 * LABEL },
      { input: b.data, left: W + GAP, top: 2 * LABEL },
    ])
    .png()
    .toFile(join(dir, `${name}.png`));
  key[name] = {
    from: pair.from,
    scene: pair.scene,
    method: pair.method,
    seed: pair.seed,
    A: pair.newLeft ? 'new 3037c8e' : 'old 6e0ca52',
    B: pair.newLeft ? 'old 6e0ca52' : 'new 3037c8e',
    files: { A: left, B: right },
  };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
