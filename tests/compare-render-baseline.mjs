/**
 * Compares a render capture folder with its baseline.
 * Usage: node tests/compare-render-baseline.mjs <baselineDir> <dir> [--shadows-only]
 * Every image with "compositor" in its name (the 2D path) must match exactly. With --shadows-only,
 * other images may differ only by getting darker (added cast shadows): any brighter pixel fails.
 * Without it every image must match exactly.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const [baselineDir, dir] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const shadowsOnly = process.argv.includes('--shadows-only');
if (!baselineDir || !dir)
  throw new Error('usage: compare-render-baseline.mjs <baselineDir> <dir> [--shadows-only]');

let failed = 0;
const rows = [];
for (const file of readdirSync(baselineDir)
  .filter((f) => /\.(png|jpe?g)$/.test(f))
  .sort()) {
  const other = join(dir, file);
  if (!existsSync(other)) {
    rows.push({ file, result: 'missing' });
    failed++;
    continue;
  }
  const a = await sharp(join(baselineDir, file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(other).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    rows.push({ file, result: 'size' });
    failed++;
    continue;
  }
  let maxDiff = 0,
    brighter = 0,
    darker = 0;
  const pixels = a.info.width * a.info.height;
  for (let i = 0; i < pixels; i++) {
    let up = 0,
      down = 0;
    for (let c = 0; c < 3; c++) {
      const delta = b.data[i * 3 + c] - a.data[i * 3 + c];
      up = Math.max(up, delta);
      down = Math.max(down, -delta);
    }
    maxDiff = Math.max(maxDiff, up, down);
    // One level of rounding either way is not a change.
    if (up > 1) brighter++;
    if (down > 1) darker++;
  }
  const exact = file.includes('compositor') || !shadowsOnly;
  const ok = exact ? maxDiff === 0 : brighter === 0;
  if (!ok) failed++;
  rows.push({
    file,
    result: ok ? 'ok' : 'FAIL',
    rule: exact ? 'identical' : 'darker only',
    maxDiff,
    brighterPixels: brighter,
    darkerShare: Number((darker / pixels).toFixed(4)),
  });
}
console.table(rows);
console.log(`${rows.length} images, ${failed} failed`);
process.exit(failed ? 1 : 0);
