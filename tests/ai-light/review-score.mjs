// Scores a review set of the AI-light trial (docs/ai-light-20261115.md, section 3): per candidate,
// how often the reviewer chose it over the app as it is (k100), the same, or k100, with the notes.
// No AI call.
//
//   node tests/ai-light/review-score.mjs --set l1
// Output: the summary on the console and test-results/ai-light-20261115/review/<set>/score.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW } from './paths.mjs';

const i = process.argv.indexOf('--set');
const set = i > 0 ? process.argv[i + 1] : 'l1';
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
        : item.a === 'k100'
          ? item.candidate
          : 'k100';
  const verdict = chose === 'same' ? 'same' : chose === 'k100' ? 'worse' : 'better';
  count[verdict]++;
  if (rating.note)
    notes.push({ id, source: item.source, candidate: item.candidate, verdict, note: rating.note });
}
for (const [candidate, c] of Object.entries(tally))
  console.log(`${candidate}: better ${c.better}, same ${c.same}, worse ${c.worse}, missing ${c.missing}`);
for (const n of notes) console.log(`${n.id} ${n.source} ${n.candidate} ${n.verdict}: ${n.note}`);
writeFileSync(join(dir, 'score.json'), JSON.stringify({ tally, notes }, null, 1));
