/**
 * Candidates for the ceramics the model drew as metal (no AI call, docs/fixture-material-20261118.md),
 * on top of today's app picture (current-refine.ts).
 *
 * - `metalScores`: per ceramic of the app picture, on the pixels where the model drew it (its outline
 *   colourMask, 2 px in from the edge), `bands` = mean |L* − L* blurred over 3% of the width| and the
 *   same on the render's fixture (`refBands`). A ceramic with bands ≥ `bands` and bands ÷ refBands ≥
 *   `ratio` looks metal (chrome bands; the model often draws a thin side-on basin as a steel holder).
 * - P1 `pasteRender`: those ceramics only, the finishing steps run again without their cut-out (so they
 *   keep the render's outline and what the model drew around them is wall), then the render's fixture
 *   pixels go on at the render's place, lit by the model's light around them (composite.ts lightGain on
 *   a ring of faces 2–8 px outside the fixture).
 */
import {
  FIXTURE_REGION,
  labToRgb,
  projectCapture,
  projectMask,
  rgbToLab,
  shiftMask,
  type Pixels,
} from '../../src/lib/ai-export/color';
import { lightGain, toByte } from '../../src/lib/ai-export/composite';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { CERAMIC_KINDS, fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { blurInside } from '../../src/lib/ai-export/joints';
import type { loadInput } from '../fixture-shadows/load';

type Input = NonNullable<Awaited<ReturnType<typeof loadInput>>>['input'];
export type MetalScore = { fixture: number; kind: string; bands: number; refBands: number; ratio: number };

const linear = (byte: number) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function metalScores(input: Input, app: ReturnType<typeof refineCurrentResult>): MetalScore[] {
  if (!app.outline || !app.shown) return [];
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
    return count >= 200 ? sum / count : undefined;
  };
  // The fixtures fixtureMask labels, in order (those with a box and a ceramic kind).
  const chosen = input.fixtures
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => f.box && CERAMIC_KINDS.includes(f.kind));
  const scores: MetalScore[] = [];
  for (let k = 1; k <= res.mask.regions.length; k++) {
    const bands = bandsOf(L, res.mask.data, k),
      refBands = bandsOf(R, ref.mask.data, k);
    if (bands === undefined || refBands === undefined) continue;
    scores.push({
      fixture: chosen[k - 1].index,
      kind: res.kinds[k - 1],
      bands: +bands.toFixed(2),
      refBands: +refBands.toFixed(2),
      ratio: +(bands / Math.max(0.5, refBands)).toFixed(2),
    });
  }
  return scores;
}

export function pasteRender(
  input: Input,
  metal: ReadonlySet<number>,
): { image: Pixels; again: ReturnType<typeof refineCurrentResult> } | undefined {
  const again = refineCurrentResult({ ...input, cuts: input.cuts.filter((c) => !metal.has(c.fixture)) });
  const shown = again.shown;
  if (!shown || !again.review.framing.aligned) return undefined;
  const { width, height } = shown;
  const n = width * height;
  const size = { width, height };
  const { dx, dy } = again.review.framing;
  const render = shiftMask(projectMask(input.mask, input.layout, size), dx, dy);
  const own = fixtureMask(render, input.fixtures).mask.data;
  const chosen = input.fixtures
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => f.box && CERAMIC_KINDS.includes(f.kind));
  const capture = projectCapture(input.capture, input.layout, size);
  // The capture's pixel under each result pixel (the result is the capture moved by dx, dy).
  const from = (i: number) => {
    const x = (i % width) - dx,
      y = Math.floor(i / width) - dy;
    return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
  };
  const out = new Uint8ClampedArray(shown.data);
  for (let k = 1; k <= chosen.length; k++) {
    if (!metal.has(chosen[k - 1].index)) continue;
    // Steps from the fixture, for the ring of faces 2–8 px outside it.
    const dist = new Uint8Array(n).fill(255);
    let front: number[] = [];
    for (let i = 0; i < n; i++)
      if (own[i] === k) {
        dist[i] = 0;
        front.push(i);
      }
    for (let step = 1; step <= 8 && front.length; step++) {
      const next: number[] = [];
      for (const i of front)
        for (const j of [i - 1, i + 1, i - width, i + width]) {
          if (j < 0 || j >= n || dist[j] !== 255) continue;
          dist[j] = step;
          next.push(j);
        }
      front = next;
    }
    const model = [0, 0, 0],
      ours = [0, 0, 0];
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (dist[i] < 2 || dist[i] > 8 || !render.data[i] || render.data[i] === FIXTURE_REGION) continue;
      const j = from(i);
      if (j < 0) continue;
      for (let c = 0; c < 3; c++) {
        model[c] += linear(shown.data[i * 4 + c]);
        ours[c] += linear(capture.data[j * 4 + c]);
      }
      count++;
    }
    const gain = lightGain(model, ours, count);
    for (let i = 0; i < n; i++) {
      if (own[i] !== k) continue;
      const j = from(i);
      if (j < 0) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = toByte(linear(capture.data[j * 4 + c]) * gain[c]);
    }
  }
  return { image: { width, height, data: out }, again };
}

/**
 * F1: the model's ceramic below the render's (a foot or plinth the model added under a pedestal basin),
 * where much darker than the fixture's own median L*, raised to `keep` short of it (L* only; a*, b*
 * stay). Below the render: pixels of the model's ceramic (outline colourMask) outside the render's
 * fixture and under its lowest row in that column.
 */
export function liftFeet(
  input: Input,
  app: Pick<ReturnType<typeof refineCurrentResult>, 'outline' | 'review'> & { shown?: Pixels },
  options = { gap: 10, keep: 8 },
): { image?: Pixels; lifted: number } {
  if (!app.outline || !app.shown) return { lifted: 0 };
  const shown = app.shown;
  const { width, height } = shown;
  const n = width * height;
  const size = { width, height };
  const { dx, dy } = app.review.framing;
  const render = fixtureMask(shiftMask(projectMask(input.mask, input.layout, size), dx, dy), input.fixtures)
    .mask.data;
  const res = fixtureMask(app.outline.colourMask, input.fixtures);
  const out = new Uint8ClampedArray(shown.data);
  let lifted = 0;
  for (let k = 1; k <= res.mask.regions.length; k++) {
    const bottom = new Int32Array(width).fill(-1);
    const body: number[] = [];
    for (let i = 0; i < n; i++)
      if (render[i] === k) {
        const x = i % width;
        bottom[x] = Math.max(bottom[x], Math.floor(i / width));
        if (res.mask.data[i] === k)
          body.push(rgbToLab(shown.data[i * 4], shown.data[i * 4 + 1], shown.data[i * 4 + 2])[0]);
      }
    if (body.length < 300) continue;
    const median = Float32Array.from(body).sort()[Math.floor(body.length / 2)];
    for (let i = 0; i < n; i++) {
      if (res.mask.data[i] !== k || render[i] === k) continue;
      const x = i % width;
      if (bottom[x] < 0 || Math.floor(i / width) <= bottom[x]) continue;
      const [L, A, B] = rgbToLab(shown.data[i * 4], shown.data[i * 4 + 1], shown.data[i * 4 + 2]);
      if (L >= median - options.gap) continue;
      const [r, g, b] = labToRgb(median - options.keep, A, B);
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      lifted++;
    }
  }
  return lifted ? { image: { width, height, data: out }, lifted } : { lifted };
}
