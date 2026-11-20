// The fixture-glare trial's blind review set (no AI call, docs/fixture-glare-20261119.md), for the
// ledge trial's screen (tests/ledge-ai/review): whole pictures (the reviewer's ask 11-17: "평가
// 이미지를 전체로 보여줘"), the design beside the baseline (--base, default o1) against the candidate
// (--keep), half of the pairs with the baseline on the A side, in random order, names blind.
//
//   node tests/fixture-glare/review-build.mjs --set g1 --keep soft,nometal,baseg1 --base base --ids a,b,c
//   node tests/ledge-ai/review/server.mjs --root fixture-glare-20261119 --set g1 --port 8794
// Output: test-results/fixture-glare-20261119/review/<set>/items.json, key.json, pic/
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import { MATERIAL, OUT, SHADOWS, STREAKS } from './paths.mjs';

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

let state = 20261120;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let k = list.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
};
// --keep may name several candidates (a,b): one pair per picture and candidate; `cand@base` gives that
// candidate its own baseline. Only where both pictures exist (one call was refused by the provider).
const has = (source, rule) => existsSync(join(OUT, 'pictures', `${source}.${rule}.png`));
const pairs = shuffle(
  ids.flatMap((source) =>
    keep
      .split(',')
      .map((entry) => entry.split('@'))
      .map(([candidate, own]) => ({ source, candidate, base: own ?? base }))
      .filter((pair) => has(pair.source, pair.candidate) && (pair.base === 'base' || has(pair.source, pair.base))),
  ),
);
const sides = shuffle(pairs.map((_, k) => k < pairs.length / 2));
for (const [k, pair] of pairs.entries()) pair.a = sides[k] ? pair.base : pair.candidate;

const dir = join(OUT, 'review', set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const picture = (id, rule) => {
  const file = [join(OUT, 'pictures'), join(MATERIAL, 'pictures'), join(SHADOWS, 'pictures'), join(STREAKS, 'pictures')]
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
  const b = pair.a === pair.base ? pair.candidate : pair.base;
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
      title: 'AI 결과 도기 비침 평가',
      flags: [],
      pairQuestion: '어느 쪽 유광 자재(도기·유광 타일)의 빛 비침이 더 적고 자연스럽나',
      pairHint:
        '유광 자재(변기·세면대·욕조, 유광 타일)의 빛 비침·반짝임·반사를 위주로 봐 주세요. 제품이 다른 물건으로 바뀌었거나 평평하고 어색하면 글로 적어 주세요.',
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
