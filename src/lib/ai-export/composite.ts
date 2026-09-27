import type { FluxInputLayout } from './contract';
import { FIXTURE_REGION, reviewResultColors, type ColorReview, type Pixels, type RegionMask } from './color';

/**
 * The composite FLUX export: the model repaints an empty room, and our own fixtures (drawn by the
 * 3D renderer on the same camera) go back on top, pixel for pixel where the render put them. The
 * model never draws or moves a fixture, so it cannot change a product's shape or add one where a
 * product stands. Plain RGBA arrays (sRGB bytes, top-down rows), so it runs in the page and in node.
 *
 * Nothing here moves or resizes a fixture: only its light and colour follow the model's room, within
 * limits, and its edge is softened by at most one pixel.
 */

export type RoomLayers = {
  width: number;
  height: number;
  /** The frame with fixtures, as the plain export draws it. */
  full: Uint8ClampedArray;
  /** The room with the fixtures' shadows and contact shade, fixtures hidden. */
  shadowed: Uint8ClampedArray;
  /** The room with no fixtures at all (the model's input). */
  empty: Uint8ClampedArray;
  /** Fixture coverage per pixel, 0–255. */
  coverage: Uint8Array;
};

const DECODE = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
export const toLinear = (byte: number) => DECODE[byte];
export function toByte(linear: number) {
  const c = Math.max(0, Math.min(1, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}
const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ---------- the model's result back on the capture's pixels ----------
/**
 * The FLUX result at the capture's size and pixel grid. The model saw the capture scaled by
 * `layout.scale` and centred with white padding at (layout.x, layout.y) in a `layout.width` ×
 * `layout.height` input, and answered at a multiple of that size (2× today). Capture pixel centre
 * (x + 0.5, y + 0.5) is input point (layout.x + (x + 0.5)·scale, layout.y + (y + 0.5)·scale), which
 * is result point × result.width / layout.width; sampled bilinearly.
 */
export function resultOnCapture(
  result: Pixels,
  layout: FluxInputLayout,
  size: { width: number; height: number },
): Pixels {
  const kx = result.width / layout.width,
    ky = result.height / layout.height;
  // The capture may be drawn at another size than the one the layout was made for.
  const sx = layout.contentWidth / size.width,
    sy = layout.contentHeight / size.height;
  const out = new Uint8ClampedArray(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) {
    const v = (layout.y + (y + 0.5) * sy) * ky - 0.5;
    const y0 = Math.max(0, Math.min(result.height - 1, Math.floor(v))),
      y1 = Math.min(result.height - 1, y0 + 1),
      fy = Math.max(0, Math.min(1, v - y0));
    for (let x = 0; x < size.width; x++) {
      const u = (layout.x + (x + 0.5) * sx) * kx - 0.5;
      const x0 = Math.max(0, Math.min(result.width - 1, Math.floor(u))),
        x1 = Math.min(result.width - 1, x0 + 1),
        fx = Math.max(0, Math.min(1, u - x0));
      const o = (y * size.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const at = (px: number, py: number) => result.data[(py * result.width + px) * 4 + c];
        out[o + c] =
          (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
          (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: size.width, height: size.height, data: out };
}

// ---------- layers ----------
export type FixtureLayer = {
  width: number;
  height: number;
  /** The fixtures' own linear RGB (unmixed from the room behind), 0 where uncovered. */
  color: Float32Array;
  /** Coverage 0–1. */
  alpha: Float32Array;
};
/**
 * The fixtures' own colour: the render mixed them over the shadowed room in linear light
 * (full = F·α + shadowed·(1 − α)), so F = (full − shadowed·(1 − α)) / α.
 */
export function fixtureLayer(layers: RoomLayers): FixtureLayer {
  const n = layers.width * layers.height;
  const color = new Float32Array(n * 3),
    alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = layers.coverage[i] / 255;
    alpha[i] = a;
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const full = DECODE[layers.full[i * 4 + c]],
        room = DECODE[layers.shadowed[i * 4 + c]];
      color[i * 3 + c] = Math.max(0, (full - room * (1 - a)) / a);
    }
  }
  return { width: layers.width, height: layers.height, color, alpha };
}
/**
 * The fixtures' shadow on the room as a light multiplier (linear luminance of shadowed ÷ empty,
 * never above 1): their cast shadows and contact shade, applied to the model's room.
 */
export function shadowLayer(layers: RoomLayers): Float32Array {
  const n = layers.width * layers.height;
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lit = luminance(DECODE[layers.empty[o]], DECODE[layers.empty[o + 1]], DECODE[layers.empty[o + 2]]);
    const dark = luminance(
      DECODE[layers.shadowed[o]],
      DECODE[layers.shadowed[o + 1]],
      DECODE[layers.shadowed[o + 2]],
    );
    ratio[i] = lit > 1e-4 ? Math.max(0, Math.min(1, dark / lit)) : 1;
  }
  return ratio;
}

// ---------- light matching ----------
/** Light gain on a fixture stays within these (the model's room may be much brighter or darker). */
export const MIN_GAIN = 0.75;
export const MAX_GAIN = 1.3;
/** Each channel may move this far from the luminance gain (warmth follows the room, a little). */
export const MAX_TINT = 0.08;
/** The ring of room around a fixture that sets its light, in capture pixels from its silhouette. */
export const RING = [4, 20] as const;
export type Gain = [number, number, number];
export type FixtureGain = { box: [number, number, number, number]; gain: Gain; ringPixels: number };

/** Chessboard distance (capped) from every pixel to the nearest covered pixel. */
function distanceToFixture(alpha: Float32Array, width: number, height: number, cap: number) {
  const d = new Uint16Array(width * height).fill(cap);
  for (let i = 0; i < d.length; i++) if (alpha[i] > 0) d[i] = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - width] + 1);
        if (x > 0) v = Math.min(v, d[i - width - 1] + 1);
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + 1);
      }
      d[i] = v;
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i];
      if (x < width - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < height - 1) {
        v = Math.min(v, d[i + width] + 1);
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + 1);
        if (x > 0) v = Math.min(v, d[i + width - 1] + 1);
      }
      d[i] = v;
    }
  return d;
}
/**
 * One light gain per fixture box: the model's room over our empty room in the ring around the
 * fixture (walls and floor only, outside its shadow), luminance first, then a limited tint.
 * Boxes are normalised [left, top, right, bottom] of the capture.
 */
