// Scores a review set of the tile-pattern trial against the criteria written before it
// (docs/tile-pattern-trials-20261115.md, section 3): pairs (P2 better / same / worse than P0) and the
// singles (realism, design and flags of P0 and P2 on the same pictures). No AI call.
//
//   node tests/tile-pattern/review-score.mjs --set d1
// Output: the summary on the console and test-results/tile-pattern-20261115/review/<set>/score.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW } from './paths.mjs';

const i = process.argv.indexOf('--set');
const set = i > 0 ? process.argv[i + 1] : 'd1';
const dir = join(REVIEW, set);
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
const ratings = new Map();
if (existsSync(join(dir, 'ratings.jsonl')))
  for (const line of readFileSync(join(dir, 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    ratings.set(row.id, row); // the last rating of an id counts
  }

// Pairs: which rule the reviewer chose.
const pairs = { p2: 0, same: 0, p0: 0, missing: 0 };
const pairNotes = [];
for (const [id, item] of Object.entries(key.pairs)) {
  const rating = ratings.get(id);
  if (!rating) {
    pairs.missing++;
    continue;
  }
  const chose =
    rating.choice === 'same' ? 'same' : rating.choice === 'a' ? item.a : item.a === 'p0' ? 'p2' : 'p0';
  pairs[chose]++;
  if (rating.note) pairNotes.push({ source: item.source, chose, note: rating.note });
}
const rated = pairs.p2 + pairs.same + pairs.p0;
// Singles: per rule.
const singles = { p0: [], p2: [] };
for (const [id, item] of Object.entries(key.singles)) {
  const rating = ratings.get(id);
  if (rating) singles[item.rule].push({ source: item.source, ...rating });
}
const mean = (list, field) => (list.length ? list.reduce((s, r) => s + r[field], 0) / list.length : NaN);
const flagged = (list, flag) => list.filter((r) => (r.flags ?? []).includes(flag)).length;
const summary = {
  pairs: {
    ...pairs,
    betterShare: +(pairs.p2 / rated).toFixed(3),
    worseShare: +(pairs.p0 / rated).toFixed(3),
  },
  singles: Object.fromEntries(
    ['p0', 'p2'].map((rule) => [
      rule,
      {
        n: singles[rule].length,
        real: +mean(singles[rule], 'real').toFixed(2),
        design: +mean(singles[rule], 'design').toFixed(2),
        ...Object.fromEntries(
          ['pattern', 'joints', 'smudge', 'added', 'framing'].map((f) => [f, flagged(singles[rule], f)]),
        ),
      },
    ]),
  ),
};
summary.criteria = {
  1: summary.pairs.betterShare >= 0.5 && summary.pairs.worseShare <= 0.1,
  2: summary.singles.p2.real >= summary.singles.p0.real - 0.3,
  3: summary.singles.p2.smudge <= summary.singles.p0.smudge + 1,
};
console.log(JSON.stringify(summary, null, 1));
console.log('pair notes:');
for (const n of pairNotes) console.log(` ${n.source} chose ${n.chose}: ${n.note.replace(/\s+/g, ' ')}`);
console.log('single notes:');
for (const rule of ['p0', 'p2'])
  for (const r of singles[rule])
    if (r.note || r.flags?.length)
      console.log(
        ` ${rule} ${r.source} [${(r.flags ?? []).join(',')}] ${r.real}/${r.design} ${(r.note ?? '').replace(/\s+/g, ' ')}`,
      );
writeFileSync(join(dir, 'score.json'), JSON.stringify({ ...summary, pairNotes }, null, 1));
