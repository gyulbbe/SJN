/**
 * Candidate edge steps after the finishing steps (no AI call, docs/fixture-shadows-20261118.md).
 *
 * The model's fixture keeps the model's pixels, and its edge pixels hold some of the model's wall
 * behind them (often a contact shadow it drew). Once the wall around is put back lighter or darker,
 * that edge shows as a dark or light outline.
 *
 * - `soft` (E1): every pixel a used ceramic cut-out holds partly (0 < alpha < 255) is mixed again:
 *   alpha × the fixture beside it (blurred fully held fixture pixels) + (1 − alpha) × the wall beside
 *   it (blurred face pixels), both from the finished picture.
 * - `rim` (E2): a ceramic edge pixel (within `band` px of a face) darker than both its fixture inside
 *   and its wall outside (blurred lightness) by more than `gap` is lifted by `lift` of the difference,
 *   the same amount on every channel. Pixels with little fixture inside near (a thin tap) are left.
 *   Such a pixel the cut-out does not hold (the render's fixture, kept by the outline rule) within
 *   2 px of the wall takes the wall beside it.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import { CERAMIC_KINDS } from '../../src/lib/ai-export/fixture-light';
import type { Cut, FixtureOutline } from '../../src/lib/ai-export/fixture-outline';
import { blurInside } from '../../src/lib/ai-export/joints';
import type { FluxFixture } from '../../src/lib/ai-export/scene-contract';

export type EdgeRule = {
  soft?: boolean;
  rim?: { band: number; gap: number; lift: number; inside: number };
};

export type EdgeLog = { soft: number; rim: number };

export function edgeTrial(input: {
  raw: Pixels;
  shown: Pixels;
  outline: FixtureOutline;
  cuts: readonly Cut[];
  fixtures: readonly FluxFixture[];
  rule: EdgeRule;
}): { image: Pixels; log: EdgeLog } {
  const { raw, shown, outline, cuts, fixtures, rule } = input;
  const mask: RegionMask = outline.mask;
  const { width, height } = shown;
  const n = width * height;
  const used = new Set(outline.verdicts.filter((v) => v.used).map((v) => v.fixture));
  // The strongest alpha of a used ceramic cut-out at each pixel.
  const alpha = new Uint8Array(n),
    inCrop = new Uint8Array(n);
  for (const cut of cuts) {
    if (!used.has(cut.fixture) || !CERAMIC_KINDS.includes(fixtures[cut.fixture].kind)) continue;
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++) {
        const i = (cut.top + y) * width + cut.left + x;
        inCrop[i] = 1;
        alpha[i] = Math.max(alpha[i], cut.alpha[y * cut.width + x]);
      }
  }
  const face = new Float32Array(n);
  for (let i = 0; i < n; i++) if (mask.data[i] && mask.data[i] !== FIXTURE_REGION) face[i] = 1;
  const out = new Uint8ClampedArray(shown.data);
  const log: EdgeLog = { soft: 0, rim: 0 };
  const plane = (image: Pixels | Uint8ClampedArray, c: number) => {
    const data = 'data' in image ? image.data : image;
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = data[i * 4 + c];
    return p;
  };

  if (rule.soft) {
    const R = 2;
    const solid = new Float32Array(n);
    for (let i = 0; i < n; i++) if (alpha[i] === 255 && mask.data[i] === FIXTURE_REGION) solid[i] = 1;
    for (let c = 0; c < 3; c++) {
      const p = plane(shown, c);
      const wall = blurInside(p, face, width, height, R);
      const fixture = blurInside(p, solid, width, height, R);
      for (let i = 0; i < n; i++) {
        const a = alpha[i];
        if (a === 0 || a === 255 || wall.cover[i] < 0.05 || fixture.cover[i] < 0.05) continue;
        const k = a / 255;
        out[i * 4 + c] = k * fixture.mean[i] + (1 - k) * wall.mean[i];
        if (c === 0) log.soft++;
      }
    }
  }

  if (rule.rim) {
    const { band, gap, lift, inside } = rule.rim;
    // Steps from the nearest face, up to band + 1.
    const dist = new Uint8Array(n).fill(255);
    let front: number[] = [];
    for (let i = 0; i < n; i++)
      if (face[i]) {
        dist[i] = 0;
        front.push(i);
      }
    for (let step = 1; step <= band + 1 && front.length; step++) {
      const next: number[] = [];
      for (const i of front) {
        const x = i % width;
        for (const j of [i - 1, i + 1, i - width, i + width]) {
          if (j < 0 || j >= n || dist[j] !== 255) continue;
          if ((j === i - 1 && x === 0) || (j === i + 1 && x === width - 1)) continue;
          dist[j] = step;
          next.push(j);
        }
      }
      front = next;
    }
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.299 * out[i * 4] + 0.587 * out[i * 4 + 1] + 0.114 * out[i * 4 + 2];
    const inner = new Float32Array(n);
    for (let i = 0; i < n; i++)
      if (mask.data[i] === FIXTURE_REGION && dist[i] > band && alpha[i] >= 128) inner[i] = 1;
    const R = band + 3;
    const inL = blurInside(lum, inner, width, height, R);
    const outL = blurInside(lum, face, width, height, R);
    const wall = [0, 1, 2].map((c) => blurInside(plane(out, c), face, width, height, 2));
    for (let i = 0; i < n; i++) {
      if (mask.data[i] !== FIXTURE_REGION || !inCrop[i] || dist[i] < 1 || dist[i] > band) continue;
      if (inL.cover[i] < inside || outL.cover[i] < 0.05) continue;
      const target = Math.min(inL.mean[i], outL.mean[i]) - gap;
      if (lum[i] >= target) continue;
      if (alpha[i] < 128) {
        // A render fixture pixel the cut-out leaves, darker than both sides: the model's shadow by
        // its fixture, kept by the outline rule. It takes the wall beside it.
        if (dist[i] > 2 || wall[0].cover[i] < 0.05) continue;
        for (let c = 0; c < 3; c++) out[i * 4 + c] = wall[c].mean[i];
      } else {
        const add = lift * (target - lum[i]);
        for (let c = 0; c < 3; c++) out[i * 4 + c] = out[i * 4 + c] + add;
      }
      log.rim++;
    }
  }
  return { image: { width, height, data: out }, log };
}
