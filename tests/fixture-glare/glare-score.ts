/**
 * How strongly each ceramic of today's app picture shows reflections (no AI call,
 * docs/fixture-glare-20261119.md): on the pixels where the model drew it (the app's outline colourMask,
 * 2 px in from its edge), against the render's fixture:
 * - bright: the share of pixels more than 8 L* above the fixture's median (highlight bands);
 * - peak: L* p98 − p50 (how far the brightest band stands out);
 * - bands: mean |L* − L* blurred over 3% of the width| (dark and bright bands, as metal-score.ts);
 * - the same on the render (refBright, refPeak, refBands).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/glare-score.ts [--sets new,reg,dev,bath,mat-narrow]
 * Output: test-results/fixture-glare-20261119/glare-<set>.json
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
function stats(values: Float32Array, labels: Uint8Array, k: number, width: number, height: number) {
  const n = width * height;
  const label = new Float32Array(n),
    ones = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) if (labels[i] === k) label[i] = 1;
  const inside = blurInside(label, ones, width, height, 2).mean;
  const blur = blurInside(values, label, width, height, Math.max(3, Math.round(width * 0.03))).mean;
  const vals: number[] = [];
  let bands = 0;
  for (let i = 0; i < n; i++)
    if (label[i] && inside[i] >= 0.999) {
      vals.push(values[i]);
      bands += Math.abs(values[i] - blur[i]);
    }
  if (vals.length < 200) return undefined;
  const s = Float32Array.from(vals).sort();
  const median = q(s, 0.5);
  return {
    pixels: vals.length,
    median: +median.toFixed(1),
    bright: +(vals.filter((v) => v > median + 8).length / vals.length).toFixed(3),
    peak: +(q(s, 0.98) - median).toFixed(1),
    bands: +(bands / vals.length).toFixed(2),
  };
}
for (const set of arg('sets', 'new,reg,dev,bath,mat-narrow').split(',') as HazeSet[]) {
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
    const fixtures = [];
    for (let k = 1; k <= res.mask.regions.length; k++) {
      const a = stats(L, res.mask.data, k, width, height),
        r = stats(R, ref.mask.data, k, width, height);
      if (!a || !r) continue;
      fixtures.push({ kind: res.kinds[k - 1], ...a, refBright: r.bright, refPeak: r.peak, refBands: r.bands });
    }
    rows.push({ id: source.id, fixtures });
    console.log(
      source.id.padEnd(30),
      fixtures.map((f) => `${f.kind} br${f.bright}/${f.refBright} pk${f.peak}/${f.refPeak} bd${f.bands}/${f.refBands}`).join(' | '),
    );
  }
  writeFileSync(join(OUT as string, `glare-${set}.json`), JSON.stringify(rows, null, 1));
}
