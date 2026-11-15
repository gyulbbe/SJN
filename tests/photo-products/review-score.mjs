// Scores a review set of the photo-product trial (docs/photo-products-20261115.md, section 3): per
// candidate, how often the reviewer chose it over the app as it is (p0), the same, or p0, with the
// notes. No AI call.
//
//   node tests/photo-products/review-score.mjs --set q1
// Output: the summary on the console and test-results/photo-products-20261115/review/<set>/score.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW } from './paths.mjs';

const i = process.argv.indexOf('--set');
const set = i > 0 ? process.argv[i + 1] : 'q1';
const dir = join(REVIEW, set);
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
const ratings = new Map();
if (existsSync(join(dir, 'ratings.jsonl')))
  for (const line of readFileSync(join(dir, 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    ratings.set(row.id, row); // the last rating of an id counts
  }
const tally = {};
const notes = [];
for (const [id, item] of Object.entries(key.pairs)) {
  // Sets before q2 had p0 as every pair's base.
  const base = item.base ?? 'p0';
  const count = (tally[`${base}→${item.candidate}`] ??= { better: 0, same: 0, worse: 0, missing: 0 });
  const rating = ratings.get(id);
  if (!rating) {
    count.missing++;
    continue;
  }
  const chose =
    rating.choice === 'same'
      ? 'same'
      : rating.choice === 'a'
        ? item.a
        : item.a === base
          ? item.candidate
          : base;
  const verdict = chose === 'same' ? 'same' : chose === base ? 'worse' : 'better';
  count[verdict]++;
  if (rating.note)
    notes.push({
      id,
      source: `${item.scene}-${item.seed}`,
      candidate: `${base}→${item.candidate}`,
      verdict,
      note: rating.note,
    });
}
for (const [candidate, c] of Object.entries(tally))
  console.log(`${candidate}: better ${c.better}, same ${c.same}, worse ${c.worse}, missing ${c.missing}`);
for (const n of notes) console.log(`${n.id} ${n.source} ${n.candidate} ${n.verdict}: ${n.note}`);
writeFileSync(join(dir, 'score.json'), JSON.stringify({ tally, notes }, null, 1));
