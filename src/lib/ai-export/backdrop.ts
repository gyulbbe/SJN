import { projectCapture, resultToCapture, type Pixels, type RegionMask } from './color';
import type { FluxInputLayout } from './contract';

/**
 * Where the capture showed nothing of the room, at result size (1 = backdrop): the mask's
 * `outside` by nearest sample, and the model input's white padding, moved by the model's small
 * shift if it made one (result pixels, as the colour check measures it). Undefined when the capture
 * has no backdrop at all.
 */
export function backdropAtResult(
  mask: RegionMask,
  layout: FluxInputLayout,
  size: { width: number; height: number },
  shift = { dx: 0, dy: 0 },
): Uint8Array | undefined {
  const outside = mask.outside;
  if (!outside || !outside.some((value) => value)) return;
  const map = resultToCapture(layout, size);
  // The mask may be drawn at another size than the capture it belongs to.
  const kx = mask.width / (layout.contentWidth / layout.scale),
    ky = mask.height / (layout.contentHeight / layout.scale);
  const out = new Uint8Array(size.width * size.height);
  for (let v = 0; v < size.height; v++)
    for (let u = 0; u < size.width; u++) {
      const { x, y } = map(u - shift.dx, v - shift.dy);
      const mx = Math.round((x + 0.5) * kx - 0.5),
        my = Math.round((y + 0.5) * ky - 0.5);
      out[v * size.width + u] =
        mx >= 0 && my >= 0 && mx < mask.width && my < mask.height ? outside[my * mask.width + mx] : 1;
    }
  return out;
}

/**
 * Puts the input's plain backdrop back into a FLUX result of an outside view: every result pixel
 * where the capture showed nothing of the room (the white margin, the view through a cut-away
 * wall's open side, the input's padding) takes the input's pixel again, so no wall, glass
 * partition or window the model drew there survives. A 3 × 3 average softens the border by one
 * pixel either side; beyond it, backdrop pixels equal the input and room pixels are the model's,
 * untouched. Only for a result that kept the framing (see `framing`): on a reframed one the
 * capture's outline would cut through the model's room. Undefined when the capture has no backdrop
 * (nothing to restore).
 */
export function restoreBackdrop(input: {
  result: Pixels;
  /** The picture the model was given, at capture size (before padding). */
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  /** The model's whole-picture shift in result pixels (framing's dx, dy); none by default. */
  shift?: { dx: number; dy: number };
}): Pixels | undefined {
  const { result, capture, mask, layout } = input;
  const size = { width: result.width, height: result.height };
  const shift = { dx: input.shift?.dx ?? 0, dy: input.shift?.dy ?? 0 };
  const backdrop = backdropAtResult(mask, layout, size, shift);
  if (!backdrop) return;
  const projected = projectCapture(capture, layout, size);
  // The input's pixel where the model's shift put it (white padding past the edge).
  const reference = (u: number, v: number, c: number) => {
    const x = u - shift.dx,
      y = v - shift.dy;
    return x < 0 || y < 0 || x >= size.width || y >= size.height
      ? 255
      : projected.data[(y * size.width + x) * 4 + c];
  };
  const out = new Uint8ClampedArray(result.data);
  const { width, height } = size;
  for (let v = 0; v < height; v++)
    for (let u = 0; u < width; u++) {
      let sum = 0,
        count = 0;
      for (let dv = -1; dv <= 1; dv++)
        for (let du = -1; du <= 1; du++) {
          const x = u + du,
            y = v + dv;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          sum += backdrop[y * width + x];
          count++;
        }
      const weight = sum / count;
      if (weight === 0) continue;
      const o = (v * width + u) * 4;
      for (let c = 0; c < 3; c++)
        out[o + c] = Math.round(result.data[o + c] * (1 - weight) + reference(u, v, c) * weight);
      out[o + 3] = 255;
    }
  return { width, height, data: out };
}
