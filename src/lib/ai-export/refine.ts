import type { Pixels } from './color';
import { fixtureLayer, lightGain, toLinear, type FixtureLayer, type RoomLayers } from './composite';
import { fluxInputLayout, type FluxInputLayout } from './contract';

/**
 * The per-product export ("실험 C · 제품별 다듬기"): the model repaints the empty room, and every
 * product is cut out of the room render, drawn large on white, repainted alone by the model as a
 * studio photograph, cut out again and put back where the 3D product stood, under the 3D product's
 * own shadow. This file is the arithmetic: plain RGBA arrays (sRGB bytes, top-down rows), so it runs
 * in the page and in node. The order of work and the requests are in refine-run.ts.
 *
 * Every product stands or falls on its own: a result whose silhouette does not match the 3D
 * product's (after standing it on the same ground point at the same height) is not used, and that
 * product stays the 3D render.
 */

/**
 * A repainted product is used only when its silhouette overlaps the 3D one by at least this (0.85
 * in the first version; 0.90 by the user's decision on 2026-10-03: of the twelve real answers two
 * between 0.89 and 0.90 had changed the product's proportions).
 */
export const REFINE_MIN_IOU = 0.9;
/** Its height may differ from the 3D product's by this factor (a stand-in for "it changed shape"). */
export const REFINE_HEIGHT_RATIO: readonly [number, number] = [0.7, 1.4];
export const REFINE_MAX_PRODUCTS = 12;
/** Requests to the model at once (the page cuts out one picture at a time). */
export const REFINE_CONCURRENCY = 2;
/** Room around the product in its close-up, as a share of its own size, each side. */
export const REFINE_MARGIN = 0.15;
/** The close-up is drawn at this long side and shrunk to the model's input afterwards. */
export const REFINE_CROP_EDGE = 1024;

/** The close-up of one product from RoomViewerRenderer.exportProductCrops. */
export type ProductCrop = {
  id: string;
  width: number;
  height: number;
  /** The product alone on white, RGBA top-down. */
  data: Uint8ClampedArray;
  /** How much of each pixel the product covers, 0–255, top-down. */
  coverage: Uint8Array;
  /** The close-up's window in the frame (0–1, y down). */
  window: [number, number, number, number];
  /** The product's tight box in the frame (0–1, y down). */
  box: [number, number, number, number];
};

// ---------- the model's input ----------
/**
 * The close-up as the model sees it: shrunk (area average) to the input grid of `fluxInputLayout`
 * and padded with white, never stretched.
 */
export function cropModelInput(crop: ProductCrop): { pixels: Pixels; layout: FluxInputLayout } {
  const layout = fluxInputLayout(crop.width, crop.height);
  const data = new Uint8ClampedArray(layout.width * layout.height * 4).fill(255);
  const scale = layout.scale;
  for (let oy = 0; oy < layout.height; oy++)
    for (let ox = 0; ox < layout.width; ox++) {
      const sx0 = (ox - layout.x) / scale,
        sx1 = (ox + 1 - layout.x) / scale,
        sy0 = (oy - layout.y) / scale,
        sy1 = (oy + 1 - layout.y) / scale;
      if (sx1 <= 0 || sy1 <= 0 || sx0 >= crop.width || sy0 >= crop.height) continue;
      const x0 = Math.max(0, Math.floor(sx0)),
        x1 = Math.min(crop.width, Math.ceil(sx1)),
        y0 = Math.max(0, Math.floor(sy0)),
        y1 = Math.min(crop.height, Math.ceil(sy1));
      let r = 0,
        g = 0,
        b = 0,
        weight = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          // Fractional overlap of the source pixel with the output pixel's footprint.
          const w =
            Math.max(0, Math.min(x + 1, sx1) - Math.max(x, sx0)) *
            Math.max(0, Math.min(y + 1, sy1) - Math.max(y, sy0));
          const o = (y * crop.width + x) * 4;
          r += crop.data[o] * w;
          g += crop.data[o + 1] * w;
          b += crop.data[o + 2] * w;
          weight += w;
        }
      if (weight <= 0) continue;
      const o = (oy * layout.width + ox) * 4;
      data[o] = r / weight;
      data[o + 1] = g / weight;
      data[o + 2] = b / weight;
    }
  return { pixels: { width: layout.width, height: layout.height, data }, layout };
}

