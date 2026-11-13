// Scores a reviewed set of the tile AI trial against the criteria written before the rounds
// (docs/tile-ai-trials-20261113.md, section 2): each method beside the current one on the same scenes
// and seeds. No AI call.
//
//   node tests/tile-ai/review-score.mjs --set t4 [--group cf]
// Output: the table on the console and test-results/tile-ai-20261113/review/<set>/score.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, REVIEW } from './paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 't4');
const group = arg('group', 'cf');
const dir = join(REVIEW, set);
const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
// The last rating of an id counts ("이전 것 다시 평가").
const ratings = new Map();
if (existsSync(join(dir, 'ratings.jsonl')))
  for (const line of readFileSync(join(dir, 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    ratings.set(row.id, row);
  }
/** Criterion 1's flags, and the scenes of criterion 5. */
const TILE_FLAGS = ['joints', 'pattern'];
const CONTROLS = ['beige', 'large'];
/** Criterion 6: a call may cost this many times the current method's. */
const COST_TIMES = 1.5;
const spot = (item) => `${item.scene}-${item.seed}`;
/** method → scene-seed → the rating of its picture. */
const single = new Map();
for (const [id, item] of Object.entries(key.singles)) {
  const rating = ratings.get(id);
  if (!rating) continue;
  if (!single.has(item.method)) single.set(item.method, new Map());
  single.get(item.method).set(spot(item), { ...rating, scene: item.scene });
}
const pairs = new Map();
for (const [id, item] of Object.entries(key.pairs)) {
  const rating = ratings.get(id);
  if (!rating) continue;
  if (!pairs.has(item.method)) pairs.set(item.method, []);
  pairs
    .get(item.method)
    .push(rating.choice === 'same' ? 'same' : rating.choice === item.candidate ? 'win' : 'loss');
}
const current = single.get('cur') ?? new Map();
const methods = [...new Set(Object.values(key.singles).map((item) => item.method))];
const mean = (values) => (values.length ? values.reduce((s, n) => s + n, 0) / values.length : NaN);
const count = (rows, flags) =>
  rows.reduce((s, row) => s + row.flags.filter((f) => flags.includes(f)).length, 0);
const summary = (rows) => ({
  pictures: rows.length,
  tile: count(rows, TILE_FLAGS),
  colour: count(rows, ['colour']),
  glare: count(rows, ['glare']),
  added: count(rows, ['added']),
  framing: count(rows, ['framing']),
  real: +mean(rows.map((row) => row.real)).toFixed(2),
  design: +mean(rows.map((row) => row.design)).toFixed(2),
});
/** A method's mean estimated neurons a call, from the notes beside its results. */
const cost = (method) => {
  const estimates = Object.values(key.singles)
    .filter((item) => item.method === method)
    .map((item) => join(RESULTS, group, method, `${spot(item)}.json`))
    .filter(existsSync)
    .map((file) => JSON.parse(readFileSync(file, 'utf8')).estimate)
    .filter(Number.isFinite);
  return mean(estimates);
};
const result = {};
for (const method of methods) {
  const own = single.get(method) ?? new Map();
  // Beside the current method: the same scenes and seeds only.
  const spots = [...own.keys()].filter((s) => current.has(s));
  const mine = summary(spots.map((s) => own.get(s))),
    base = summary(spots.map((s) => current.get(s)));
  const control = (rows) =>
    count(
      rows.filter((row) => CONTROLS.includes(row.scene)),
      TILE_FLAGS,
    );
  const beside = pairs.get(method) ?? [];
  const wins = beside.filter((o) => o === 'win').length;
  const row = {
    ...mine,
    current: base,
    pairs: {
      win: wins,
      same: beside.filter((o) => o === 'same').length,
      loss: beside.filter((o) => o === 'loss').length,
    },
    neurons: +cost(method).toFixed(1),
  };
  if (method !== 'cur') {
    const winRate = beside.length ? wins / beside.length : NaN;
    row.winRate = +winRate.toFixed(2);
    row.controls = {
      mine: control(spots.map((s) => own.get(s))),
      current: control(spots.map((s) => current.get(s))),
    };
    // A method made from another's result without a call (…+restore) costs what that one costs.
    const priced = Number.isFinite(row.neurons) ? row.neurons : cost(method.replace(/\+restore$/, ''));
    row.criteria = {
      tileHalved: base.tile === 0 ? mine.tile === 0 : mine.tile <= base.tile / 2,
      realKept: mine.real >= base.real - 0.3,
      noMoreAddedOrFraming: mine.added <= base.added && mine.framing <= base.framing,
      preferred: winRate >= 0.6,
      controlsKept: row.controls.mine <= row.controls.current,
      costKept: priced <= cost('cur') * COST_TIMES,
    };
    row.passes = Object.values(row.criteria).every(Boolean);
  }
  result[method] = row;
}
// The automatic joint score against people: per rated picture, its wall score beside the tile flags
// and beside the "like my design" score.
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
  flagged = [],
  design = [];
for (const [method, rows] of single)
  for (const [where, rating] of rows) {
    const file = join(RESULTS, group, method, `${where}.score.json`);
    if (!existsSync(file)) continue;
    const { wall } = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(wall)) continue;
    auto.push(wall);
    flagged.push(rating.flags.filter((f) => f === 'joints').length);
    design.push(rating.design);
  }
const agreement = {
  pictures: auto.length,
  // A kept joint should mean no "joints" flag (negative) and a higher design score (positive).
  jointFlag: +spearman(auto, flagged).toFixed(2),
  design: +spearman(auto, design).toFixed(2),
};
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
const unrated = [...Object.keys(key.singles), ...Object.keys(key.pairs)].filter((id) => !ratings.has(id));
writeFileSync(
  join(dir, 'score.json'),
  JSON.stringify({ set, rated: ratings.size, unrated, methods: result, agreement, notes }, null, 1),
);
console.log(`${set}: ${ratings.size} ratings, ${unrated.length} left`);
console.table(
  Object.fromEntries(
    Object.entries(result).map(([method, row]) => [
      method,
      {
        n: row.pictures,
        tile: `${row.tile} (cur ${row.current.tile})`,
        real: `${row.real} (${row.current.real})`,
        design: `${row.design} (${row.current.design})`,
        added: `${row.added} (${row.current.added})`,
        framing: `${row.framing} (${row.current.framing})`,
        controls: row.controls ? `${row.controls.mine} (${row.controls.current})` : '',
        pairs: `${row.pairs.win}/${row.pairs.same}/${row.pairs.loss}`,
        win: row.winRate ?? '',
        neurons: row.neurons,
        passes: row.passes ?? '',
      },
    ]),
  ),
);
for (const [method, row] of Object.entries(result))
  if (row.criteria) console.log(method, JSON.stringify(row.criteria));
console.log('joint score vs people:', JSON.stringify(agreement));
if (notes.length) {
  console.log(`notes: ${notes.length}`);
  for (const n of notes)
    console.log(`- ${n.id} ${n.method} ${n.scene}-${n.seed} [${n.answer}] ${n.note.replace(/\s+/g, ' ')}`);
}
