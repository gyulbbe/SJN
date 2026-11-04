// How well an automatic score ranks the graded answers (docs section 7): for each set graded by Claude
// (review/<set>/claude-ratings.json with its key.json), the AUC of DINOv2 and CLIP similarity
// (judge/<round>-embed.json) for "the same product", and the Spearman of each against usable.
//
//   node tests/direction-photo-methods/agree.mjs <round> <set,...>
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { OUT } from './paths.mjs';

const [round, sets] = process.argv.slice(2);
const embed = JSON.parse(readFileSync(join(OUT, 'judge', `${round}-embed.json`), 'utf8'));
const rows = [];
for (const set of sets.split(',')) {
  const dir = join(OUT, 'review', set);
  if (!existsSync(join(dir, 'claude-ratings.json'))) continue;
  const key = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8'));
  const ratings = JSON.parse(readFileSync(join(dir, 'claude-ratings.json'), 'utf8'));
  for (const [screen, items] of Object.entries(key)) {
    const product = screen.slice(0, screen.lastIndexOf('-'));
    for (const item of items) {
      const rating = ratings[screen]?.[item.letter];
      const score = embed[`${product}/${item.method}/${basename(item.file)}`];
      if (rating && score) rows.push({ same: rating.same === 'y', usable: rating.usable === 'y', ...score });
    }
  }
}
const auc = (name, field) => {
  const pos = rows.filter((r) => r[field]),
    neg = rows.filter((r) => !r[field]);
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a[name] > b[name] ? 1 : a[name] === b[name] ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : NaN;
};
const rank = (values) => {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
};
const spearman = (a, b) => {
  const [x, y] = [rank(a), rank(b)];
  const mx = x.reduce((s, v) => s + v, 0) / x.length,
    my = y.reduce((s, v) => s + v, 0) / y.length;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
};
console.log(
  `${rows.length} graded answers (${rows.filter((r) => r.same).length} same product, ${rows.filter((r) => r.usable).length} usable)`,
);
for (const name of ['dino', 'clip'])
  console.log(
    name,
    'AUC same',
    auc(name, 'same').toFixed(2),
    'Spearman same',
    spearman(
      rows.map((r) => r[name]),
      rows.map((r) => (r.same ? 1 : 0)),
    ).toFixed(2),
    'Spearman usable',
    spearman(
      rows.map((r) => r[name]),
      rows.map((r) => (r.usable ? 1 : 0)),
    ).toFixed(2),
  );
