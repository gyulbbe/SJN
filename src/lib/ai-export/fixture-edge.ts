/**
 * The edge of the model's ceramics after the finishing steps (no AI call; docs/fixture-shadows-20261118.md,
 * adopted 2026-11-18). Today's method keeps the model's own pixels on its fixtures, and their edge
 * pixels hold some of what the model drew behind them (often a contact shadow). With the wall around
 * put back lighter or darker, that edge showed as a dark or light outline, the fixture "cut out and
 * pasted". On each ceramic whose cut-out was used (fixture-outline.ts):
 *
 * - a pixel the cut-out holds partly (0 < alpha < 255) is mixed again: alpha × the fixture beside it
 *   (fully held fixture pixels, blurred over SOFT_RADIUS) + (1 − alpha) × the wall beside it (the face
 *   pixels, blurred alike), both from the finished picture;
 * - a fixture pixel within RIM_BAND px of a face, darker (luma) than both the fixture inside and the
 *   face outside by more than RIM_GAP, is lifted by RIM_LIFT of the difference on every channel; one
 *   the cut-out does not hold (the render's fixture, kept by the outline rule) within 2 px of the face
 *   takes the wall beside it. Where hardly any fixture is inside near (a thin tap) nothing changes.
 */
import { FIXTURE_REGION, type Pixels } from './color';
import { CERAMIC_KINDS } from './fixture-light';
import type { Cut, FixtureOutline } from './fixture-outline';
import { blurInside } from './joints';
import type { FluxFixture } from './scene-contract';

export const SOFT_RADIUS = 2;
export const RIM_BAND = 3;
export const RIM_GAP = 6;
export const RIM_LIFT = 0.8;
/** The share of the window (RIM_BAND + 3 each way) that must be fixture inside for a pixel to be lifted. */
const RIM_INSIDE = 0.08;
/** Blurred values with less than this share of their window are not trusted. */
const MIN_COVER = 0.05;

export type FixtureEdge = { image: Pixels; mixed: number; lifted: number };

export function finishFixtureEdges(input: {
  /** The finished picture. */
  shown: Pixels;
  outline: FixtureOutline;
  cuts: readonly Cut[];
  fixtures: readonly FluxFixture[];
}): FixtureEdge {
  const { shown, outline, cuts, fixtures } = input;
  const mask = outline.mask;
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
  const plane = (data: Pixels['data'], c: number) => {
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = data[i * 4 + c];
    return p;
  };
  let mixed = 0,
    lifted = 0;

  const solid = new Float32Array(n);
  for (let i = 0; i < n; i++) if (alpha[i] === 255 && mask.data[i] === FIXTURE_REGION) solid[i] = 1;
  for (let c = 0; c < 3; c++) {
    const p = plane(shown.data, c);
    const wall = blurInside(p, face, width, height, SOFT_RADIUS);
    const fixture = blurInside(p, solid, width, height, SOFT_RADIUS);
    for (let i = 0; i < n; i++) {
      const a = alpha[i];
      if (a === 0 || a === 255 || wall.cover[i] < MIN_COVER || fixture.cover[i] < MIN_COVER) continue;
      const k = a / 255;
      out[i * 4 + c] = k * fixture.mean[i] + (1 - k) * wall.mean[i];
      if (c === 0) mixed++;
    }
  }

  // Steps from the nearest face, up to RIM_BAND + 1.
  const dist = new Uint8Array(n).fill(255);
  let front: number[] = [];
  for (let i = 0; i < n; i++)
    if (face[i]) {
      dist[i] = 0;
      front.push(i);
    }
  for (let step = 1; step <= RIM_BAND + 1 && front.length; step++) {
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
    if (mask.data[i] === FIXTURE_REGION && dist[i] > RIM_BAND && alpha[i] >= 128) inner[i] = 1;
  const reach = RIM_BAND + 3;
  const inL = blurInside(lum, inner, width, height, reach);
  const outL = blurInside(lum, face, width, height, reach);
  const wall = [0, 1, 2].map((c) => blurInside(plane(out, c), face, width, height, 2));
  for (let i = 0; i < n; i++) {
    if (mask.data[i] !== FIXTURE_REGION || !inCrop[i] || dist[i] < 1 || dist[i] > RIM_BAND) continue;
    if (inL.cover[i] < RIM_INSIDE || outL.cover[i] < MIN_COVER) continue;
    const target = Math.min(inL.mean[i], outL.mean[i]) - RIM_GAP;
    if (lum[i] >= target) continue;
    if (alpha[i] < 128) {
      // A render fixture pixel the cut-out leaves, darker than both sides: the model's shadow by its
      // fixture, kept by the outline rule. It takes the wall beside it.
      if (dist[i] > 2 || wall[0].cover[i] < MIN_COVER) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = wall[c].mean[i];
    } else {
      const add = RIM_LIFT * (target - lum[i]);
      for (let c = 0; c < 3; c++) out[i * 4 + c] = out[i * 4 + c] + add;
    }
    lifted++;
  }
  return { image: { width, height, data: out }, mixed, lifted };
}
