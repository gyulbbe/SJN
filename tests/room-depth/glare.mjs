// Backlog item 2: did the corner shade make glossy walls glare more? A rough measure on the finished
// pictures: per picture, the share of wall pixels brighter than the walls' median L* + 15 and the 99th
// percentile above the median (bright grout lines count too, so compare like with like only).
// Usage: [SIDE_TILE_OUT=<tree>] node tests/room-depth/glare.mjs --revs after,app [--seeds 424242]
// Output: stdout, and test-results/room-depth-20261123/glare-<tree>-<revs>.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { OUT as TRIAL, ROOT } from '../side-tile-ai/paths.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const revs = arg('revs', 'after,app').split(',');
const seeds = arg('seeds', '424242,777001').split(',');
const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lstar = (r, g, b) => {
  const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
};
const out = {};
for (const rev of revs)
  for (const scene of ['olive-0', 'olive-90', 'black-0', 'beige-90', 'white-0'])
    for (const seed of seeds) {
      const dir = join(TRIAL, rev, 'scenes', scene);
      const file = join(TRIAL, rev, 'refined', `${scene}-${seed}.png`);
      if (!existsSync(file)) continue;
      const img = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width: w, height: h } = img.info;
      const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')).regions;
      const saved = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8'));
      const L = saved.layout ?? saved;
      const m = await sharp(join(dir, 'mask.png'))
        .extractChannel(0)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const cw = m.info.width,
        ch = m.info.height;
      const vals = [];
      for (let v = 0; v < h; v++) {
        const y = Math.floor((((v + 0.5) * L.height) / h - L.y) * (ch / L.contentHeight));
        for (let u = 0; u < w; u++) {
          const x = Math.floor((((u + 0.5) * L.width) / w - L.x) * (cw / L.contentWidth));
          if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
          const k = m.data[y * cw + x];
          if (!k || k === 255 || regions[k - 1]?.kind !== 'wall') continue;
          const i = (v * w + u) * 3;
          vals.push(lstar(img.data[i], img.data[i + 1], img.data[i + 2]));
        }
      }
      vals.sort((a, b) => a - b);
      const median = vals[vals.length >> 1];
      const p99 = vals[Math.floor(vals.length * 0.99)];
      (out[rev] ??= []).push({
        id: `${scene}-${seed}`,
        p99: +(p99 - median).toFixed(1),
        bright: +((100 * vals.filter((x) => x > median + 15).length) / vals.length).toFixed(2),
      });
    }
for (const [rev, rows] of Object.entries(out)) {
  const avg = (k) => (rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(2);
  console.log(`${rev} n=${rows.length} p99−median ${avg('p99')} bright% ${avg('bright')}`);
  for (const r of rows) console.log(`  ${r.id} ${r.p99} ${r.bright}`);
}
writeFileSync(
  join(ROOT, 'test-results', 'room-depth-20261123', `glare-${basename(TRIAL)}-${revs.join('-')}.json`),
  JSON.stringify(out, null, 1),
);
