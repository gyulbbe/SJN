// Backlog item 8: how often the app's cut-out of a fixture carries a separate object along (a toilet
// brush beside the toilet): in each saved cut-out (refine.ts cuts/<answer>-<fixture>.png, the cut-out
// model's alpha), the opaque (alpha ≥ 128) connected pieces other than the largest that are at least 0.4%
// of the crop. No AI call.
//   node tests/extra-objects/cut-blobs.mjs
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { SETS } from './sheets.mjs';

const trees = [...SETS.map(([tree]) => tree), 'extra-objects-20261126/local/app'];
let cuts = 0;
const found = [];
for (const tree of trees) {
  const dir = join(ROOT, 'test-results', ...tree.split('/'), 'cuts');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const { data, info } = await sharp(join(dir, file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const seen = new Int32Array(w * h).fill(-1);
    const sizes = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i] >= 0 || data[i * 4 + 3] < 128) continue;
      const id = sizes.length;
      let n = 0;
      const stack = [i];
      seen[i] = id;
      while (stack.length) {
        const p = stack.pop();
        n++;
        const x = p % w,
          y = (p / w) | 0;
        for (const q of [
          x > 0 ? p - 1 : -1,
          x < w - 1 ? p + 1 : -1,
          y > 0 ? p - w : -1,
          y < h - 1 ? p + w : -1,
        ])
          if (q >= 0 && seen[q] < 0 && data[q * 4 + 3] >= 128) {
            seen[q] = id;
            stack.push(q);
          }
      }
      sizes.push(n);
    }
    cuts++;
    sizes.sort((a, b) => b - a);
    const extra = sizes.slice(1).filter((s) => s >= 0.004 * w * h);
    if (extra.length)
      found.push(
        `${tree}/${file} pieces ${extra.map((s) => ((100 * s) / (w * h)).toFixed(1) + '%').join(', ')}`,
      );
  }
}
console.log(found.join('\n'));
console.log({ cuts, withSeparatePieces: found.length });
