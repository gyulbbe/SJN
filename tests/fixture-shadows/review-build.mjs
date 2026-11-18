// The fixture-shadows trial's blind review set (no AI call, docs/fixture-shadows-20261118.md), for the
// ledge trial's screen (tests/ledge-ai/review): whole pictures (the reviewer's ask 11-17: "평가
// 이미지를 전체로 보여줘"), the design beside the baseline (--base, default o1) against the candidate
// (--keep), half of the pairs with the baseline on the A side, in random order, names blind.
//
//   node tests/fixture-shadows/review-build.mjs --set f1 --keep sb5l --ids a,b,c
//   node tests/ledge-ai/review/server.mjs --root fixture-shadows-20261118 --set f1 --port 8794
// Output: test-results/fixture-shadows-20261118/review/<set>/items.json, key.json, pic/
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { OUT, STREAKS } from './paths.mjs';

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

let state = 20261118;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let k = list.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
};
const pairs = shuffle(ids.map((source) => ({ source, candidate: keep, base })));
const sides = shuffle(pairs.map((_, k) => k < pairs.length / 2));
for (const [k, pair] of pairs.entries()) pair.a = sides[k] ? base : keep;

const dir = join(OUT, 'review', set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const picture = (id, rule) => {
  const file = [join(OUT, 'pictures'), join(STREAKS, 'pictures')]
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
  const b = pair.a === base ? keep : base;
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
      title: 'AI 결과 제품 둘레·그림자 평가',
      flags: [],
      pairQuestion: '어느 쪽 제품(욕조·변기·세면대)과 그 둘레가 더 자연스럽고 사진 같나',
      pairHint:
        '제품 둘레의 검은 테두리·아지랑이·진한 그림자, 제품 몸통의 회색·그을림·심한 비침을 봐 주세요. 반대로 제품이 떠 보이거나, 평평하거나, 앱 그림처럼 보이거나, 깨진 곳이 생겼는지도 봐 주세요. 느낀 점은 글로 적어 주세요.',
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