export function fixtureGains(input: {
  ai: Pixels;
  layers: RoomLayers;
  mask: RegionMask;
  shadow: Float32Array;
  boxes: [number, number, number, number][];
}): FixtureGain[] {
  const { ai, layers, mask, shadow, boxes } = input;
  const { width, height } = layers;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = layers.coverage[i] / 255;
  const distance = distanceToFixture(alpha, width, height, RING[1] + 1);
  const label = (x: number, y: number) =>
    mask.data[
      Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height)) * mask.width +
        Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width))
    ];
  return boxes.map((box) => {
    const pad = 0.12;
    const bw = box[2] - box[0],
      bh = box[3] - box[1];
    const x0 = Math.max(0, Math.floor((box[0] - bw * pad) * width)),
      x1 = Math.min(width, Math.ceil((box[2] + bw * pad) * width)),
      y0 = Math.max(0, Math.floor((box[1] - bh * pad) * height)),
      y1 = Math.min(height, Math.ceil((box[3] + bh * pad) * height));
    const model = [0, 0, 0],
      ours = [0, 0, 0];
    let count = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * width + x;
        if (distance[i] < RING[0] || distance[i] > RING[1] || shadow[i] < 0.95) continue;
        const l = label(x, y);
        if (l === 0 || l === FIXTURE_REGION) continue;
        for (let c = 0; c < 3; c++) {
          model[c] += ai.data[i * 4 + c];
          ours[c] += layers.empty[i * 4 + c];
        }
        count++;
      }
    // Averaged as stored (sRGB), then made linear: the model's softer texture (fine speckles blurred
    // in sRGB) keeps its sRGB mean but not its linear one, and must not read as a darker room.
    const linear = (sum: number[]) => sum.map((v) => srgbToLinear(v / Math.max(1, count)) * count);
    return { box, gain: lightGain(linear(model), linear(ours), count), ringPixels: count };
  });
}
function srgbToLinear(byte: number) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** The limited gain from summed linear RGB of the model's ring and ours. */
export function lightGain(model: number[], ours: number[], count: number): Gain {
  if (count < 20) return [1, 1, 1];
  const lm = luminance(model[0], model[1], model[2]),
    lo = luminance(ours[0], ours[1], ours[2]);
  if (lo <= 1e-6 || lm <= 1e-6) return [1, 1, 1];
  const base = Math.max(MIN_GAIN, Math.min(MAX_GAIN, lm / lo));
  return [0, 1, 2].map((c) => {
    const tint = ours[c] > 1e-6 ? model[c] / ours[c] / (lm / lo) : 1;
    return base * Math.max(1 - MAX_TINT, Math.min(1 + MAX_TINT, tint));
  }) as Gain;
}

