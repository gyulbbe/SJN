// The AI-light trial's review set (no AI call, docs/ai-light-20261115.md), for the ledge trial's
// screen (tests/ledge-ai/review): pairs beside the design, the app as it is (k100, all of the
// model's light shape) against a candidate, sides at random, names blind:
//   - k50 (half of the light difference kept) on every development picture;
//   - k25 (a quarter) on the half with the strongest light spread today.
// The reviewer picks the one whose light looks more natural and writes notes.
//
//   node tests/ai-light/review-build.mjs --set l1
//   node tests/ledge-ai/review/server.mjs --root ai-light-20261115 --set l1 --port 8794
// Output: test-results/ai-light-20261115/review/<set>/items.json, key.json, pic/
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OUT, REVIEW } from './paths.mjs';

const i = process.argv.indexOf('--set');
const set = i > 0 ? process.argv[i + 1] : 'l1';
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const holdout = process.argv.includes('--holdout');
const rows = JSON.parse(
  readFileSync(join(OUT, `pictures-${holdout ? 'holdout' : 'dev'}.json`), 'utf8'),
).filter((r) => r.aligned);
const candidates = (process.argv.includes('--keep') ? process.argv[process.argv.indexOf('--keep') + 1] : '')
  .split(',')
  .filter(Boolean);
let state = 20261115;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let k = list.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
};
const mean = (row) => row.k100.faces.reduce((t, f) => t + f.spread, 0) / row.k100.faces.length;
const strong = new Set(
  [...rows]
    .sort((x, y) => mean(y) - mean(x))
    .slice(0, Math.ceil(rows.length / 2))
    .map((r) => r.id),
);
const picture = (id, rule) => join(OUT, 'pictures', `${id}.${rule}.png`);
const pairs = [];
for (const row of rows) {
  if (candidates.length) {
    for (const candidate of candidates) pairs.push({ source: row.id, candidate });
    continue;
  }
  pairs.push({ source: row.id, candidate: 'k50' });
  if (strong.has(row.id)) pairs.push({ source: row.id, candidate: 'k25' });
}
shuffle(pairs);
for (const pair of pairs) pair.a = random() < 0.5 ? 'k100' : pair.candidate;
const dir = join(REVIEW, set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const byId = new Map(rows.map((row) => [row.id, row]));
const id = (k) => `${set}-p${String(k + 1).padStart(3, '0')}`;
const items = pairs.map((pair, k) => {
  const design = join(dir, 'pic', `design-${pair.source}.png`);
  copyFileSync(byId.get(pair.source).design, design);
  const b = pair.a === 'k100' ? pair.candidate : 'k100';
  const copy = (side, rule) => {
    const file = join(dir, 'pic', `${id(k)}-${side}.png`);
    copyFileSync(picture(pair.source, rule), file);
    return rel(file);
  };
  return { id: id(k), design: rel(design), a: copy('a', pair.a), b: copy('b', b) };
});
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      title: 'AI 결과 빛 평가',
      flags: [],
      pairQuestion: '어느 쪽 빛(밝은 줄기·그림자·비침)이 더 자연스럽고 사진 같나',
      pairHint:
        '창빛 같은 대각선 줄기, 없던 큰 그림자, 너무 센 비침이 있는지, 반대로 너무 평평하거나 가짜 같은지를 봐 주세요. 느낀 점은 글로 적어 주세요.',
      singles: [],
      pairs: items,
    },
    null,
    1,
  ),
);
writeFileSync(
  join(dir, 'key.json'),
  JSON.stringify({ pairs: Object.fromEntries(pairs.map((p, k) => [id(k), p])) }, null, 1),
);
console.log(`${set}: ${pairs.length} pairs, about ${Math.round((pairs.length * 8) / 60)} min`);