// ---------- sampling ----------
function clampIndex(value: number, size: number) {
  return Math.max(0, Math.min(size - 1, value));
}
/** Bilinear sample of one channel at a pixel-edge coordinate (the sample at x + 0.5 is pixel x). */
function bilinear(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  channel: number,
  x: number,
  y: number,
) {
  const u = x - 0.5,
    v = y - 0.5;
  const x0 = Math.floor(u),
    y0 = Math.floor(v);
  const fx = u - x0,
    fy = v - y0;
  const at = (px: number, py: number) =>
    data[(clampIndex(py, height) * width + clampIndex(px, width)) * channels + channel];
  return (
    (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
    (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  );
}
/** The alpha of a cut-out (RGBA of any size) on a grid of `size`, 0–1. */
export function cutoutAlpha(cutout: Pixels, size: { width: number; height: number }): Float32Array {
  const out = new Float32Array(size.width * size.height);
  const kx = cutout.width / size.width,
    ky = cutout.height / size.height;
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++)
      out[y * size.width + x] =
        bilinear(cutout.data, cutout.width, cutout.height, 4, 3, (x + 0.5) * kx, (y + 0.5) * ky) / 255;
  return out;
}

// ---------- standing the result on the 3D product ----------
type Bounds = { left: number; top: number; right: number; bottom: number };
function boundsOf(width: number, height: number, covered: (i: number) => boolean): Bounds | undefined {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (covered(y * width + x)) {
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
      }
  return right > left && bottom > top ? { left, top, right, bottom } : undefined;
}
export type Alignment = {
  /** The result's height as a share of the 3D product's, before it is stood on the same height. */
  ratio: number;
  /** Silhouette overlap after the alignment (0–1). */
  iou: number;
  /** Overlap with no alignment at all, for reporting. */
  plainIou: number;
  /** Maps a point of the 3D silhouette's grid (pixel-edge coordinates) to the result's grid. */
  toResult: (x: number, y: number) => [number, number];
};
export type AlignmentFailure = { failure: 'empty' | 'size' };
const solid = (alpha: Float32Array) => (i: number) => alpha[i] > 0.5;
function overlap(a: (x: number, y: number) => boolean, b: (i: number) => boolean, w: number, h: number) {
  let both = 0,
    either = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = a(x, y),
        q = b(y * w + x);
      if (p && q) both++;
      if (p || q) either++;
    }
  return either ? both / either : 0;
}
/**
 * Stands the result's silhouette (`alpha`, 0–1, on the crop's grid) on the 3D product's (`coverage`):
 * the same height, the same ground point (bottom edge, centre of the width). That is what the
 * composite does with it, so that is what is measured. `empty`: nothing found on either side;
 * `size`: the result is much taller or shorter than the product, which no placement fixes.
 */
export function alignToSilhouette(
  alpha: Float32Array,
  coverage: Uint8Array,
  width: number,
  height: number,
): Alignment | AlignmentFailure {
  const ours = boundsOf(width, height, (i) => coverage[i] >= 128);
  const theirs = boundsOf(width, height, solid(alpha));
  if (!ours || !theirs) return { failure: 'empty' };
  const ratio = (theirs.bottom - theirs.top) / (ours.bottom - ours.top);
  if (ratio < REFINE_HEIGHT_RATIO[0] || ratio > REFINE_HEIGHT_RATIO[1]) return { failure: 'size' };
  const s = (ours.bottom - ours.top) / (theirs.bottom - theirs.top);
  const ax = (ours.left + ours.right) / 2,
    ay = ours.bottom,
    bx = (theirs.left + theirs.right) / 2,
    by = theirs.bottom;
  const toResult = (x: number, y: number): [number, number] => [bx + (x - ax) / s, by + (y - ay) / s];
  const isOurs = (i: number) => coverage[i] >= 128;
  const warped = (x: number, y: number) => {
    const [qx, qy] = toResult(x + 0.5, y + 0.5);
    return bilinear(alpha, width, height, 1, 0, qx, qy) > 0.5;
  };
  return {
    ratio,
    iou: overlap(warped, isOurs, width, height),
    plainIou: overlap((x, y) => alpha[y * width + x] > 0.5, isOurs, width, height),
    toResult,
  };
}

