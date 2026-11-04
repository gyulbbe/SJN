// Outline scores of a round's answers (no AI): each answer against the shape its method meant (the filled
// guide of B0, B2 or their 0° version: an outline-only guide B3 is scored against the shape it outlines),
// and a toilet's side against the catalogue's real side photo when there is one (both cut to their box
// and scaled to the same box, tests/direction-photo-real/measure.mjs). Writes scores/<round>.json and
// prints, per category, view kind and method, the median overlap and its difference from C0 on the
// same products, views and seeds.
//
//   node tests/direction-photo-methods/score.mjs <round>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { outline, iou } from '../direction-photo-real/measure.mjs';
import { OUT } from './paths.mjs';

const round = process.argv[2];
const RUNS = join(OUT, 'runs', round);
const manifest = JSON.parse(readFileSync(join(OUT, 'prep', 'manifest.json'), 'utf8'));
/** The guide whose filled outline a method's answer should follow. */
export const SHAPE_OF = {
  C0: 'b0',
  B3: 'b0',
  B4: 'b4',
  C3: 'b0',
  C1s1: 'b0',
  C1: 'b0',
  C2: 'b0',
  A1: 'b0',
  B6: 'b0',
  B2: 'b2',
  B2B3: 'b2',
  B2C3: 'b2',
  B2C1s1: 'b2',
  B2C1: 'b2',
  B2B4: 'b2b4',
};
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : NaN;
};

const rows = [];
const cache = new Map();
const outlineOf = async (file) => {
  if (!cache.has(file)) cache.set(file, await outline(file));
  return cache.get(file);
};
for (const product of existsSync(RUNS) ? readdirSync(RUNS) : []) {
  const entry = manifest[product];
  for (const method of readdirSync(join(RUNS, product))) {
    const dir = join(RUNS, product, method);
    for (const file of readdirSync(dir).filter((f) => /^(front|left|right|back)-\d+\.png$/.test(f))) {
      const [view, seed] = file.replace('.png', '').split('-');
      const shape = entry.guides[SHAPE_OF[method]]?.[view];
      if (!shape) continue;
      const answer = await outlineOf(join(dir, file));
      const guide = await outlineOf(shape);
      const real = entry.answers?.[view]?.file;
      const truth = real ? await outlineOf(real) : undefined;
      rows.push({
        product,
        method,
        view,
        seed: Number(seed),
        iouShape: Number(iou(guide.mask, answer.mask).toFixed(3)),
        aspect: Number(answer.aspect.toFixed(2)),
        aspectShape: Number(guide.aspect.toFixed(2)),
        ...(truth
          ? {
              iouReal: Number(iou(truth.mask, answer.mask).toFixed(3)),
              mirroredReal: !!entry.answers[view].mirrored,
            }
          : {}),
      });
    }
  }
}
mkdirSync(join(OUT, 'scores'), { recursive: true });
writeFileSync(join(OUT, 'scores', `${round}.json`), JSON.stringify(rows, null, 1));

const category = (id) =>
  id.startsWith('b') && /^b\d+$/.test(id) ? 'basin' : id.startsWith('bath') ? 'bath' : 'toilet';
const kind = (view) => (view === 'front' ? 'front' : view === 'back' ? 'back' : 'side');
const key = (r) => `${r.product}|${r.view}|${r.seed}`;
const c0 = new Map(rows.filter((r) => r.method === 'C0').map((r) => [key(r), r]));
const groups = {};
for (const r of rows) {
  const g = `${category(r.product)} ${kind(r.view)} ${r.method}`;
  (groups[g] ??= []).push(r);
}
console.log('group'.padEnd(26), 'n', 'iouShape', 'vsC0(same items)', 'iouReal');
for (const [g, list] of Object.entries(groups).sort()) {
  const paired = list.filter((r) => c0.has(key(r)));
  const diff = median(paired.map((r) => r.iouShape - c0.get(key(r)).iouShape));
  const real = list.filter((r) => r.iouReal !== undefined);
  console.log(
    g.padEnd(26),
    String(list.length).padStart(2),
    median(list.map((r) => r.iouShape)).toFixed(3),
    Number.isNaN(diff) ? '   -' : (diff >= 0 ? '+' : '') + diff.toFixed(3),
    real.length ? median(real.map((r) => r.iouReal)).toFixed(3) : '',
  );
}
