/**
 * Trial: the model's light streaks and big shadows over the ceramics (docs/fixture-streaks-20261117.md).
 * The walls' rule (joints.ts keepLightDifference) on each ceramic fixture where the model drew it: the
 * fixture's broad light (a blur inside its outline, `share` of its box's shorter side) over the render's
 * fixture light, against the fixture's median, keeps only `keep` of its distance (log). Fine shading
 * narrower than the blur and the render's own shading stay. No AI call.
 */
import {
  projectCapture,
  projectMask,
  shiftMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { blurInside } from '../../src/lib/ai-export/joints';
import type { FluxFixture } from '../../src/lib/ai-export/scene-contract';

export type StreakOptions = {
  keep: number;
  share: number;
  factor?: readonly [number, number];
  /**
   * What the light is pulled to: the fixture's median ratio (default), a quantile of it (0.75: the
   * lit side, so mostly shadows are lifted), or `mean`: the median's shape, then scaled so the
   * fixture's mean brightness stays.
   */
  anchor?: 'median' | 'mean' | number;
  /** The render's light is blurred this many times wider (its small details, a label, sit elsewhere in the model's). */
  refWide?: number;
};
export type StreakFixture = {
  kind: FluxFixture['kind'];
  pixels: number;
  radius: number;
  spread: number;
  after: number;
  /** Shares of its pixels made darker than 0.85× and lighter than 1.4×. */
  darker: number;
  lighter: number;
};

const lum = (d: Uint8ClampedArray | Uint8Array, o: number) =>
  0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/** Std of the log ratio over the fixture (the streak strength, same blur). */
function spreadOf(ratio: Float32Array, weight: Float32Array) {
  let s = 0,
    s2 = 0,
    n = 0;
  for (let i = 0; i < ratio.length; i++) {
    if (!weight[i]) continue;
    const l = Math.log(ratio[i]);
    s += l;
    s2 += l * l;
    n++;
  }
  return n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
}

export function keepFixtureLight(input: {
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  result: Pixels;
  frame: { dx: number; dy: number };
  resultMask?: RegionMask;
  options: StreakOptions;
}): { image: Pixels; fixtures: StreakFixture[] } {
  const { result, options } = input;
  const { width, height } = result;
  const size = { width, height };
  const render = fixtureMask(projectMask(input.mask, input.layout, size), input.fixtures);
  const renderMoved = shiftMask(render.mask, input.frame.dx, input.frame.dy);
  const moved = input.resultMask ? fixtureMask(input.resultMask, input.fixtures).mask : renderMoved;
  const reference = projectCapture(input.capture, input.layout, size);
  const out = new Uint8ClampedArray(result.data);
  const fixtures: StreakFixture[] = [];
  const [lo, hi] = options.factor ?? [0.5, 2];
  for (let k = 0; k < render.mask.regions.length; k++) {
    const label = k + 1;
    let minX = width,
      minY = height,
      maxX = -1,
      maxY = -1,
      n = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (moved.data[y * width + x] === label) {
          n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
    if (n < 300) continue;
    const radius = Math.max(2, Math.round(Math.min(maxX - minX, maxY - minY) * options.share));
    const reach = 2 * Math.round(radius * (options.refWide ?? 1)) * 3 + 4;
    const x0 = Math.max(0, minX - reach),
      y0 = Math.max(0, minY - reach),
      x1 = Math.min(width, maxX + reach + 1),
      y1 = Math.min(height, maxY + reach + 1);
    const w = x1 - x0,
      h = y1 - y0,
      count = w * h;
    const at = (i: number) => (y0 + Math.floor(i / w)) * width + x0 + (i % w);
    const mine = new Float32Array(count),
      theirs = new Float32Array(count),
      resLum = new Float32Array(count),
      refLum = new Float32Array(count),
      ones = new Float32Array(count).fill(1);
    for (let i = 0; i < count; i++) {
      const j = at(i);
      if (moved.data[j] === label) mine[i] = 1;
      if (renderMoved.data[j] === label) theirs[i] = 1;
      resLum[i] = lum(result.data, j * 4);
      // The render's pixel under this result pixel.
      const rx = Math.max(0, Math.min(width - 1, (j % width) - input.frame.dx)),
        ry = Math.max(0, Math.min(height - 1, Math.floor(j / width) - input.frame.dy));
      refLum[i] = lum(reference.data, (ry * width + rx) * 4);
    }
    const resLight = blurInside(resLum, mine, w, h, radius).mean;
    // The render fixture's light, reaching out (a wider blur) where the model's fixture is larger.
    const refRadius = Math.round(radius * (options.refWide ?? 1));
    const near = blurInside(refLum, theirs, w, h, refRadius),
      far = blurInside(refLum, theirs, w, h, refRadius * 3);
    const ratio = new Float32Array(count);
    const sample: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!mine[i]) continue;
      const t = Math.min(1, near.cover[i] / 0.25);
      const ref = far.cover[i] > 0 ? near.mean[i] * t + far.mean[i] * (1 - t) : refLum[i];
      ratio[i] = Math.max(1e-3, resLight[i]) / Math.max(1, ref);
      sample.push(ratio[i]);
    }
    sample.sort((a, b) => a - b);
    const anchor = options.anchor ?? 'median';
    const median =
      typeof anchor === 'number'
        ? sample[Math.min(sample.length - 1, Math.floor(sample.length * anchor))]
        : sample[sample.length >> 1];
    const spread = spreadOf(ratio, mine);
    // The change fades in over a couple of pixels from the outline.
    const inside = blurInside(mine, ones, w, h, 2).mean;
    const after = new Float32Array(count);
    const factors = new Float32Array(count);
    let before = 0,
      adjusted = 0;
    for (let i = 0; i < count; i++) {
      if (!mine[i]) continue;
      factors[i] = Math.min(hi, Math.max(lo, Math.pow(ratio[i] / median, options.keep - 1)));
      before += resLum[i];
      adjusted += resLum[i] * factors[i];
    }
    // `mean`: the fixture keeps its mean brightness.
    const scale = anchor === 'mean' && adjusted > 0 ? before / adjusted : 1;
    let darker = 0,
      lighter = 0;
    for (let i = 0; i < count; i++) {
      if (!mine[i]) continue;
      const factor = factors[i] * scale;
      if (factor < 0.85) darker++;
      if (factor > 1.4) lighter++;
      const alpha = Math.max(0, Math.min(1, (inside[i] - 0.5) * 2));
      const f = 1 + (factor - 1) * alpha;
      const j = at(i);
      for (let c = 0; c < 3; c++) out[j * 4 + c] = result.data[j * 4 + c] * f;
      after[i] = ratio[i] * f;
    }
    fixtures.push({
      kind: render.kinds[k],
      pixels: n,
      radius,
      spread: Number(spread.toFixed(3)),
      after: Number(spreadOf(after, mine).toFixed(3)),
      darker: Number((darker / n).toFixed(3)),
      lighter: Number((lighter / n).toFixed(3)),
    });
  }
  return { image: { width, height, data: out }, fixtures };
}
