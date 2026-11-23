// Backlog item 2, the Cloudflare check before release: blind pairs of the app's finished pictures,
// today's main (3037c8e light) against the app with the wall–wall corner shade (5268cf1, c6), the same
// input frame, prompt and seed 424242 through the app's model (tests/room-depth/cloud.ts, refine.ts).
// Usage: node tests/room-depth/pairs-cloud.mjs [--seed 20261126]
// Output: docs/plans/pictures/2/blind-step-10/pair-NN.png, key.json
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--seed');
let state = at > 0 ? Number(process.argv[at + 1]) : 20261126;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const CF = join(ROOT, 'test-results', 'room-depth-20261123', 'cf');
const dir = join(ROOT, 'docs', 'plans', 'pictures', '2', 'blind-step-10');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const file = (rev, id) => join(CF, rev, 'refined', `${id}.png`);
const ids = ['olive-0', 'olive-90', 'beige-90', 'white-0'].map((s) => `${s}-424242`);
for (let i = ids.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [ids[i], ids[j]] = [ids[j], ids[i]];
}
const W = 720,
  GAP = 16,
  LABEL = 40;
const text = (s, size = 28, width = W) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL}"><text x="4" y="${size}" font-family="Malgun Gothic, sans-serif" font-size="${size}" font-weight="700" fill="#111">${s}</text></svg>`,
  );
const label = { after: 'main 3037c8e light', app: 'corner shade 5268cf1 (c6)' };
const key = {};
for (const [n, id] of ids.entries()) {
  const name = `pair-${String(n + 1).padStart(2, '0')}`;
  const [l, r] = random() < 0.5 ? ['after', 'app'] : ['app', 'after'];
  for (const rev of [l, r]) if (!existsSync(file(rev, id))) throw new Error(`no ${file(rev, id)}`);
  const scaled = async (rev) =>
    sharp(file(rev, id)).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
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
  key[name] = { id, A: label[l], B: label[r], files: { A: file(l, id), B: file(r, id) } };
  console.log(name, 'ok');
}
writeFileSync(join(dir, 'key.json'), JSON.stringify(key, null, 1));
