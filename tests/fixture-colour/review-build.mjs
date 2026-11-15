// The fixture-colour trial's review set (no AI call, docs/fixture-colour-20261115.md), for the ledge
// trial's screen (tests/ledge-ai/review): pairs beside the design, the app as it is (P0) against a
// candidate, sides at random, names blind:
//   - W1 (the ceramics' lightness back) on every picture it changed (over 0.5% of pixels);
//   - W2+W1 (the model input with the ceramics lifted, then W1) on every added-objects scene and seed.
// The reviewer picks the one whose toilet and washbasin look more like the design and writes notes.
//
//   node tests/fixture-colour/review-build.mjs --set f1
//   node tests/ledge-ai/review/server.mjs --root fixture-colour-20261115 --set f1 --port 8794
// Output: test-results/fixture-colour-20261115/review/<set>/items.json, key.json, pic/
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OUT, REVIEW } from './paths.mjs';

const i = process.argv.indexOf('--set');
const set = i > 0 ? process.argv[i + 1] : 'f1';
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const rows = JSON.parse(readFileSync(join(OUT, 'pictures-dev.json'), 'utf8')).filter((r) => r.aligned);
let state = 20261116;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let k = list.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
};
const picture = (id, rule) => join(OUT, 'pictures', `${id}.${rule}.png`);
const pairs = [];
for (const row of rows) {
  if (row.changedShare > 0.005) pairs.push({ source: row.id, candidate: 'w1' });
  if (existsSync(picture(row.id, 'w2w1'))) pairs.push({ source: row.id, candidate: 'w2w1' });
}
shuffle(pairs);
for (const pair of pairs) pair.a = random() < 0.5 ? 'p0' : pair.candidate;
const dir = join(REVIEW, set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const byId = new Map(rows.map((row) => [row.id, row]));
const id = (k) => `${set}-p${String(k + 1).padStart(3, '0')}`;
const items = pairs.map((pair, k) => {
  const design = join(dir, 'pic', `design-${pair.source}.png`);
  copyFileSync(byId.get(pair.source).design, design);
  const b = pair.a === 'p0' ? pair.candidate : 'p0';
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
      title: '세면대·변기 색 평가',
      flags: [],
      pairQuestion: '어느 쪽 세면대·변기가 내 설계(흰 도기)에 더 가깝고 자연스럽나',
      pairHint:
        '세면대·변기·욕조의 색과 밝기, 둘레에 테두리·얼룩이 없는지를 봐 주세요. 느낀 점은 글로 적어 주세요.',
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
