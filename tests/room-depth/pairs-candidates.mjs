// Backlog item 2, step 09: blind pairs of the corner-shade candidates (candidates.mjs) against today's
// 3D light (3037c8e), the app's finished pictures of local FLUX answers (tests/side-tile-ai refine.ts).
//   - c6 against today: all ten (five scenes × seeds 424242, 777001);
//   - c1 against c6: olive 0° and white 0°, seed 424242 (how much shade).
// Usage: node tests/room-depth/pairs-candidates.mjs [--seed 20261125]
// Output: docs/plans/pictures/2/blind-step-09/pair-NN.png, key.json
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT as TRIAL, ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261125;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const dir = join(ROOT, 'docs', 'plans', 'pictures', '2', 'blind-step-09');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const file = (rev, id) => join(TRIAL, rev, 'refined', `${id}.png`);
const pairs = [];
for (const scene of ['olive-0', 'olive-90', 'black-0', 'beige-90', 'white-0'])
  for (const seed of [424242, 777001]) pairs.push({ id: `${scene}-${seed}`, x: 'after', y: 'c6' });
for (const scene of ['olive-0', 'white-0']) pairs.push({ id: `${scene}-424242`, x: 'c1', y: 'c6' });
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
  const xLeft = random() < 0.5;
  const [l, r] = xLeft ? [pair.x, pair.y] : [pair.y, pair.x];
  for (const rev of [l, r]) if (!existsSync(file(rev, pair.id))) throw new Error(`no ${file(rev, pair.id)}`);
  const scaled = async (rev) =>
    sharp(file(rev, pair.id)).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
  const a = await scaled(l),
    b = await scaled(r);
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
  const label = (rev) =>
    ({ after: 'today 3037c8e', c1: 'c1 corner +0.35/500', c6: 'c6 corner +0.5/650' })[rev];
  key[name] = { id: pair.id, A: label(l), B: label(r), files: { A: file(l, pair.id), B: file(r, pair.id) } };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