// ---------- the product on the frame ----------
/** How much of each frame pixel in `rect` a product's 3D silhouette covers. */
export type OwnMask = { id: string; rect: [number, number, number, number]; own: Float32Array };
/** A repainted product on the frame, over `rect` (frame pixels, right/bottom exclusive). */
export type RefinedLayer = {
  id: string;
  rect: [number, number, number, number];
  /** Linear RGB, its own colour (the white of the close-up taken out of its edge). */
  color: Float32Array;
  alpha: Float32Array;
  own: Float32Array;
  iou: number;
  ratio: number;
};
type Frame = { width: number; height: number };
function frameRect(crop: ProductCrop, frame: Frame): [number, number, number, number] {
  const [left, top, right, bottom] = crop.window;
  return [
    Math.max(0, Math.floor(left * frame.width)),
    Math.max(0, Math.floor(top * frame.height)),
    Math.min(frame.width, Math.ceil(right * frame.width)),
    Math.min(frame.height, Math.ceil(bottom * frame.height)),
  ];
}
/** Crop pixels per frame pixel, and so how many samples per frame pixel and side make an average. */
function supersample(crop: ProductCrop, frame: Frame) {
  const [left, , right] = crop.window;
  const perPixel = crop.width / ((right - left) * frame.width);
  return Math.max(1, Math.min(4, Math.round(perPixel)));
}
/** The crop-grid coordinate (pixel edges) under a frame position (pixel edges). */
function cropAt(crop: ProductCrop, frame: Frame, x: number, y: number): [number, number] {
  const [left, top, right, bottom] = crop.window;
  return [
    ((x / frame.width - left) / (right - left)) * crop.width,
    ((y / frame.height - top) / (bottom - top)) * crop.height,
  ];
}
export function ownMask(crop: ProductCrop, frame: Frame): OwnMask {
  const rect = frameRect(crop, frame);
  const w = rect[2] - rect[0],
    h = rect[3] - rect[1];
  const own = new Float32Array(Math.max(0, w) * Math.max(0, h));
  const n = supersample(crop, frame);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const [cx, cy] = cropAt(crop, frame, rect[0] + x + (i + 0.5) / n, rect[1] + y + (j + 0.5) / n);
          sum += bilinear(crop.coverage, crop.width, crop.height, 1, 0, cx, cy) / 255;
        }
      own[y * w + x] = sum / (n * n);
    }
  return { id: crop.id, rect, own };
}
/**
 * The repainted product on the frame's pixels. `ai` is the model's picture on the crop's grid (see
 * resultOnCapture), `alpha` its cut-out on the same grid; both are read through the alignment, so the
 * product stands where the 3D one stood. The close-up was on white, so an edge pixel is the product
 * blended with white: its own colour is taken out of that.
 */
export function refinedLayer(input: {
  crop: ProductCrop;
  frame: Frame;
  ai: Pixels;
  alpha: Float32Array;
  alignment: Alignment;
}): RefinedLayer {
  const { crop, frame, ai, alpha, alignment } = input;
  const { rect, own } = ownMask(crop, frame);
  const w = rect[2] - rect[0],
    h = rect[3] - rect[1];
  const color = new Float32Array(Math.max(0, w) * Math.max(0, h) * 3);
  const out = new Float32Array(Math.max(0, w) * Math.max(0, h));
  const n = supersample(crop, frame);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      const sum = [0, 0, 0];
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const [cx, cy] = cropAt(crop, frame, rect[0] + x + (i + 0.5) / n, rect[1] + y + (j + 0.5) / n);
          const [qx, qy] = alignment.toResult(cx, cy);
          if (qx < 0 || qy < 0 || qx > ai.width || qy > ai.height) continue;
          const sa = bilinear(alpha, ai.width, ai.height, 1, 0, qx, qy);
          if (sa <= 0.004) continue;
          // The picture as the model drew it (on white), then the white taken out of the edge.
          const observed = [0, 1, 2].map((c) =>
            toLinear(Math.round(bilinear(ai.data, ai.width, ai.height, 4, c, qx, qy))),
          );
          for (let c = 0; c < 3; c++) {
            const pure = sa >= 0.999 ? observed[c] : Math.max(0, Math.min(1, (observed[c] - (1 - sa)) / sa));
            sum[c] += pure * sa;
          }
          a += sa;
        }
      const o = y * w + x;
      out[o] = a / (n * n);
      if (a > 0) for (let c = 0; c < 3; c++) color[o * 3 + c] = sum[c] / a;
    }
  return { id: crop.id, rect, color, alpha: out, own, iou: alignment.iou, ratio: alignment.ratio };
}

