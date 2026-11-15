/**
 * Putting the placed products' own photos back on a FLUX result (no AI call; docs/photo-products-
 * 20261115.md, on trial). A product registered with photos is drawn in the 3D room as its photo of
 * the side the camera sees, so the render already shows a real photograph of it; the model redraws it
 * anyway and often turns a washbasin whose front photo is a plain white square into a wall panel or a
 * grey box. Here the render's pixels of each such product (mask FIXTURE_REGION inside its box, the
 * smallest box where boxes overlap, moved by the model's shift) go back over the result, lit by the
 * model's light around it (the ring's light over the render's, within composite.ts MIN_GAIN–MAX_GAIN)
 * and softened over the edge's inner pixel so the outline never grows. Everything else stays.
 */
import { lightGain, toByte, toLinear, type Gain } from '../../src/lib/ai-export/composite';
import {
  FIXTURE_REGION,
  projectCapture,
  projectMask,
  shiftMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { FLUX_FIXTURE_KINDS, type FluxFixture } from '../../src/lib/ai-export/scene-contract';

/** The ring of room around a product that sets its light, in result pixels from its outline. */
export const PHOTO_RING = [3, 16] as const;
/** A product with fewer pixels than this is left as the model drew it. */
export const MIN_PHOTO_PIXELS = 200;

export type PastedPhoto = { kind: FluxFixture['kind']; pixels: number; gain: Gain; ringPixels: number };

/** Chessboard distance (capped) from every pixel to the nearest pixel of `inside`. */
function distanceTo(inside: Uint8Array, width: number, height: number, cap: number) {
  const d = new Uint16Array(width * height).fill(cap);
  for (let i = 0; i < d.length; i++) if (inside[i]) d[i] = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let k = 0; k < d.length; k++) {
      const i = pass ? d.length - 1 - k : k;
      const x = i % width,
        y = (i - x) / width;
      const step = pass ? 1 : -1;
      let v = d[i];
      const nx = x + step,
        ny = y + step;
      if (nx >= 0 && nx < width) v = Math.min(v, d[i + step] + 1);
      if (ny >= 0 && ny < height) {
        v = Math.min(v, d[i + step * width] + 1);
        if (x - 1 >= 0) v = Math.min(v, d[i + step * width - 1] + 1);
        if (x + 1 < width) v = Math.min(v, d[i + step * width + 1] + 1);
      }
      d[i] = v;
    }
  return d;
}

/**
 * The result with the render's pixels of the products `photo` marks (one flag per fixture in
 * `fixtures`, the facts sent with the conversion) put back. `capture`, `mask` and `layout` as for
 * reviewResultColors, `result` the picture shown (after the other steps) and `frame` the model's shift.
 */
export function pastePhotoProducts(input: {
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  photo: readonly boolean[];
  result: Pixels;
  frame: { dx: number; dy: number };
}): { image?: Pixels; pasted: PastedPhoto[] } {
  const { result, frame } = input;
  const { width, height } = result;
  const size = { width, height };
  const chosen = input.fixtures.filter((_, k) => input.photo[k]);
  if (!chosen.length) return { pasted: [] };
  const projected = projectMask(input.mask, input.layout, size);
  const { mask: labels, kinds } = fixtureMask(projected, chosen, FLUX_FIXTURE_KINDS);
  if (!labels.regions.length) return { pasted: [] };
  const moved = shiftMask(labels, frame.dx, frame.dy).data;
  const room = shiftMask(projected, frame.dx, frame.dy).data;
  const reference = projectCapture(input.capture, input.layout, size);
  // The render's pixel under each result pixel (its own pixel past the edge).
  const refAt = (x: number, y: number) =>
    (Math.max(0, Math.min(height - 1, y - frame.dy)) * width +
      Math.max(0, Math.min(width - 1, x - frame.dx))) *
    4;
  const out = new Uint8ClampedArray(result.data);
  const pasted: PastedPhoto[] = [];
  for (let k = 0; k < labels.regions.length; k++) {
    const label = k + 1;
    const inside = new Uint8Array(width * height);
    let count = 0;
    for (let i = 0; i < inside.length; i++)
      if (moved[i] === label) {
        inside[i] = 1;
        count++;
      }
    if (count < MIN_PHOTO_PIXELS) continue;
    // The light: the model's room over the render's in a ring around the product (walls and floor).
    const distance = distanceTo(inside, width, height, PHOTO_RING[1] + 1);
    const model = [0, 0, 0],
      ours = [0, 0, 0];
    let ring = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (distance[i] < PHOTO_RING[0] || distance[i] > PHOTO_RING[1]) continue;
        if (room[i] === 0 || room[i] === FIXTURE_REGION) continue;
        const r = refAt(x, y);
        for (let c = 0; c < 3; c++) {
          model[c] += result.data[i * 4 + c];
          ours[c] += reference.data[r + c];
        }
        ring++;
      }
    // Averaged as stored (sRGB), then made linear, as composite.ts fixtureGains does.
    const linear = (sum: number[]) => sum.map((v) => toLinear(Math.round(v / Math.max(1, ring))) * ring);
    const gain = lightGain(linear(model), linear(ours), ring);
    // The render's outermost pixel of a photo is its cut-out's dark rim (the photos' transparent
    // pixels are black): it stays the model's, the next one in is half the photo, and the outline
    // never grows.
    const core = new Uint8Array(width * height);
    for (let i = 0; i < inside.length; i++)
      if (
        inside[i] &&
        [i - 1, i + 1, i - width, i + width].every((j) => j >= 0 && j < inside.length && inside[j])
      )
        core[i] = 1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!core[i]) continue;
        let edge = false;
        for (const j of [i - 1, i + 1, i - width, i + width])
          if (j < 0 || j >= core.length || !core[j]) edge = true;
        const a = edge ? 0.5 : 1;
        const r = refAt(x, y);
        for (let c = 0; c < 3; c++) {
          const photo = toLinear(reference.data[r + c]) * gain[c];
          out[i * 4 + c] = toByte(photo * a + toLinear(result.data[i * 4 + c]) * (1 - a));
        }
      }
    pasted.push({ kind: kinds[k], pixels: count, gain, ringPixels: ring });
  }
  if (!pasted.length) return { pasted };
  return { image: { width, height, data: out }, pasted };
}
