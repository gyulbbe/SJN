// Backlog item 4, step 35: the app's refine after FACE_LIGHTNESS_BAND 0 (refine.ts --suffix app35, no
// tuning) against the adopted trial pictures (refine.ts --tuning '{"lightnessBand":0}' --suffix b0) of
// the same saved answers, byte for byte (decoded RGBA).
//   node tests/olive-light/same.mjs
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { TREES } from './faces.mjs';

let same = 0,
  differ = 0;
for (const tree of TREES)
  for (const file of readdirSync(join(tree.dir, 'refined-app35')).filter((f) => f.endsWith('.png'))) {
    const trial = join(tree.dir, 'refined-b0', file);
    if (!existsSync(trial)) continue;
    const [a, b] = await Promise.all(
      [join(tree.dir, 'refined-app35', file), trial].map((p) => sharp(p).ensureAlpha().raw().toBuffer()),
    );
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    if (a.length === b.length && n === 0) same++;
    else {
      differ++;
      console.log(tree.name, file, 'differs', n);
    }
  }
console.log({ same, differ });
