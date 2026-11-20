/**
 * The shading of the model's white ceramics (toilet, washbasin, bathtub) after the finishing steps (no
 * AI call; docs/fixture-shadows-20261118.md, adopted 2026-11-18). The model shades them far more than
 * the render: grey sides, dark bands, chrome-like reflections, or the whole fixture grey ("세면대
 * 바닥쪽 엄청 시커먼데", "변기에 있는 그림자 그을림"). Per ceramic, on the pixels where the model drew it:
 *
 * - its L* spread below its median is narrowed toward the render's own spread there, (render median
 *   − render p10) ÷ (result median − result p10), but to no less than BODY_DARK of it; above the median
 *   the same with p90 and BODY_BRIGHT;
 * - a median darker than the render's is raised to the render's;
 * - a*, b* stay the model's, and the change fades in over 2 px from the fixture's edge.
 *
 * A ceramic the render shows dark (median L* under BODY_MIN_L, a coloured fixture) is left alone, as is
 * one with fewer than BODY_MIN_PIXELS pixels.
 */
import { labToRgb, projectCapture, projectMask, rgbToLab, type Pixels, type RegionMask } from './color';
import type { FluxInputLayout } from './contract';
import { fixtureMask } from './fixture-light';
import { blurInside } from './joints';
import type { FluxFixture } from './scene-contract';

export const BODY_DARK = 0.5;
export const BODY_BRIGHT = 0.8;
export const BODY_MIN_L = 60;
const BODY_MIN_PIXELS = 300;

export type FixtureBody = {
  kind: FluxFixture['kind'];
  /** The factors the spread below and above the median got (1: kept), and the L* raised. */
  dark: number;
  bright: number;
  raised: number;
};

const quantile = (sorted: Float32Array, q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * `capture`, `mask` and `layout` as for restoreFixtureLightness; `resultMask` the result's regions with
 * the fixtures where the model drew them (fixture-outline.ts colourMask, moved by its shift).
 */
export function finishFixtureBodies(input: {
  result: Pixels;
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  resultMask: RegionMask;
  /** The least factors the spread below and above the median may get (BODY_DARK, BODY_BRIGHT). */
  dark?: number;
  bright?: number;
  /** How much of a darker median is raised to the render's (1 by default). */
  raise?: number;
}): { image?: Pixels; fixtures: FixtureBody[] } {
  const { result } = input;
  const { width, height } = result;
  const n = width * height;
  const size = { width, height };
  const ref = fixtureMask(projectMask(input.mask, input.layout, size), input.fixtures);
  const res = fixtureMask(input.resultMask, input.fixtures);
  const capture = projectCapture(input.capture, input.layout, size);
  const out = new Uint8ClampedArray(result.data);
  const changed: FixtureBody[] = [];
  for (let k = 1; k <= ref.mask.regions.length; k++) {
    const refL: number[] = [],
      resIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (ref.mask.data[i] === k)
        refL.push(rgbToLab(capture.data[i * 4], capture.data[i * 4 + 1], capture.data[i * 4 + 2])[0]);
      if (res.mask.data[i] === k) resIdx.push(i);
    }
    if (refL.length < BODY_MIN_PIXELS || resIdx.length < BODY_MIN_PIXELS) continue;
    const labs = resIdx.map((i) =>
      rgbToLab(result.data[i * 4], result.data[i * 4 + 1], result.data[i * 4 + 2]),
    );
    const a = Float32Array.from(refL).sort(),
      b = Float32Array.from(labs.map((l) => l[0])).sort();
    const mRef = quantile(a, 0.5),
      mRes = quantile(b, 0.5);
    if (mRef < BODY_MIN_L) continue;
    const clamp = (v: number, low: number) => Math.max(low, Math.min(1, Number.isFinite(v) ? v : 1));
    const dark = clamp(
      (mRef - quantile(a, 0.1)) / Math.max(1, mRes - quantile(b, 0.1)),
      input.dark ?? BODY_DARK,
    );
    const bright = clamp(
      (quantile(a, 0.9) - mRef) / Math.max(1, quantile(b, 0.9) - mRes),
      input.bright ?? BODY_BRIGHT,
    );
    const raise = mRes < mRef ? (mRef - mRes) * (input.raise ?? 1) : 0;
    if (dark === 1 && bright === 1 && !raise) continue;
    changed.push({
      kind: ref.kinds[k - 1],
      dark: +dark.toFixed(2),
      bright: +bright.toFixed(2),
      raised: +raise.toFixed(1),
    });
    const label = new Float32Array(n),
      ones = new Float32Array(n).fill(1);
    for (const i of resIdx) label[i] = 1;
    const inside = blurInside(label, ones, width, height, 2).mean;
    for (const [j, i] of resIdx.entries()) {
      const [L, A, B] = labs[j];
      const target = (L < mRes ? mRes - (mRes - L) * dark : mRes + (L - mRes) * bright) + raise;
      const w = Math.max(0, Math.min(1, (inside[i] - 0.5) * 2));
      const [r, g, bl] = labToRgb(L + (target - L) * w, A, B);
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = bl;
    }
  }
  return changed.length ? { image: { width, height, data: out }, fixtures: changed } : { fixtures: changed };
}