// ---------- composite ----------
/**
 * The final image: the model's room (on the capture grid) with the fixtures' shadow multiplied in,
 * and the fixtures over it with their own colour at their render position. `gains` light each
 * fixture box; `feather` softens coverage edges by one pixel (a 3×3 mean of the partial edge only:
 * a fully covered or uncovered neighbourhood is unchanged, so the silhouette does not move).
 */
export function compositeFixtures(input: {
  room: Pixels;
  fixtures: FixtureLayer;
  shadow: Float32Array;
  gains?: FixtureGain[];
  feather?: boolean;
}): Pixels {
  const { room, fixtures, shadow } = input;
  const { width, height } = fixtures;
  if (room.width !== width || room.height !== height) throw new Error('합성할 이미지 크기가 달라요.');
  const alpha = input.feather ? featherEdge(fixtures.alpha, width, height) : fixtures.alpha;
  // The smallest box holding a pixel sets its gain (a basin in front of a larger vanity keeps its own).
  const gains = [...(input.gains ?? [])].sort(
    (a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]),
  );
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        o = i * 4;
      const a = alpha[i];
      let gain: Gain = [1, 1, 1];
      if (a > 0)
        for (const g of gains) {
          const [l, t, r, b] = g.box;
          if (
            (x + 0.5) / width >= l &&
            (x + 0.5) / width <= r &&
            (y + 0.5) / height >= t &&
            (y + 0.5) / height <= b
          ) {
            gain = g.gain;
            break;
          }
        }
      for (let c = 0; c < 3; c++) {
        const behind = DECODE[room.data[o + c]] * shadow[i];
        out[o + c] = toByte(a > 0 ? fixtures.color[i * 3 + c] * gain[c] * a + behind * (1 - a) : behind);
      }
      out[o + 3] = 255;
    }
  return { width, height, data: out };
}
function featherEdge(alpha: Float32Array, width: number, height: number) {
  const out = Float32Array.from(alpha);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      let sum = 0,
        min = 1,
        max = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = alpha[i + dy * width + dx];
          sum += v;
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      // Only where the edge already is (partly covered pixels, which have the fixture's colour):
      // fully inside or outside stays exactly as rendered, and the outline never grows.
      if (max > 0 && min < 1 && alpha[i] > 0 && alpha[i] < 1) out[i] = sum / 9;
    }
  return out;
}

// ---------- experiment B: grey placeholders ----------
/** Neutral mid grey, sRGB. */
export const PLACEHOLDER_GREY = 138;
/**
 * The empty room with a flat grey stand-in where each opaque fixture will go, `inset` pixels
 * inside its silhouette so the fixture layer covers it completely. Glass (partial coverage) gets
 * none: the room shows through it.
 */
export function placeholderRoom(layers: RoomLayers, inset = 3): Pixels {
  const { width, height } = layers;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = layers.coverage[i] >= 250 ? 0 : 1;
  // Distance from every pixel to the nearest not-fully-covered one.
  const inside = distanceToFixture(alpha, width, height, inset + 1);
  const data = Uint8ClampedArray.from(layers.empty);
  for (let i = 0; i < inside.length; i++)
    if (inside[i] > inset) data.set([PLACEHOLDER_GREY, PLACEHOLDER_GREY, PLACEHOLDER_GREY, 255], i * 4);
  return { width, height, data };
}

// ---------- the model's room against ours ----------
/** Beyond this many capture pixels (at 1024 wide) of floor-line offset, fixtures may look afloat. */
export const MAX_FLOOR_OFFSET = 6;
/**
 * How far the model moved the wall–floor line: for sampled columns, the row of the render's first
 * floor pixel under a wall, then the strongest vertical edge within ±`reach` rows of the model's
 * room there. Columns near a fixture are skipped. The median offset (positive: model's line lower)
 * and how many columns agreed.
 */
