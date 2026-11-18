// The fixture-material trial's blind review set (no AI call, docs/fixture-material-20261118.md), for the
// ledge trial's screen (tests/ledge-ai/review): whole pictures (the reviewer's ask 11-17: "평가
// 이미지를 전체로 보여줘"), the design beside the baseline (--base, default o1) against the candidate
// (--keep), half of the pairs with the baseline on the A side, in random order, names blind.
//
//   node tests/fixture-material/review-build.mjs --set m1 --keep p1 --base sb5lkf --ids a,b,c
//   node tests/ledge-ai/review/server.mjs --root fixture-material-20261118 --set m1 --port 8794
// Output: test-results/fixture-material-20261118/review/<set>/items.json, key.json, pic/
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { OUT, SHADOWS, STREAKS } from './paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const keep = arg('keep'),
  base = arg('base', 'o1');
const ids = arg('ids').split(',').filter(Boolean);
if (!keep || !ids.length) throw new Error('--keep <rule> --ids a,b');

let state = 20261119;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let k = list.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
};
// --keep may name several candidates (a,b): one pair per picture and candidate.
const pairs = shuffle(ids.flatMap((source) => keep.split(',').map((candidate) => ({ source, candidate, base }))));
const sides = shuffle(pairs.map((_, k) => k < pairs.length / 2));
for (const [k, pair] of pairs.entries()) pair.a = sides[k] ? base : pair.candidate;

const dir = join(OUT, 'review', set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const picture = (id, rule) => {
  const file = [join(OUT, 'pictures'), join(SHADOWS, 'pictures'), join(STREAKS, 'pictures')]
    .map((d) => join(d, `${id}.${rule}.png`))
    .find((f) => existsSync(f));
  if (!file) throw new Error(`no picture ${id}.${rule}`);
  return file;
};
const copy = async (id, rule, file) => {
  await sharp(picture(id, rule)).png().toFile(file);
  return rel(file);
};
const name = (k) => `${set}-p${String(k + 1).padStart(3, '0')}`;
const items = [];
const designs = new Map();
for (const [k, pair] of pairs.entries()) {
  if (!designs.has(pair.source))
    designs.set(pair.source, await copy(pair.source, 'ref', join(dir, 'pic', `design-${pair.source}.png`)));
  const b = pair.a === base ? pair.candidate : base;
  items.push({
    id: name(k),
    design: designs.get(pair.source),
    a: await copy(pair.source, pair.a, join(dir, 'pic', `${name(k)}-a.png`)),
    b: await copy(pair.source, b, join(dir, 'pic', `${name(k)}-b.png`)),
  });
}
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      title: 'AI 결과 도기 재질 평가',
      flags: [],
      pairQuestion: '어느 쪽 도기(변기·세면대·욕조)가 더 자연스럽고 사진 같나',
      pairHint:
        '도기(변기·세면대·욕조)만 보고 골라 주세요. 벽 밝기·빛 등 다른 차이는 빼고 봐 주세요. 금속처럼 반짝이거나 다른 물건(수건걸이·휴지걸이 같은 금속 기구)으로 보이는 도기가 있는지 봐 주세요. 반대로 도기가 붙여 넣은 그림처럼 평평하거나 어색한지도 봐 주세요. 느낀 점은 글로 적어 주세요.',
      singles: [],
      pairs: items,
    },
    null,
    1,
  ),
);
writeFileSync(
  join(dir, 'key.json'),
  JSON.stringify({ pairs: Object.fromEntries(pairs.map((p, k) => [name(k), p])) }, null, 1),
);
console.log(`${set}: ${pairs.length} pairs, about ${Math.round((pairs.length * 10) / 60)} min`);
