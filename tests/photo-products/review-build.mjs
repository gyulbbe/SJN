// The photo-product trial's review set (no AI call, docs/photo-products-20261115.md), for the ledge
// trial's screen (tests/ledge-ai/review): pairs beside the design, a base against a candidate, sides at
// random, names blind (rules below). Set q1: the app as it is (p0) against S, P and S+P. Set q2:
// p0 against the haze fix (e), and e against S on it (se) and against S+P on the band (spb).
// The reviewer picks the one whose products look more like the ones placed and writes notes.
//
//   node tests/photo-products/review-build.mjs --set q1 [--holdout] [--pairs p0:s,p0:p,p0:sp]
//   node tests/ledge-ai/review/server.mjs --root photo-products-20261115 --set q1 --port 8794
// Output: test-results/photo-products-20261115/review/<set>/items.json, key.json, pic/
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OUT, REVIEW } from './paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'q1');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const holdout = process.argv.includes('--holdout');
const pairSpecs = arg('pairs', 'p0:s,p0:p,p0:sp')
  .split(',')
  .map((p) => p.split(':'));
const rows = JSON.parse(
  readFileSync(join(OUT, `pictures-${holdout ? 'holdout' : 'dev'}.json`), 'utf8'),
).filter((r) => r.aligned);
/**
 * A rule's picture: its method's result, finished as the app does (step p0) or with the photos back
 * (step p), from the pictures of one finishing (dir: today's, the band `-b2n`, the haze fix `-b2n-e`).
 */
const RULES = {
  p0: { method: 'cur', step: 'p0', dir: '' },
  s: { method: 's', step: 'p0', dir: '' },
  p: { method: 'cur', step: 'p', dir: '' },
  sp: { method: 's', step: 'p', dir: '' },
  e: { method: 'cur', step: 'p0', dir: '-b2n-e' },
  se: { method: 's', step: 'p0', dir: '-b2n-e' },
  spb: { method: 's', step: 'p', dir: '-b2n' },
};
const picture = (scene, seed, rule) =>
  join(OUT, `pictures${RULES[rule].dir}`, `${scene}-${RULES[rule].method}-${seed}.${RULES[rule].step}.png`);
let state = 20261117;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let k = list.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [list[k], list[j]] = [list[j], list[k]];
  }
  return list;
};
const designs = new Map(rows.map((r) => [r.scene, r.design]));
const pairs = [];
for (const scene of [...designs.keys()])
  for (const seed of [424242, 777001])
    for (const [base, candidate] of pairSpecs)
      if (existsSync(picture(scene, seed, base)) && existsSync(picture(scene, seed, candidate)))
        pairs.push({ scene, seed, base, candidate });
shuffle(pairs);
for (const pair of pairs) pair.a = random() < 0.5 ? pair.base : pair.candidate;
const dir = join(REVIEW, set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const id = (k) => `${set}-p${String(k + 1).padStart(3, '0')}`;
const items = pairs.map((pair, k) => {
  const design = join(dir, 'pic', `design-${pair.scene}.png`);
  copyFileSync(designs.get(pair.scene), design);
  const b = pair.a === pair.base ? pair.candidate : pair.base;
  const copy = (side, rule) => {
    const file = join(dir, 'pic', `${id(k)}-${side}.png`);
    copyFileSync(picture(pair.scene, pair.seed, rule), file);
    return rel(file);
  };
  return { id: id(k), design: rel(design), a: copy('a', pair.a), b: copy('b', b) };
});
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      title: '사진 제품 평가',
      flags: [],
      pairQuestion: '어느 쪽 변기·세면대가 내가 놓은 제품(왼쪽 앱 그림)에 더 가깝고 자연스럽나',
      pairHint:
        '모양이 바뀌었는지, 무엇인지 알아볼 수 있는지, 흰 제품이 회색이 되지 않았는지, 둘레에 테두리·얼룩이 없는지를 봐 주세요. 느낀 점은 글로 적어 주세요.',
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
