// The tile-pattern trial's review set (no AI call, docs/tile-pattern-trials-20261115.md), for the ledge
// trial's screen (tests/ledge-ai/review):
//   - pairs: every picture P2 changed (over 0.5% of pixels), P0 against P2 beside the design, the side
//     each sits on random: "which one's tiles are closer to my design" (criterion 1);
//   - singles: 12 of those pictures (6 from each earlier trial, picked at random) as P0 and as P2, one
//     at a time with the flags and scores (criteria 2 and 3).
// Names are blind; which rule made a picture stays in key.json, which the server never serves. The
// designs are copied in too (the screen serves only this trial's folder).
//
//   node tests/tile-pattern/review-build.mjs --set d1 [--holdout] [--singles 12]
//   node tests/ledge-ai/review/server.mjs --root tile-pattern-20261115 --set d1 --port 8794
// Output: test-results/tile-pattern-20261115/review/<set>/items.json, key.json, pic/
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OUT, REVIEW } from './paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'd1');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const holdout = process.argv.includes('--holdout');
const singlesWanted = Number(arg('singles', holdout ? '99' : '12'));
const rows = JSON.parse(readFileSync(join(OUT, `pictures-${holdout ? 'holdout' : 'dev'}.json`), 'utf8'));
const changed = rows.filter((row) => row.aligned && row.changedShare > 0.005);

let state = 20261115;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
// Singles: half from each earlier trial.
const pick = (prefix) =>
  shuffle(changed.filter((row) => row.id.startsWith(prefix))).slice(0, Math.ceil(singlesWanted / 2));
const singleRows = [...pick('t-'), ...pick('x-')];
const singles = shuffle(singleRows.flatMap((row) => ['p0', 'p2'].map((rule) => ({ source: row.id, rule }))));
const pairs = shuffle(changed.map((row) => ({ source: row.id, a: random() < 0.5 ? 'p0' : 'p2' })));

const dir = join(REVIEW, set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const byId = new Map(rows.map((row) => [row.id, row]));
const design = (source) => {
  const copy = join(dir, 'pic', `design-${source}.png`);
  copyFileSync(byId.get(source).design, copy);
  return rel(copy);
};
const blind = (name, source, rule) => {
  const copy = join(dir, 'pic', `${name}.png`);
  copyFileSync(join(OUT, 'pictures', `${source}.${rule}.png`), copy);
  return rel(copy);
};
const id = (kind, i) => `${set}-${kind}${String(i + 1).padStart(3, '0')}`;
// The design copies are named by scene, which says nothing about the rule.
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      title: '타일 무늬 되돌리기 평가',
      flags: [
        ['pattern', '타일 무늬가 없어지거나 달라짐'],
        ['joints', '줄눈 위치·타일 크기가 바뀜'],
        ['smudge', '얼룩·지운 자국이 보임'],
        ['added', '없던 물건이 생김'],
        ['framing', '구도가 바뀜'],
      ],
      pairQuestion: '어느 쪽 타일이 내 설계에 더 가깝나',
      pairHint: '타일 안의 무늬(가는 줄·대리석 결·물결)와 줄눈을 중심으로 봐 주세요.',
      singles: singles.map((item, i) => ({
        id: id('s', i),
        design: design(item.source),
        result: blind(id('s', i), item.source, item.rule),
      })),
      pairs: pairs.map((item, i) => ({
        id: id('p', i),
        design: design(item.source),
        a: blind(`${id('p', i)}-a`, item.source, item.a),
        b: blind(`${id('p', i)}-b`, item.source, item.a === 'p0' ? 'p2' : 'p0'),
      })),
    },
    null,
    1,
  ),
);
writeFileSync(
  join(dir, 'key.json'),
  JSON.stringify(
    {
      singles: Object.fromEntries(singles.map((item, i) => [id('s', i), item])),
      pairs: Object.fromEntries(pairs.map((item, i) => [id('p', i), item])),
    },
    null,
    1,
  ),
);
console.log(
  `${set}: ${singles.length} pictures and ${pairs.length} pairs, about ${Math.round((singles.length * 13 + pairs.length * 6) / 60)} min`,
);
