/**
 * How metal-like each ceramic of today's app picture looks (no AI call, docs/fixture-material-20261118.md):
 * on the pixels where the model drew it (the app's outline colourMask), 2 px in from its edge:
 * - spread: L* p90 − p10, and its ratio to the render's;
 * - dark: the share of pixels more than 20 L* under the median;
 * - bands: the mean |L* − L* blurred over 3% of the picture width| (the dark and bright bands);
 * - chroma: mean |a*| + |b*| (chrome is neutral, so is white ceramic: for the table only);
 * - refBands: the same bands on the render's fixture, and bandRatio = bands ÷ refBands.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-material/metal-score.ts [--sets new,reg,dev,bath]
 * Output: test-results/fixture-material-20261118/metal-<set>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectCapture, projectMask, rgbToLab } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { blurInside } from '../../src/lib/ai-export/joints';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
mkdirSync(OUT as string, { recursive: true });
const q = (s: Float32Array, p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
for (const set of arg('sets', 'new,reg,dev,bath').split(',') as HazeSet[]) {
  const rows = [];
  for (const source of haze(set)) {
    const loaded = await loadInput(source);
    if (!loaded) continue;
    const { input } = loaded;
    const app = refineCurrentResult(input);
    if (!app.outline || !app.shown) continue;
    const shown = app.shown;
    const { width, height } = shown;
    const n = width * height;
    const size = { width, height };
    const res = fixtureMask(app.outline.colourMask, input.fixtures);
    const ref = fixtureMask(projectMask(input.mask, input.layout, size), input.fixtures);
    const capture = projectCapture(input.capture, input.layout, size);
    const L = new Float32Array(n),
      R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      L[i] = rgbToLab(shown.data[i * 4], shown.data[i * 4 + 1], shown.data[i * 4 + 2])[0];
      R[i] = rgbToLab(capture.data[i * 4], capture.data[i * 4 + 1], capture.data[i * 4 + 2])[0];
    }
    const radius = Math.max(3, Math.round(width * 0.03));
    const ones = new Float32Array(n).fill(1);
    const fixtures = [];
    for (let k = 1; k <= res.mask.regions.length; k++) {
      const label = new Float32Array(n);
      for (let i = 0; i < n; i++) if (res.mask.data[i] === k) label[i] = 1;
      const inside = blurInside(label, ones, width, height, 2).mean;
      const blur = blurInside(L, label, width, height, radius).mean;
      const refLabel = new Float32Array(n);
      for (let i = 0; i < n; i++) if (ref.mask.data[i] === k) refLabel[i] = 1;
      const refInside = blurInside(refLabel, ones, width, height, 2).mean;
      const refBlur = blurInside(R, refLabel, width, height, radius).mean;
      let refBands = 0,
        refCount = 0;
      for (let i = 0; i < n; i++)
        if (refLabel[i] && refInside[i] >= 0.999) {
          refBands += Math.abs(R[i] - refBlur[i]);
          refCount++;
        }
      refBands /= Math.max(1, refCount);
      // Wide bands only: the picture blurred over 2 px first (thin lines such as a seat's gap fade).
      const fine = blurInside(L, label, width, height, 2).mean;
      const refFine = blurInside(R, refLabel, width, height, 2).mean;
      let wide = 0,
        refWide = 0;
      for (let i = 0; i < n; i++) {
        if (label[i] && inside[i] >= 0.999) wide += Math.abs(fine[i] - blur[i]);
        if (refLabel[i] && refInside[i] >= 0.999) refWide += Math.abs(refFine[i] - refBlur[i]);
      }
      const vals: number[] = [];
      let bands = 0,
        chroma = 0;
      for (let i = 0; i < n; i++) {
        if (!label[i] || inside[i] < 0.999) continue;
        vals.push(L[i]);
        bands += Math.abs(L[i] - blur[i]);
        const [, a, b] = rgbToLab(shown.data[i * 4], shown.data[i * 4 + 1], shown.data[i * 4 + 2]);
        chroma += Math.abs(a) + Math.abs(b);
      }
      const refVals: number[] = [];
      for (let i = 0; i < n; i++)
        if (ref.mask.data[i] === k) refVals.push(rgbToLab(capture.data[i * 4], capture.data[i * 4 + 1], capture.data[i * 4 + 2])[0]);
      if (vals.length < 200 || refVals.length < 200) continue;
      const s = Float32Array.from(vals).sort(),
        r = Float32Array.from(refVals).sort();
      const median = q(s, 0.5);
      const spread = q(s, 0.9) - q(s, 0.1);
      fixtures.push({
        k: k - 1,
        kind: res.kinds[k - 1],
        pixels: vals.length,
        median: +median.toFixed(1),
        spread: +spread.toFixed(1),
        spreadRatio: +(spread / Math.max(1, q(r, 0.9) - q(r, 0.1))).toFixed(2),
        dark: +(vals.filter((v) => v < median - 20).length / vals.length).toFixed(3),
        bands: +(bands / vals.length).toFixed(2),
        chroma: +(chroma / vals.length).toFixed(1),
        refBands: +refBands.toFixed(2),
        bandRatio: +(bands / vals.length / Math.max(0.5, refBands)).toFixed(2),
        wide: +(wide / vals.length).toFixed(2),
        refWide: +(refWide / Math.max(1, refCount)).toFixed(2),
      });
    }
    rows.push({ id: source.id, fixtures });
    console.log(
      source.id.padEnd(26),
      fixtures.map((f) => `${f.kind} bd${f.bands}/${f.refBands} wide${f.wide}/${f.refWide}`).join(' | '),
    );
  }
  writeFileSync(join(OUT as string, `metal-${set}.json`), JSON.stringify(rows, null, 1));
}
