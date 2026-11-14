// Scores a reviewed set of the added-objects trial against the criteria written before the rounds
// (docs/extra-ai-trials-20261114.md, section 3): each method beside the current one on the same
// scenes and seeds, and how often Gemma's check (all added objects it named) agrees with the review.
// With --compare <set> it also counts how often two sets (the user's check set and mine) agree on
// "없던 물건이 생김" for the same pictures. No AI call.
//
//   node tests/extra-ai/review-score.mjs --set r2 [--base cur] [--compare u12]
// Output: the table on the console and test-results/extra-ai-20261114/review/<set>/score.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, REVIEW } from './paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'r2');
const base = arg('base', 'cur');
const compare = arg('compare');
const read = (name) => {
  const dir = join(REVIEW, name);
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')).singles;
  // The last rating of an id counts ("이전 것 다시 평가").
  const ratings = new Map();
  if (existsSync(join(dir, 'ratings.jsonl')))
    for (const line of readFileSync(join(dir, 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      ratings.set(row.id, row);
    }
  return { key, ratings };
};
const { key, ratings } = read(set);
const spot = (job) => `${job.scene}-${job.seed}`;
/** method → scene-seed → rating. */
const byMethod = new Map();
for (const [id, item] of Object.entries(key)) {
  const rating = ratings.get(id);
  if (!rating) continue;
  for (const job of item.jobs) {
    if (!byMethod.has(job.method)) byMethod.set(job.method, new Map());
    byMethod.get(job.method).set(spot(job), rating);
  }
}
const flagged = (rating, flag) => (rating.flags ?? []).includes(flag);
const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : NaN);
const current = byMethod.get(base) ?? new Map();
const table = {};
for (const [method, spots] of byMethod) {
  const shared = [...spots.keys()].filter((s) => current.has(s));
  const mine = shared.map((s) => spots.get(s)),
    theirs = shared.map((s) => current.get(s));
  const count = (list, flag) => list.filter((r) => flagged(r, flag)).length;
  const row = {
    n: shared.length,
    added: count(mine, 'added'),
    addedBase: count(theirs, 'added'),
    product: count(mine, 'product'),
    productBase: count(theirs, 'product'),
    smudge: count(mine, 'smudge'),
    framing: count(mine, 'framing'),
    real: +mean(mine.map((r) => r.real)).toFixed(2),
    realBase: +mean(theirs.map((r) => r.real)).toFixed(2),
    design: +mean(mine.map((r) => r.design)).toFixed(2),
    designBase: +mean(theirs.map((r) => r.design)).toFixed(2),
  };
  const half = row.addedBase === 0 ? row.added === 0 : row.added <= row.addedBase / 2;
  row.pass =
    method === base
      ? '-'
      : {
          1: half,
          2: row.real >= row.realBase - 0.3,
          3: row.design >= row.designBase - 0.2 && row.product <= row.productBase,
        };
  table[method] = row;
}
console.table(
  Object.fromEntries(
    Object.entries(table).map(([m, r]) => [
      m,
      {
        n: r.n,
        added: `${r.added} (${base} ${r.addedBase})`,
        product: `${r.product} (${r.productBase})`,
        smudge: r.smudge,
        real: `${r.real} (${r.realBase})`,
        design: `${r.design} (${r.designBase})`,
        pass:
          typeof r.pass === 'object'
            ? Object.entries(r.pass)
                .map(([k, v]) => `${k}${v ? '✓' : '✗'}`)
                .join(' ')
            : r.pass,
      },
    ]),
  ),
);
// Gemma's check against the review: did it name any added object where the review saw one?
const gemma = { both: 0, gemmaOnly: 0, reviewOnly: 0, neither: 0, largeBoth: 0, largeReviewOnly: 0 };
for (const [id, item] of Object.entries(key)) {
  const rating = ratings.get(id);
  if (!rating) continue;
  const job = item.jobs.find((j) => !j.method.includes('+')) ?? item.jobs[0];
  const file = join(RESULTS, 'cf', job.method, `${job.scene}-${job.seed}.check.json`);
  if (!existsSync(file) || job.method.includes('+erase')) continue;
  const check = JSON.parse(readFileSync(file, 'utf8'));
  const named = (check.parsed?.extras ?? []).length > 0;
  const shown = (check.reading?.extras ?? []).length > 0;
  const seen = flagged(rating, 'added');
  gemma[named && seen ? 'both' : named ? 'gemmaOnly' : seen ? 'reviewOnly' : 'neither']++;
  if (seen) gemma[shown ? 'largeBoth' : 'largeReviewOnly']++;
}
console.log('Gemma (any added object) vs review:', JSON.stringify(gemma));
let agreement;
if (compare) {
  const other = read(compare);
  let same = 0,
    total = 0;
  const differ = [];
  for (const [id, item] of Object.entries(other.key)) {
    const theirs = other.ratings.get(id),
      mine = ratings.get(item.from);
    if (!theirs || !mine) continue;
    total++;
    if (flagged(theirs, 'added') === flagged(mine, 'added')) same++;
    else
      differ.push({
        id,
        from: item.from,
        [compare]: flagged(theirs, 'added'),
        [set]: flagged(mine, 'added'),
      });
  }
  agreement = { same, total, differ };
  console.log(`"없던 물건" agreement ${compare} vs ${set}: ${same}/${total}`, differ);
}
writeFileSync(join(REVIEW, set, 'score.json'), JSON.stringify({ base, table, gemma, agreement }, null, 1));
