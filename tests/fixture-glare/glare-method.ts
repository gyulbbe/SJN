/**
 * G1, a candidate step after today's finishing steps (no AI call, docs/fixture-glare-20261119.md):
 * per ceramic (the app's outline colourMask), when its bands (mean |L* − L* blurred over 3% of the
 * width|, 2 px in from its edge) are over `start` times the render's, the L* above its median is
 * narrowed by refBands ÷ bands (at least `floor`), so its highlight bands and reflections stand out
 * as much as on the render. a*, b* stay; the change fades in over 2 px from the fixture's edge.
 */
import { labToRgb, projectCapture, projectMask, rgbToLab, type Pixels } from '../../src/lib/ai-export/color';
import type { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { blurInside } from '../../src/lib/ai-export/joints';
import type { loadInput } from '../fixture-shadows/load';

type Input = NonNullable<Awaited<ReturnType<typeof loadInput>>>['input'];
export type GlareRule = { start: number; floor: number; dark?: boolean };
export type GlareLog = { kind: string; bands: number; refBands: number; factor: number }[];

export function lessGlare(
  input: Input,
  app: ReturnType<typeof refineCurrentResult>,
  rule: GlareRule,
): { image?: Pixels; log: GlareLog } {
  if (!app.outline || !app.shown) return { log: [] };
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
  const ones = new Float32Array(n).fill(1);
  const radius = Math.max(3, Math.round(width * 0.03));
  const bandsOf = (values: Float32Array, labels: Uint8Array, k: number) => {
    const label = new Float32Array(n);
    for (let i = 0; i < n; i++) if (labels[i] === k) label[i] = 1;
    const inside = blurInside(label, ones, width, height, 2).mean;
    const blur = blurInside(values, label, width, height, radius).mean;
    let sum = 0,
      count = 0;
    for (let i = 0; i < n; i++)
      if (label[i] && inside[i] >= 0.999) {
        sum += Math.abs(values[i] - blur[i]);
        count++;
      }
    return { bands: count >= 200 ? sum / count : undefined, label, inside };
  };
  const out = new Uint8ClampedArray(shown.data);
  const log: GlareLog = [];
  for (let k = 1; k <= res.mask.regions.length; k++) {
    const a = bandsOf(L, res.mask.data, k),
      r = bandsOf(R, ref.mask.data, k);
    if (a.bands === undefined || r.bands === undefined) continue;
    const refBands = Math.max(0.5, r.bands);
    if (a.bands <= refBands * rule.start) continue;
    const factor = Math.max(rule.floor, (refBands * rule.start) / a.bands);
    log.push({ kind: res.kinds[k - 1], bands: +a.bands.toFixed(2), refBands: +refBands.toFixed(2), factor: +factor.toFixed(2) });
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (res.mask.data[i] === k) idx.push(i);
    const sorted = Float32Array.from(idx.map((i) => L[i])).sort();
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const i of idx) {
      if (L[i] <= median && !rule.dark) continue;
      const w = Math.max(0, Math.min(1, (a.inside[i] - 0.5) * 2));
      const target = median + (L[i] - median) * factor;
      const [, A, B] = rgbToLab(shown.data[i * 4], shown.data[i * 4 + 1], shown.data[i * 4 + 2]);
      const [rr, g, b] = labToRgb(L[i] + (target - L[i]) * w, A, B);
      out[i * 4] = rr;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
    }
  }
  return log.length ? { image: { width, height, data: out }, log } : { log };
}
