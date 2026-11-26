// Backlog item 10: which finished pictures a trial outline step actually changes against today's refine
// (refine.ts --suffix h43), byte for byte, over the saved answers of step 43.
//   node tests/cutout-haze/changed.mjs g1
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

const suffix = process.argv[2] ?? 'g1';
const TREES = [
  'big-fixture-20261124/app',
  'basin-shape-20261124/app',
  'olive-dark-cf-20261125/cur',
  'photo-colour-20261126/cur',
  'side-tile-ai-20261121/after',
  'room-depth-20261123/cf/app',
];
let same = 0;
const changed = [];
for (const tree of TREES) {
  const root = join(ROOT, 'test-results', ...tree.split('/'));
  const dir = join(root, `refined-${suffix}`);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    const [a, b] = await Promise.all(
      [join(root, 'refined-h43', file), join(dir, file)].map((p) => sharp(p).ensureAlpha().raw().toBuffer()),
    );
    let n = 0;
    for (let i = 0; i < a.length; i += 4)
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    if (n) changed.push(`${tree}/${file} ${n} px`);
    else same++;
  }
}
console.log(changed.join('\n'));
console.log({ same, changed: changed.length });