/**
 * The frame's fixture layer with the repainted products in place of their 3D selves. Where one
 * product's silhouette is alone on a pixel, its 3D pixels are cleared and the repainted ones put
 * over; where two products overlap nobody knows which is in front, so the 3D render stays there.
 * The repainted product's light follows the 3D product's own in the room (limited, as the room's
 * ring gain is), and the caller's per-fixture gain then follows the model's room as for any fixture.
 */
export function applyRefined(
  layers: RoomLayers,
  refined: readonly RefinedLayer[],
  others: readonly OwnMask[],
): FixtureLayer {
  const base = fixtureLayer(layers);
  const { width, height } = base;
  const ours = Float32Array.from(base.color);
  // How many products' silhouettes cover each pixel (every product counts, repainted or not).
  const count = new Uint8Array(width * height);
  const masks = new Map<string, OwnMask>();
  for (const mask of [...others, ...refined.map(({ id, rect, own }) => ({ id, rect, own }))])
    masks.set(mask.id, mask);
  for (const { rect, own } of masks.values()) {
    const w = rect[2] - rect[0];
    for (let y = rect[1]; y < rect[3]; y++)
      for (let x = rect[0]; x < rect[2]; x++)
        if (own[(y - rect[1]) * w + (x - rect[0])] > 0.25) count[y * width + x]++;
  }

  for (const layer of refined) {
    const { rect } = layer;
    const w = rect[2] - rect[0];
    const alone = (x: number, y: number) =>
      count[y * width + x] - (layer.own[(y - rect[1]) * w + (x - rect[0])] > 0.25 ? 1 : 0) === 0;
    // Its light against the 3D product's, over pixels both cover fully.
    const model = [0, 0, 0],
      render = [0, 0, 0];
    let pixels = 0;
    for (let y = rect[1]; y < rect[3]; y++)
      for (let x = rect[0]; x < rect[2]; x++) {
        const i = (y - rect[1]) * w + (x - rect[0]);
        const at = y * width + x;
        if (layer.own[i] < 0.9 || layer.alpha[i] < 0.9 || !alone(x, y) || base.alpha[at] < 0.9) continue;
        for (let c = 0; c < 3; c++) {
          model[c] += layer.color[i * 3 + c];
          render[c] += ours[at * 3 + c];
        }
        pixels++;
      }
    // The 3D product is the reference: the repainted one is brought to its light, not the reverse.
    const gain = lightGain(render, model, pixels);
    for (let y = rect[1]; y < rect[3]; y++)
      for (let x = rect[0]; x < rect[2]; x++) {
        const i = (y - rect[1]) * w + (x - rect[0]);
        const at = y * width + x;
        if (!alone(x, y)) continue;
        // Its own 3D pixels go; what it covered in the render is the model's room now.
        if (layer.own[i] > 0) base.alpha[at] = 0;
      }
    for (let y = rect[1]; y < rect[3]; y++)
      for (let x = rect[0]; x < rect[2]; x++) {
        const i = (y - rect[1]) * w + (x - rect[0]);
        const at = y * width + x;
        const a = layer.alpha[i];
        if (a <= 0 || !alone(x, y)) continue;
        const behind = base.alpha[at];
        const total = a + behind * (1 - a);
        for (let c = 0; c < 3; c++)
          base.color[at * 3 + c] =
            (layer.color[i * 3 + c] * gain[c] * a + base.color[at * 3 + c] * behind * (1 - a)) / total;
        base.alpha[at] = total;
      }
  }
  return base;
}
