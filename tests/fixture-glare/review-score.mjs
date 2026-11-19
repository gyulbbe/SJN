// Scores a review set of the fixture-glare trial (docs/fixture-glare-20261119.md): per candidate,
// how often the reviewer chose it over the baseline (the key's `base`), the same, or the baseline, with the notes.
// No AI call.
//
//   node tests/fixture-glare/review-score.mjs --set g1
// Output: the summary on the console and test-results/fixture-glare-20261119/review/<set>/score.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './paths.mjs';

const i = process.argv.indexOf('--set');
const set = i > 0 ? process.argv[i + 1] : 'g1';
const dir = join(OUT, 'review', set);
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
const ratings = new Map();
if (existsSync(join(dir, 'ratings.jsonl')))
  for (const line of readFileSync(join(dir, 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    ratings.set(row.id, row); // the last rating of an id counts
  }
const tally = {};
const rows = [];
for (const [id, item] of Object.entries(key.pairs)) {
  const count = (tally[item.candidate] ??= { better: 0, same: 0, worse: 0, missing: 0 });
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
        : item.a === item.base
          ? item.candidate
          : item.base;
  const verdict = chose === 'same' ? 'same' : chose === item.base ? 'worse' : 'better';
  count[verdict]++;
  rows.push({ id, source: item.source, candidate: item.candidate, verdict, note: rating.note ?? '' });
}
for (const [candidate, c] of Object.entries(tally))
  console.log(`${candidate}: better ${c.better}, same ${c.same}, worse ${c.worse}, missing ${c.missing}`);
for (const r of rows)
  if (r.note || r.verdict === 'worse')
    console.log(`${r.id} ${r.source} ${r.candidate} ${r.verdict}: ${r.note}`);
writeFileSync(join(dir, 'score.json'), JSON.stringify({ tally, rows }, null, 1));
