// Backlog item 9, step 39 (no AI call): the shower set the model drew under each sentence, from the app's
// cut-out of the answer (refine.ts writes cuts/<scene>-<seed>-<fixture>.png, the model's fixture with its
// alpha): the opaque pixels' (alpha above 200) median L*, chroma and their count (how much shower is left;
// thin parts lost show as fewer pixels). The design's shower is the photo's (#8d8a87, L* 57.6).
//   node tests/photo-colour/shower-stats.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, WORDS } from './variants.mjs';

const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const lab = (r, g, b) => {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B,
    Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const median = (v) => [...v].sort((p, q) => p - q)[v.length >> 1];
for (const file of readdirSync(join(OUT, 'cur', 'raw')).filter((x) => x.endsWith('.png'))) {
  const id = file.slice(0, -4);
  const scene = id.replace(/-\d+$/, '');
  const fixtures = JSON.parse(readFileSync(join(OUT, 'cur', 'scenes', scene, 'grounding.json'), 'utf8')).scene
    .fixtures;
  const index = fixtures.findIndex((x) => x.kind === 'shower');
  const cells = [];
  for (const rev of Object.keys(WORDS)) {
    const { data } = await sharp(join(OUT, rev, 'cuts', `${id}-${index}.png`))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const L = [],
      C = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] <= 200) continue;
      const [l, a, b] = lab(data[i], data[i + 1], data[i + 2]);
      L.push(l);
      C.push(Math.hypot(a, b));
    }
    cells.push(`${rev} L${median(L).toFixed(1)} C${median(C).toFixed(1)} n${L.length}`);
  }
  console.log(id.padEnd(24), cells.join(' | '));
}
