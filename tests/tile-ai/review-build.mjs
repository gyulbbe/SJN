// The review items of one set of the tile AI trial (no AI call, docs/tile-ai-trials-20261113.md):
// first every result on its own beside the app picture it was made from, then each method's result
// beside the current method's for the same scene and seed. The pictures are the results as the app
// shows them (post.ts, .fixed.png). The order is fixed (seeded) and blind: which method made which
// picture, and which side of a pair is the current method, stay in key.json, which the server never
// serves. The screen itself is the ledge trial's (tests/ledge-ai/review), given this trial's folder,
// flags and questions.
//
//   node tests/tile-ai/review-build.mjs --set t4 --methods cur,grout,sample [--scenes a,b] [--holdout]
//   node tests/ledge-ai/review/server.mjs --root tile-ai-20261113 --set t4 --port 8794
// Output: test-results/tile-ai-20261113/review/<set>/items.json, key.json, pic/
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HOLDOUT, OUT, RESULTS, REVIEW, SCENES } from './paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 't4');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const holdout = process.argv.includes('--holdout');
const group = arg('group', 'cf');
const methods = arg('methods', 'cur').split(',').filter(Boolean);
const scenes = arg(
  'scenes',
  holdout ? 'roman,small' : 'scored,patchwork,marble,charcoal,subway,beige,large,accent',
).split(',');
const seeds = arg('seeds', '424242,777001').split(',').map(Number);
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const design = (scene) => join(holdout ? HOLDOUT : SCENES, scene, 'capture.png');
const file = (method, scene, seed) => join(RESULTS, group, method, `${scene}-${seed}.fixed.png`);

let state = 20261113;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
const singles = [],
  pairs = [];
// One block a scene and seed, so stopping early leaves whole blocks.
for (const scene of scenes)
  for (const seed of seeds) {
    const shown = methods.filter((method) => existsSync(file(method, scene, seed)));
    for (const method of shuffle([...shown])) singles.push({ method, scene, seed });
    if (!shown.includes('cur')) continue;
    for (const method of shuffle(shown.filter((m) => m !== 'cur')))
      pairs.push({ method, scene, seed, candidate: random() < 0.5 ? 'a' : 'b' });
  }
const dir = join(REVIEW, set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const id = (kind, index) => `${set}-${kind}${String(index + 1).padStart(3, '0')}`;
/** A result under a name that says nothing of its method. */
const blind = (name, path) => {
  const copy = join(dir, 'pic', `${name}.png`);
  copyFileSync(path, copy);
  return rel(copy);
};
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      title: '타일 AI 변환 평가',
      // What the reviewer can mark on one picture; the first two are the tile problems of criterion 1.
      flags: [
        ['joints', '줄눈 위치·타일 크기가 바뀜'],
        ['pattern', '타일 무늬가 없어지거나 달라짐'],
        ['colour', '타일 색이 바뀜'],
        ['glare', '비침이 너무 심함'],
        ['added', '없던 물건이 생김'],
        ['framing', '구도가 바뀜'],
      ],
      pairQuestion: '어느 쪽 타일이 내 설계 같나',
      pairHint: '타일의 줄눈 위치·크기·무늬를 중심으로 봐 주세요.',
      singles: singles.map((item, i) => ({
        id: id('s', i),
        design: rel(design(item.scene)),
        result: blind(id('s', i), file(item.method, item.scene, item.seed)),
      })),
      pairs: pairs.map((item, i) => {
        const first = item.candidate === 'a';
        return {
          id: id('p', i),
          design: rel(design(item.scene)),
          a: blind(`${id('p', i)}-a`, file(first ? item.method : 'cur', item.scene, item.seed)),
          b: blind(`${id('p', i)}-b`, file(first ? 'cur' : item.method, item.scene, item.seed)),
        };
      }),
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
  `${set}: ${singles.length} pictures and ${pairs.length} pairs, about ${Math.round((singles.length * 12 + pairs.length * 6) / 60)} min`,
);
