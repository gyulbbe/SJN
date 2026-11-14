// The blind review set of the added-objects trial (no AI call, docs/extra-ai-trials-20261114.md): every
// result as the app shows it (post.ts, .app.png) beside the design it was made from, one picture once
// (methods that kept the same picture, such as O2 without a retry, share one item). The order is
// fixed (seeded) and blind: which methods made a picture stays in key.json, which the server never
// serves. `--pick` makes the user's check set instead: the listed ids of another set, shuffled again
// under new names. The screen is the ledge trial's (tests/ledge-ai/review).
//
//   node tests/extra-ai/review-build.mjs --set r2 --methods cur,names-end,cur+o2 [--holdout]
//   node tests/extra-ai/review-build.mjs --set u12 --pick r2:r2-s003,r2-s010,...
//   node tests/ledge-ai/review/server.mjs --root extra-ai-20261114 --set r2 --port 8794
// Output: test-results/extra-ai-20261114/review/<set>/items.json, key.json, pic/
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HOLDOUT, OUT, RESULTS, REVIEW, SCENES } from './paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'r2');
if (!/^[a-z0-9-]+$/.test(set)) throw new Error('--set <name>');
const holdout = process.argv.includes('--holdout');
const methods = arg('methods', 'cur').split(',').filter(Boolean);
const scenes = arg(
  'scenes',
  holdout ? 'large,side' : 'white,charcoal,pattern,partial,structure,smc,photos,narrow',
).split(',');
const seeds = arg('seeds', '424242,777001').split(',').map(Number);
const pick = arg('pick');
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const design = (scene) => join(holdout ? HOLDOUT : SCENES, scene, 'capture.png');
const file = (method, scene, seed) => join(RESULTS, 'cf', method, `${scene}-${seed}.app.png`);

let state = 20261114;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (list) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
/** Pictures to show: { path, design, jobs: [{ method, scene, seed }] }, one per distinct picture. */
let pictures = [];
if (pick) {
  const [from, ids] = pick.split(':');
  const items = JSON.parse(readFileSync(join(REVIEW, from, 'items.json'), 'utf8')).singles;
  const key = JSON.parse(readFileSync(join(REVIEW, from, 'key.json'), 'utf8')).singles;
  for (const id of ids.split(',')) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error(`no ${id} in ${from}`);
    pictures.push({
      path: join(OUT, item.result),
      design: join(OUT, item.design),
      jobs: key[id].jobs,
      from: id,
    });
  }
  shuffle(pictures);
} else {
  const byHash = new Map();
  // One block a scene and seed, so stopping early leaves whole blocks.
  for (const scene of scenes)
    for (const seed of seeds) {
      const block = [];
      for (const method of methods) {
        const path = file(method, scene, seed);
        if (!existsSync(path)) continue;
        const hash = createHash('sha1').update(readFileSync(path)).digest('hex');
        const known = byHash.get(hash);
        if (known) known.jobs.push({ method, scene, seed });
        else {
          const picture = { path, design: design(scene), jobs: [{ method, scene, seed }] };
          byHash.set(hash, picture);
          block.push(picture);
        }
      }
      pictures.push(...shuffle(block));
    }
}
const dir = join(REVIEW, set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const id = (index) => `${set}-s${String(index + 1).padStart(3, '0')}`;
const singles = pictures.map((picture, i) => {
  const copy = join(dir, 'pic', `${id(i)}.png`);
  copyFileSync(picture.path, copy);
  return { id: id(i), design: rel(picture.design), result: rel(copy) };
});
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      title: 'AI 변환 "없던 물건" 평가',
      flags: [
        ['added', '없던 물건이 생김'],
        ['product', '놓은 제품이 사라지거나 바뀜'],
        ['smudge', '얼룩·지운 자국이 보임'],
        ['joints', '줄눈·무늬가 바뀜'],
        ['framing', '구도가 바뀜'],
      ],
      singles,
      pairs: [],
    },
    null,
    1,
  ),
);
writeFileSync(
  join(dir, 'key.json'),
  JSON.stringify(
    {
      singles: Object.fromEntries(
        pictures.map((picture, i) => [
          id(i),
          { jobs: picture.jobs, ...(picture.from ? { from: picture.from } : {}) },
        ]),
      ),
    },
    null,
    1,
  ),
);
console.log(
  `${set}: ${singles.length} pictures (${pictures.reduce((n, p) => n + p.jobs.length, 0)} results), about ${Math.round((singles.length * 15) / 60)} min`,
);
