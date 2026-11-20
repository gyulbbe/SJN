/**
 * Two fixes for what the model drew as a fixture's shape in today's method, with no AI call
 * (docs/fixture-shape-20261120.md, 2026-11-20).
 *
 * - `trimProtrusions` (T1): a thin piece the model drew sticking up out of a fixture (a tap over a
 *   basin whose design has none) is not the fixture. Of each cut-out's pixels outside the render's
 *   fixture, the 4-connected pieces that reach more than 1% of the width from it, start above its top,
 *   are at most 15% of its width wide and at least that 1% tall (a flush button is a few px) leave the
 *   cut-out, with the outside pixels below them that join them to the fixture; the finishing steps put
 *   the wall back there.
 * - `metalCeramics` + `pasteRenderFixtures` (P1): a ceramic the model drew as metal (chrome bands:
 *   mean |L* − L* blurred over 3% of the width| at least 6.5 and 3 × the render's) — mostly a thin
 *   side-on basin drawn as a towel bar or a steel holder — goes back as the render's fixture: the
 *   finishing steps run again without its cut-out (so what the model drew around it is wall) and the
 *   render's pixels go on at its place, lit by the model's light on the faces 2–8 px around it.
 */
import {
  FIXTURE_REGION,
  projectCapture,
  projectMask,
  rgbToLab,
  shiftMask,
  type Pixels,
  type RegionMask,
} from './color';
import { lightGain, toByte } from './composite';
import type { FluxInputLayout } from './contract';
import { CERAMIC_KINDS, fixtureMask } from './fixture-light';
import type { Cut } from './fixture-outline';
import { blurInside } from './joints';
import { FLUX_FIXTURE_KINDS, type FluxFixture } from './scene-contract';

/** A piece far from the fixture: more than this × the picture's width (at least 4 px). */
export const PROTRUSION_FAR = 0.01;
/** A piece at most this × the render fixture's width wide. */
export const PROTRUSION_THIN = 0.15;
/** Metal: the ceramic's bands at least this, and at least METAL_RATIO × the render's. */
export const METAL_BANDS = 6.5;
export const METAL_RATIO = 3;

export type TrimmedPiece = { fixture: number; pixels: number; width: number; height: number };

/** `renderMask`: the render's regions at the result's size, moved by the model's shift. */
export function trimProtrusions(input: {
  cuts: readonly Cut[];
  renderMask: RegionMask;
  fixtures: readonly FluxFixture[];
}): { cuts: Cut[]; trimmed: TrimmedPiece[] } {
  const { renderMask, fixtures } = input;
  const { width, height } = renderMask;
  const n = width * height;
  const far = Math.max(4, Math.round(width * PROTRUSION_FAR));
  const own = fixtureMask(renderMask, fixtures, FLUX_FIXTURE_KINDS).mask.data;
  const chosen = fixtures.filter((f) => f.box && FLUX_FIXTURE_KINDS.includes(f.kind));
  const trimmed: TrimmedPiece[] = [];
  const cuts = input.cuts.map((cut) => {
    const label = chosen.indexOf(fixtures[cut.fixture]) + 1;
    if (!label) return cut;
    // The render's fixture: its pixels, top row and width.
    let top = height,
      minX = width,
      maxX = -1;
    const mine = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      if (own[i] === label && renderMask.data[i] === FIXTURE_REGION) {
        mine[i] = 1;
        top = Math.min(top, Math.floor(i / width));
        minX = Math.min(minX, i % width);
        maxX = Math.max(maxX, i % width);
      }
    if (maxX < 0) return cut;
    const fixtureWidth = maxX - minX + 1;
    // The cut-out's pixels outside the render's fixture.
    const outside = new Uint8Array(n);
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++) {
        const i = (cut.top + y) * width + cut.left + x;
        if (cut.alpha[y * cut.width + x] >= 128 && !mine[i]) outside[i] = 1;
      }
    // Steps from the render's fixture through those pixels.
    const dist = new Uint16Array(n).fill(65535);
    let front: number[] = [];
    for (let i = 0; i < n; i++)
      if (mine[i]) {
        dist[i] = 0;
        front.push(i);
      }
    for (let step = 1; front.length; step++) {
      const next: number[] = [];
      for (const i of front)
        for (const j of [i - 1, i + 1, i - width, i + width]) {
          if (j < 0 || j >= n || !outside[j] || dist[j] !== 65535) continue;
          dist[j] = step;
          next.push(j);
        }
      front = next;
    }
    const seen = new Uint8Array(n);
    const alpha = Uint8Array.from(cut.alpha);
    let changed = false;
    for (let s = 0; s < n; s++) {
      if (!outside[s] || seen[s] || dist[s] === 65535 || dist[s] <= far) continue;
      const piece: number[] = [];
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        piece.push(i);
        for (const j of [i - 1, i + 1, i - width, i + width])
          if (j >= 0 && j < n && outside[j] && !seen[j] && dist[j] > far) {
            seen[j] = 1;
            stack.push(j);
          }
      }
      let pMinX = width,
        pMaxX = -1,
        pMinY = height,
        pMaxY = -1;
      for (const i of piece) {
        pMinX = Math.min(pMinX, i % width);
        pMaxX = Math.max(pMaxX, i % width);
        pMinY = Math.min(pMinY, Math.floor(i / width));
        pMaxY = Math.max(pMaxY, Math.floor(i / width));
      }
      const pieceWidth = pMaxX - pMinX + 1;
      if (pMinY >= top || pieceWidth > PROTRUSION_THIN * fixtureWidth || pMaxY - pMinY + 1 < far) continue;
      // With the outside pixels below it that lead down to the fixture (its stem).
      const stem = new Set(piece);
      for (let i = 0; i < n; i++)
        if (outside[i] && dist[i] <= far && dist[i] > 0) {
          const x = i % width,
            y = Math.floor(i / width);
          if (x >= pMinX - 1 && x <= pMaxX + 1 && y >= pMaxY && y < top + far) stem.add(i);
        }
      for (const i of stem) {
        const x = (i % width) - cut.left,
          y = Math.floor(i / width) - cut.top;
        if (x >= 0 && y >= 0 && x < cut.width && y < cut.height) alpha[y * cut.width + x] = 0;
      }
      changed = true;
      trimmed.push({ fixture: cut.fixture, pixels: stem.size, width: pieceWidth, height: pMaxY - pMinY + 1 });
    }
    return changed ? { ...cut, alpha } : cut;
  });
  return { cuts, trimmed };
}

