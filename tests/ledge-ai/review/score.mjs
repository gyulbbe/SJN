// Scores a reviewed set of the ledge AI trial against the criteria written before the rounds
// (docs/ledge-ai-trials-20261111.md, section 2): each method beside the current one on the same scenes
// and seeds. A retry that kept the first answer counts with that answer's ratings, and as "the same"
// beside it. No AI call.
//
//   node tests/ledge-ai/review/score.mjs --set r4
// Output: the table on the console and test-results/ledge-ai-20261111/review/<set>/score.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, REVIEW } from '../paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'r4');
const dir = join(REVIEW, set);
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
// The last rating of an id counts ("이전 것 다시 평가").
const ratings = new Map();
if (existsSync(join(dir, 'ratings.jsonl')))
  for (const line of readFileSync(join(dir, 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    ratings.set(row.id, row);
  }
const LEDGE_FLAGS = ['gone', 'other', 'shape', 'tiles', 'niche'];
const spot = (item) => `${item.scene}-${item.seed}`;
/** method → scene-seed → the rating of its picture. */
const single = new Map();
for (const [id, item] of Object.entries(key.singles)) {
  const rating = ratings.get(id);
  if (!rating) continue;
  if (!single.has(item.method)) single.set(item.method, new Map());
  single.get(item.method).set(spot(item), rating);
}
const pairs = new Map();
for (const [id, item] of Object.entries(key.pairs)) {
  const rating = ratings.get(id);
  if (!rating) continue;
  if (!pairs.has(item.method)) pairs.set(item.method, new Map());
  pairs
    .get(item.method)
    .set(spot(item), rating.choice === 'same' ? 'same' : rating.choice === item.candidate ? 'win' : 'loss');
}
const current = single.get('cur') ?? new Map();
const methods = [...new Set(Object.values(key.singles).map((item) => item.method))];
const mean = (values) => (values.length ? values.reduce((s, n) => s + n, 0) / values.length : NaN);
const count = (rows, flags) =>
  rows.reduce((s, row) => s + row.flags.filter((f) => flags.includes(f)).length, 0);
const summary = (rows) => ({
  pictures: rows.length,
  ledge: count(rows, LEDGE_FLAGS),
  added: count(rows, ['added']),
  framing: count(rows, ['framing']),
  real: +mean(rows.map((row) => row.real)).toFixed(2),
  design: +mean(rows.map((row) => row.design)).toFixed(2),
});
const result = {};
for (const method of methods) {
  const own = single.get(method) ?? new Map();
  // A retry shows only the answers it changed; the others are the current method's.
  const kept = method.endsWith('+retry') ? [...current.keys()].filter((s) => !own.has(s)) : [];
  const rated = new Map([...own, ...kept.map((s) => [s, current.get(s)])]);
  // Beside the current method: the same scenes and seeds only.
  const spots = [...rated.keys()].filter((s) => current.has(s));
  const mine = summary(spots.map((s) => rated.get(s))),
    base = summary(spots.map((s) => current.get(s)));
  const outcome = pairs.get(method) ?? new Map();
  const beside = [...spots.map((s) => outcome.get(s) ?? (kept.includes(s) ? 'same' : undefined))].filter(
    Boolean,
  );
  const wins = beside.filter((o) => o === 'win').length;
  const row = {
    ...mine,
    current: base,
    pairs: {
      win: wins,
      same: beside.filter((o) => o === 'same').length,
      loss: beside.filter((o) => o === 'loss').length,
    },
  };
  if (method !== 'cur') {
    const winRate = beside.length ? wins / beside.length : NaN;
    row.winRate = +winRate.toFixed(2);
    row.criteria = {
      ledgeHalved: base.ledge === 0 ? mine.ledge === 0 : mine.ledge <= base.ledge / 2,
      realKept: mine.real >= base.real - 0.3,
      designKept: mine.design >= base.design - 0.2,
      noMoreAddedOrFraming: mine.added <= base.added && mine.framing <= base.framing,
      preferred: winRate >= 0.6,
    };
    row.passes = Object.values(row.criteria).every(Boolean);
  }
  result[method] = row;
}
// The automatic check against people: per checked picture, structures Gemma called gone and ledge flags.
const ranks = (values) => {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    for (let k = i; k <= j; k++) out[order[k].index] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
};
const spearman = (a, b) => {
  if (a.length < 3) return NaN;
  const ra = ranks(a),
    rb = ranks(b),
    m = (a.length + 1) / 2;
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i] - m) * (rb[i] - m);
    da += (ra[i] - m) ** 2;
    db += (rb[i] - m) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
};
const auto = [],
  human = [];
for (const [method, rows] of single)
  for (const [where, rating] of rows) {
    const file = join(RESULTS, 'cf', method, `${where}.check.json`);
    if (!existsSync(file)) continue;
    const { checks } = JSON.parse(readFileSync(file, 'utf8'));
    auto.push(checks.filter((c) => c.present === 'no').length);
    human.push(rating.flags.filter((f) => LEDGE_FLAGS.includes(f)).length);
  }
const agreement = { pictures: auto.length, spearman: +spearman(auto, human).toFixed(2) };
// What the reviewer wrote in their own words, beside the method it was about (read by people; no score).
const notes = [];
for (const [kind, items] of [
  ['single', key.singles],
  ['pair', key.pairs],
])
  for (const [id, item] of Object.entries(items)) {
    const rating = ratings.get(id);
    if (!rating?.note) continue;
    const answer =
      kind === 'single'
        ? `real ${rating.real}, design ${rating.design}${rating.flags.length ? `, ${rating.flags.join('+')}` : ''}`
        : rating.choice === 'same'
          ? 'same'
          : rating.choice === item.candidate
            ? 'method'
            : 'current';
    notes.push({
      id,
      kind,
      method: item.method,
      scene: item.scene,
      seed: item.seed,
      answer,
      note: rating.note,
    });
  }
writeFileSync(
  join(dir, 'score.json'),
  JSON.stringify({ set, rated: ratings.size, methods: result, agreement, notes }, null, 1),
);
console.log(`${set}: ${ratings.size} ratings`);
console.table(
  Object.fromEntries(
    Object.entries(result).map(([method, row]) => [
      method,
      {
        n: row.pictures,
        ledge: `${row.ledge} (cur ${row.current.ledge})`,
        real: row.real,
        design: row.design,
        added: row.added,
        framing: row.framing,
        pairs: `${row.pairs.win}/${row.pairs.same}/${row.pairs.loss}`,
        win: row.winRate ?? '',
        passes: row.passes ?? '',
      },
    ]),
  ),
);
console.log('Gemma check vs ledge flags:', JSON.stringify(agreement));
if (notes.length) {
  console.log(`notes: ${notes.length}`);
  for (const n of notes)
    console.log(`- ${n.id} ${n.method} ${n.scene}-${n.seed} [${n.answer}] ${n.note.replace(/\s+/g, ' ')}`);
}
