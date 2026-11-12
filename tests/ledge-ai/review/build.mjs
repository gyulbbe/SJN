// The review items of one set of the ledge AI trial (no AI call, docs/ledge-ai-trials-20261111.md):
// first every result on its own beside the picture it was made from, then each method's result beside
// the current method's for the same scene and seed. The order is fixed (seeded) and blind: which
// method made which picture, and which side of a pair is the current method, stay in key.json, which
// the server never serves.
//
//   node tests/ledge-ai/review/build.mjs --set r4 [--holdout]
// Output: test-results/ledge-ai-20261111/review/<set>/items.json, key.json
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HOLDOUT, OUT, RESULTS, REVIEW, SCENES } from '../paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'r4');
const holdout = process.argv.includes('--holdout');
/** The sets: the methods of round 3 on the development scenes; the chosen ones on the held-out two. */
const SETS = {
  r4: {
    scenes: ['thin-l', 'thin-l-dark', 'full-back', 'floating', 'stair', 'structure', 'deep'],
    methods: ['cur', 'w-step', 'w-plinth', 'elev', 'w-step+elev', 'cur+restore', 'cur+retry'],
  },
  r5: { scenes: ['brick-l', 'busy'], methods: (arg('methods', 'cur') ?? 'cur').split(',') },
};
const plan = SETS[set];
if (!plan) throw new Error(`unknown set ${set}`);
const seeds = [424242, 777001];
const rel = (path) => relative(OUT, path).replace(/\\/g, '/');
const sceneDir = (scene) => join(holdout ? HOLDOUT : SCENES, scene);
const file = (method, scene, seed) => join(RESULTS, 'cf', method, `${scene}-${seed}.png`);
/** The picture a method's result was made from: the level capture, or the one from above. */
const made = (method, scene) =>
  join(sceneDir(scene), method.split('+').includes('elev') ? 'elev' : '', 'capture.png');
/** A retry that kept the first answer is that answer: not shown twice. */
const same = (method, scene, seed) => {
  if (!method.endsWith('+retry')) return false;
  const note = join(RESULTS, 'cf', method, `${scene}-${seed}.json`);
  return existsSync(note) && JSON.parse(readFileSync(note, 'utf8')).kept === true;
};

let state = 20261112;
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
for (const scene of plan.scenes)
  for (const seed of seeds) {
    const shown = plan.methods.filter(
      (method) => existsSync(file(method, scene, seed)) && !same(method, scene, seed),
    );
    for (const method of shuffle([...shown]))
      singles.push({
        method,
        scene,
        seed,
        design: rel(made(method, scene)),
        result: rel(file(method, scene, seed)),
      });
    if (!shown.includes('cur')) continue;
    for (const method of shuffle(shown.filter((m) => m !== 'cur'))) {
      const first = random() < 0.5;
      pairs.push({
        method,
        scene,
        seed,
        design: rel(made('cur', scene)),
        // The side the candidate is on.
        candidate: first ? 'a' : 'b',
        a: rel(file(first ? method : 'cur', scene, seed)),
        b: rel(file(first ? 'cur' : method, scene, seed)),
      });
    }
  }
const dir = join(REVIEW, set);
mkdirSync(join(dir, 'pic'), { recursive: true });
const id = (kind, index) => `${set}-${kind}${String(index + 1).padStart(3, '0')}`;
/** A result under a name that says nothing of its method. */
const blind = (name, path) => {
  const copy = join(dir, 'pic', `${name}.png`);
  copyFileSync(join(OUT, path), copy);
  return rel(copy);
};
const structures = (scene) =>
  JSON.parse(readFileSync(join(sceneDir(scene), 'structures.json'), 'utf8')).some((s) => s.kind === 'niche');
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    {
      set,
      singles: singles.map((item, i) => ({
        id: id('s', i),
        design: item.design,
        result: blind(id('s', i), item.result),
        niche: structures(item.scene),
      })),
      pairs: pairs.map((item, i) => ({
        id: id('p', i),
        design: item.design,
        a: blind(`${id('p', i)}-a`, item.a),
        b: blind(`${id('p', i)}-b`, item.b),
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
      singles: Object.fromEntries(
        singles.map((item, i) => [id('s', i), { method: item.method, scene: item.scene, seed: item.seed }]),
      ),
      pairs: Object.fromEntries(
        pairs.map((item, i) => [
          id('p', i),
          { method: item.method, scene: item.scene, seed: item.seed, candidate: item.candidate },
        ]),
      ),
    },
    null,
    1,
  ),
);
console.log(
  `${set}: ${singles.length} pictures and ${pairs.length} pairs, about ${Math.round((singles.length * 12 + pairs.length * 6) / 60)} min`,
);
