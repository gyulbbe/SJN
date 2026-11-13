/**
 * T6 of the tile AI trial (docs/tile-ai-trials-20261113.md), free of I/O: putting the app picture's
 * joints and printed pattern back on the faces where the model re-laid the tiles. On such a face the
 * result keeps only its broad light and colour (a blur wider than a joint), and the reference's fine
 * detail (its luminance over its own blur) is multiplied in. Fixtures, the other faces and the backdrop
 * stay the model's. This is the "light from the AI only" idea of 2026-11-04, limited to failing faces.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';

/** The blur that separates broad light from joints, as a share of the picture's width. */
export const LIGHT_BLUR = 0.012;
/** How far the reference's detail may darken or lighten the model's light. */
const DETAIL_RANGE = [0.55, 1.5] as const;

/** A box blur of `value` weighted by `weight` (0 or 1): pixels outside the face do not bleed in. */
function blurInside(
  value: Float32Array,
  weight: Float32Array,
  width: number,
  height: number,
  radius: number,
) {
  const pass = (source: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(source.length);
    const lines = horizontal ? height : width,
      length = horizontal ? width : height,
      step = horizontal ? 1 : width;
    for (let line = 0; line < lines; line++) {
      const start = horizontal ? line * width : line;
      let sum = 0;
      for (let i = 0; i < Math.min(length, radius + 1); i++) sum += source[start + i * step];
      for (let i = 0; i < length; i++) {
        out[start + i * step] = sum;
        const enter = i + radius + 1,
          leave = i - radius;
        if (enter < length) sum += source[start + enter * step];
        if (leave >= 0) sum -= source[start + leave * step];
      }
    }
    return out;
  };
  const twice = (source: Float32Array) => pass(pass(pass(pass(source, true), false), true), false);
  const weighted = new Float32Array(value.length);
  for (let i = 0; i < value.length; i++) weighted[i] = value[i] * weight[i];
  const top = twice(weighted),
    bottom = twice(weight);
  const out = new Float32Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = bottom[i] > 0 ? top[i] / bottom[i] : value[i];
  return out;
}
const luminance = (data: ArrayLike<number>, o: number) =>
  0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];

/**
 * The result with the reference's fine detail on the faces `labels` names (mask labels, 1-based).
 * `reference` and `mask` are at the result's size, the mask already moved by the model's shift, and
 * `shift` (result pixels) says where the reference's pixel of a result pixel is.
 */
export function restoreJoints(
  reference: Pixels,
  result: Pixels,
  mask: RegionMask,
  labels: ReadonlySet<number>,
  shift = { dx: 0, dy: 0 },
): Pixels {
  const { width, height } = result;
  const out = new Uint8ClampedArray(result.data);
  const radius = Math.max(2, Math.round(width * LIGHT_BLUR));
  const count = width * height;
  for (const label of labels) {
    if (label === FIXTURE_REGION || label < 1) continue;
    const weight = new Float32Array(count);
    let any = false;
    for (let i = 0; i < count; i++)
      if (mask.data[i] === label) {
        weight[i] = 1;
        any = true;
      }
    if (!any) continue;
    // The reference's pixel under each result pixel (its own pixel past the edge).
    const refLum = new Float32Array(count);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const rx = Math.max(0, Math.min(width - 1, x - shift.dx)),
          ry = Math.max(0, Math.min(height - 1, y - shift.dy));
        refLum[y * width + x] = luminance(reference.data, (ry * width + rx) * 4);
      }
    const refLight = blurInside(refLum, weight, width, height, radius);
    // Near the face's rim the detail fades in over a few pixels.
    const ones = new Float32Array(count).fill(1);
    const inside = blurInside(weight, ones, width, height, 2);
    const channels = [0, 1, 2].map((c) => {
      const plane = new Float32Array(count);
      for (let i = 0; i < count; i++) plane[i] = result.data[i * 4 + c];
      return blurInside(plane, weight, width, height, radius);
    });
    for (let i = 0; i < count; i++) {
      if (!weight[i]) continue;
      const detail = Math.max(
        DETAIL_RANGE[0],
        Math.min(DETAIL_RANGE[1], refLum[i] / Math.max(1, refLight[i])),
      );
      const alpha = Math.max(0, Math.min(1, (inside[i] - 0.5) * 2));
      for (let c = 0; c < 3; c++)
        out[i * 4 + c] = Math.round(result.data[i * 4 + c] * (1 - alpha) + channels[c][i] * detail * alpha);
    }
  }
  return { width, height, data: out };
}
