// Backlog item 10, step 45: the app's refine after CUT_RESCUE became the default (refine.ts --suffix
// app45, no tuning) against the adopted trial pictures (--suffix g1), byte for byte (decoded RGBA).
//   node tests/cutout-haze/same.mjs [appSuffix] [trialSuffix]
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

const [app = 'app45', trial = 'g1'] = process.argv.slice(2);
const TREES = [
  'big-fixture-20261124/app',
  'basin-shape-20261124/app',
  'olive-dark-cf-20261125/cur',
  'photo-colour-20261126/cur',
  'side-tile-ai-20261121/after',
  'room-depth-20261123/cf/app',
];
let same = 0,
  differ = 0;
for (const tree of TREES) {
  const root = join(ROOT, 'test-results', ...tree.split('/'));
  const dir = join(root, `refined-${app}`);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    const [a, b] = await Promise.all(
      [join(dir, file), join(root, `refined-${trial}`, file)].map((p) =>
        sharp(p).ensureAlpha().raw().toBuffer(),
      ),
    );
    if (a.equals(b)) same++;
    else {
      differ++;
      console.log('differs', tree, file);
    }
  }
}
console.log({ same, differ });