export function floorLineOffset(
  ai: Pixels,
  mask: RegionMask,
  coverage: Uint8Array,
  reach = 24,
): { offset: number; columns: number } {
  const { width, height } = ai;
  const floor = new Set(mask.regions.flatMap((r, i) => (r.kind === 'floor' ? [i + 1] : [])));
  const wall = new Set(mask.regions.flatMap((r, i) => (r.kind === 'wall' ? [i + 1] : [])));
  const labelAt = (x: number, y: number) =>
    mask.data[
      Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height)) * mask.width +
        Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width))
    ];
  const lum = (x: number, y: number) => {
    let sum = 0;
    for (let dx = -2; dx <= 2; dx++) {
      const o = (y * width + Math.max(0, Math.min(width - 1, x + dx))) * 4;
      sum += luminance(ai.data[o], ai.data[o + 1], ai.data[o + 2]);
    }
    return sum / 5;
  };
  const offsets: number[] = [];
  const step = Math.max(2, Math.round(width / 128));
  for (let x = step; x < width - step; x += step) {
    let line = -1;
    for (let y = 1; y < height; y++)
      if (floor.has(labelAt(x, y)) && wall.has(labelAt(x, y - 1))) {
        line = y;
        break;
      }
    if (line < reach + 2 || line > height - reach - 3) continue;
    let near = false;
    for (let y = line - reach; y <= line + reach && !near; y++)
      for (let dx = -8; dx <= 8 && !near; dx += 4) {
        const xx = Math.max(0, Math.min(width - 1, x + dx));
        if (coverage[y * width + xx] > 0) near = true;
      }
    if (near) continue;
    let best = 0,
      at = 0;
    // The step into row y (the first floor row, as the mask's line is), not a centred difference,
    // which ties between the two rows of a sharp edge.
    for (let y = line - reach; y <= line + reach; y++) {
      const edge = Math.abs(lum(x, y) - lum(x, y - 1));
      if (edge > best) {
        best = edge;
        at = y;
      }
    }
    if (best > 3) offsets.push(at - line);
  }
  if (!offsets.length) return { offset: 0, columns: 0 };
  offsets.sort((a, b) => a - b);
  return { offset: offsets[Math.floor(offsets.length / 2)], columns: offsets.length };
}

// ---------- one result ----------
export type ComposedResult = {
  /** The colour check of the model's room against what it was sent (faces only). */
  review: ColorReview;
  floor: { offset: number; columns: number };
  /** The model moved the room's floor line or reframed: fixtures may look afloat. */
  shifted: boolean;
  /** Our fixtures on the model's room as it came. */
  raw: Pixels;
  /** The same on the colour-corrected room; absent when the check could not correct. */
  corrected?: Pixels;
};
/**
 * Everything after the model answers, for one result: the colour check against its input, the
 * floor-line check, and the fixtures composited on the model's room (as it came and, when the
 * framing held, colour-corrected). `input` is what the model was sent, at capture size; `boxes`
 * are the fixtures' normalised capture boxes, for their light.
 */
export function composeFluxResult(input: {
  result: Pixels;
  input: Pixels;
  layers: RoomLayers;
  mask: RegionMask;
  layout: FluxInputLayout;
  boxes: [number, number, number, number][];
}): ComposedResult {
  const { result, layers, mask, layout, boxes } = input;
  const fixtures = fixtureLayer(layers),
    shadow = shadowLayer(layers);
  const size = { width: layers.width, height: layers.height };
  const room = resultOnCapture(result, layout, size);
  // The floor line decides: in an empty room the whole-picture search is broad (it reported up to
  // 24 result px where the floor moved 1–5, and 0.22 where the model erased a grey placeholder).
  // A kept floor line also aligns the colour check (vertical shift only; sideways is not measured).
  const floor = floorLineOffset(room, mask, layers.coverage);
  const measured = floor.columns >= 8;
  const offFloor = Math.abs(floor.offset) > (MAX_FLOOR_OFFSET * layers.width) / 1024;
  const toResult = layout.scale * (result.width / layout.width);
  const review = reviewResultColors({
    capture: input.input,
    mask,
    layout,
    result,
    ...(measured && !offFloor ? { alignment: { dx: 0, dy: Math.round(floor.offset * toResult) } } : {}),
  });
  const shifted = measured ? offFloor : !review.framing.aligned;
  const on = (model: Pixels) =>
    compositeFixtures({
      room: model,
      fixtures,
      shadow,
      gains: fixtureGains({ ai: model, layers, mask, shadow, boxes }),
      feather: true,
    });
  return {
    review,
    floor,
    shifted,
    raw: on(room),
    ...(review.corrected ? { corrected: on(resultOnCapture(review.corrected, layout, size)) } : {}),
  };
}
