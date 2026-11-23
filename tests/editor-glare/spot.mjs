// Backlog item 3: how strong the ceiling light's spot is in the editor's 3D view. Each candidate's
// editor-3d.png (tests/side-tile-ai/capture.ts) against d0 (the same view with the walls' specular from
// the direct lights off): per wall pixel the L* above d0. `peak` is the largest rise, `area` how many
// pixels rise more than 5 L*; and how much of the rest of the wall changed (`other`, mean |ΔL*| away
// from the spot), so a fix that dims the whole wall shows.
// Usage: node tests/editor-glare/spot.mjs [--revs app,r35,r50,s30,i0]
// Output: stdout and test-results/editor-glare-20261123/spot.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT as TRIAL, ROOT } from '../side-tile-ai/paths.mjs';

const at = process.argv.indexOf('--revs');
const revs = (at > 0 ? process.argv[at + 1] : 'app,r35,r50,s30,i0').split(',');
const scenes = ['olive-0', 'black-0', 'beige-90', 'white-0'];
const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lstar = (d, i) => {
  const Y = 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
  return Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
};
const read = async (rev, scene) =>
  sharp(join(TRIAL, rev, 'scenes', scene, 'editor-3d.png'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
const out = {};
for (const scene of scenes) {
  const base = await read('d0', scene);
  const { width: w, height: h } = base.info;
  for (const rev of revs) {
    const img = await read(rev, scene);
    let peak = 0,
      area = 0,
      other = 0,
      n = 0;
    for (let i = 0; i < w * h; i++) {
      const d = lstar(img.data, i * 3) - lstar(base.data, i * 3);
      if (d > peak) peak = d;
      if (d > 5) area++;
      else {
        other += Math.abs(d);
        n++;
      }
    }
    (out[scene] ??= {})[rev] = { peak: +peak.toFixed(1), area, other: +(other / n).toFixed(2) };
  }
  console.log(
    scene.padEnd(9),
    Object.entries(out[scene])
      .map(([rev, r]) => `${rev}: peak ${r.peak} area ${r.area} other ${r.other}`)
      .join(' | '),
  );
}
writeFileSync(join(ROOT, 'test-results', 'editor-glare-20261123', 'spot.json'), JSON.stringify(out, null, 1));
