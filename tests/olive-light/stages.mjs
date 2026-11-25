// Backlog item 4, step 35: where the olive wall's remaining lightness comes from after band 0. For the
// saved olive answers (Cloudflare 4, local 8), each wall's and the floor's mean L* minus the design's
// after each step of today's refine (refine.ts with REFINE_STAGES=1 --suffix st35): the model's answer
// with the backdrop back (original/), after the joints step (-joints), after the colour step (-colour),
// and the shown result.
//   node tests/olive-light/stages.mjs
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { faces, TREES } from './faces.mjs';

const STAGES = [
  ['answer', 'original'],
  ['joints', 'refined-st35-joints'],
  ['colour', 'refined-st35-colour'],
  ['shown', 'refined-st35'],
];
const sums = {};
for (const tree of TREES.filter((t) => t.name !== 'big'))
  for (const file of readdirSync(join(tree.dir, 'refined-st35')).filter((f) => f.endsWith('.png'))) {
    const dir = join(tree.dir, 'scenes', file.slice(0, -4).replace(/-\d+$/, ''));
    const design = await faces(join(dir, 'capture.png'), dir);
    const cells = [];
    for (const [name, folder] of STAGES) {
      const got = await faces(join(tree.dir, folder, file), dir);
      const d = got.map((x, i) => x.L - design[i].L);
      cells.push(`${name} ${got.map((x, i) => `${x.kind[0]}${d[i].toFixed(1)}`).join(' ')}`);
      got.forEach((x, i) => {
        const key = `${tree.name} ${x.kind} ${name}`;
        (sums[key] ??= []).push(d[i]);
      });
    }
    console.log(`${tree.name}/${file.slice(0, -4)}`.padEnd(28), cells.join(' | '));
  }
for (const [key, v] of Object.entries(sums))
  console.log(key.padEnd(22), (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), `n${v.length}`);
