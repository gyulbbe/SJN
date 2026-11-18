/**
 * Candidate body step after the finishing steps (no AI call, docs/fixture-shadows-20261118.md): the
 * model shades a white ceramic far more than the render (grey sides, dark bands, chrome-like
 * reflections). Per ceramic, its L* spread around its median is narrowed toward the render's own
 * spread: below the median by (render median − render p10) ÷ (result median − result p10), at least
 * `dark`; above it the same with p90, at least `bright` (1 keeps it). The median stays, the colour
 * (a*, b*) stays, and the change fades in over 2 px from the fixture's edge. With `lift`, a median
 * darker than the render's is also raised by that share of the gap.
 */
import {
  FIXTURE_REGION,
  labToRgb,
  projectCapture,
  projectMask,
  rgbToLab,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { blurInside } from '../../src/lib/ai-export/joints';
import type { FluxFixture } from '../../src/lib/ai-export/scene-contract';

/** lift: the share of the gap by which a median darker than the render's is raised (0 none). */
export type BodyRule = { dark: number; bright: number; lift?: number };
export type BodyLog = { kind: string; fDark: number; fBright: number; median: number; refMedian: number }[];

const quantile = (sorted: Float32Array, q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

export function bodyTrial(input: {
  result: Pixels;
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  /** The result's regions with the fixtures where the model drew them (the outline's colourMask). */
  resultMask: RegionMask;
  rule: BodyRule;
}): { image: Pixels; log: BodyLog } {
  const { result, rule } = input;
  const { width, height } = result;
  const n = width * height;
  const size = { width, height };
  const ref = fixtureMask(projectMask(input.mask, input.layout, size), input.fixtures);
  const res = fixtureMask(input.resultMask, input.fixtures);
  const capture = projectCapture(input.capture, input.layout, size);
  const out = new Uint8ClampedArray(result.data);
  const log: BodyLog = [];
  for (let k = 1; k <= ref.mask.regions.length; k++) {
    const refL: number[] = [],
      resIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (ref.mask.data[i] === k)
        refL.push(rgbToLab(capture.data[i * 4], capture.data[i * 4 + 1], capture.data[i * 4 + 2])[0]);
      if (res.mask.data[i] === k) resIdx.push(i);
    }
    if (refL.length < 300 || resIdx.length < 300) continue;
    const labs = resIdx.map((i) =>
      rgbToLab(result.data[i * 4], result.data[i * 4 + 1], result.data[i * 4 + 2]),
    );
    const a = Float32Array.from(refL).sort(),
      b = Float32Array.from(labs.map((l) => l[0])).sort();
    const mRef = quantile(a, 0.5),
      mRes = quantile(b, 0.5);
    const clamp = (v: number, low: number) => Math.max(low, Math.min(1, Number.isFinite(v) ? v : 1));
    const fDark = clamp((mRef - quantile(a, 0.1)) / Math.max(1, mRes - quantile(b, 0.1)), rule.dark);
    const fBright = clamp((quantile(a, 0.9) - mRef) / Math.max(1, quantile(b, 0.9) - mRes), rule.bright);
    log.push({
      kind: ref.kinds[k - 1],
      fDark: +fDark.toFixed(2),
      fBright: +fBright.toFixed(2),
      median: Math.round(mRes),
      refMedian: Math.round(mRef),
    });
    const raise = mRes < mRef ? (mRef - mRes) * (rule.lift ?? 0) : 0;
    if (fDark === 1 && fBright === 1 && !raise) continue;
    const label = new Float32Array(n),
      ones = new Float32Array(n).fill(1);
    for (const i of resIdx) label[i] = 1;
    const inside = blurInside(label, ones, width, height, 2).mean;
    for (const [j, i] of resIdx.entries()) {
      const [L, A, B] = labs[j];
      const target = (L < mRes ? mRes - (mRes - L) * fDark : mRes + (L - mRes) * fBright) + raise;
      const w = Math.max(0, Math.min(1, (inside[i] - 0.5) * 2));
      const [r, g, bl] = labToRgb(L + (target - L) * w, A, B);
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = bl;
    }
  }
  void FIXTURE_REGION;
  return { image: { width, height, data: out }, log };
}