export type MetalScore = { fixture: number; bands: number; refBands: number; ratio: number };

/**
 * Per ceramic of the finished picture, on the pixels where the model drew it (`colourMask`, 2 px in from
 * its edge), the chrome-like bands, and the same on the render's ceramic.
 */
export function metalScores(input: {
  shown: Pixels;
  colourMask: RegionMask;
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
}): MetalScore[] {
  const { shown, fixtures } = input;
  const { width, height } = shown;
  const n = width * height;
  const size = { width, height };
  const res = fixtureMask(input.colourMask, fixtures);
  const ref = fixtureMask(projectMask(input.mask, input.layout, size), fixtures);
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
  const chosen = fixtures
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => f.box && CERAMIC_KINDS.includes(f.kind));
  const scores: MetalScore[] = [];
  for (let k = 1; k <= res.mask.regions.length; k++) {
    const bands = bandsOf(L, res.mask.data, k),
      refBands = bandsOf(R, ref.mask.data, k);
    if (bands === undefined || refBands === undefined) continue;
    scores.push({
      fixture: chosen[k - 1].index,
      bands: +bands.toFixed(2),
      refBands: +refBands.toFixed(2),
      ratio: +(bands / Math.max(0.5, refBands)).toFixed(2),
    });
  }
  return scores;
}

/** The ceramics that look metal. */
export function metalCeramics(scores: readonly MetalScore[]): Set<number> {
  return new Set(
    scores.filter((s) => s.bands >= METAL_BANDS && s.ratio >= METAL_RATIO).map((s) => s.fixture),
  );
}

const linear = (byte: number) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * `shown`: the picture finished without the cut-outs of `metal`, the model's shift `dx`, `dy`; the
 * render's pixels of those ceramics go on at their place, lit by the model's light around them.
 */
export function pasteRenderFixtures(input: {
  shown: Pixels;
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  metal: ReadonlySet<number>;
  dx: number;
  dy: number;
}): Pixels {
  const { shown, fixtures, metal, dx, dy } = input;
  const { width, height } = shown;
  const n = width * height;
  const size = { width, height };
  const render = shiftMask(projectMask(input.mask, input.layout, size), dx, dy);
  const own = fixtureMask(render, fixtures).mask.data;
  const chosen = fixtures
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
  return { width, height, data: out };
}
