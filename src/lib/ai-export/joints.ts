/**
 * Putting the design's tile joints back on a FLUX result (no AI call; docs/tile-ai-trials-20261113.md,
 * adopted 2026-11-14). In the 496 px model input a 2 mm joint is about 0.2 px, so the model often
 * re-lays a wall at another tile size, turns a staggered bond into a grid or leaves a printed tile
 * plain. On each wall and floor with joints the result keeps only its broad light and colour (a blur
 * wider than a joint) and the render's fine detail (its luminance over its own blur) is multiplied back
 * in. Until 2026-11-15 only faces whose joints drifted were; now every face with joints is, because a
 * face can keep its grid and still lose the fine lines, veins or waves inside its tiles, which no score
 * tells apart from the model's own texture (docs/tile-pattern-trials-20261115.md).
 *
 * Each face's joint score is still measured against a second capture of the same frame with every
 * joint drawn wide enough to see in the model input (`widenJoints`); a face without joints in the
 * design gets none and stays the model's, as do fixtures and the backdrop.
 */
import type { RenderSnapshot } from '../types';
import {
  FIXTURE_REGION,
  projectCapture,
  projectMask,
  shiftMask,
  type Pixels,
  type RegionMask,
} from './color';
import type { FluxInputLayout } from './contract';

/** The widened capture's joints are at least this wide in the model input (pixels). */
export const JOINT_MIN_INPUT_PX = 1.25;
/**
 * A face whose joint score is under this is restored: every face with joints since 2026-11-15 (0.3
 * before, which let faces that kept their grid but lost the pattern inside their tiles go).
 */
export const RESTORE_BELOW = Infinity;
/** The blur that separates broad light from joints, as a share of the picture's width. */
export const LIGHT_BLUR = 0.012;
/** How far the render's detail may darken or lighten the model's light. */
const DETAIL_RANGE = [0.55, 1.5] as const;

// ---------- the widened capture ----------
/** The joint width (mm) that is JOINT_MIN_INPUT_PX in a model input of `inputPxPerMm`. */
export function widenedJointMm(inputPxPerMm: number): number {
  return inputPxPerMm > 0 ? Math.ceil(JOINT_MIN_INPUT_PX / inputPxPerMm) : 10;
}
/** A face point (u across, v down, 0–1) in the frame (0–1, y down); null when the face is not shown. */
export type FaceToFrame = (
  face: 'back' | 'left' | 'right',
  u: number,
  v: number,
) => { x: number; y: number } | null;
/**
 * Model-input pixels per millimetre of the wall seen most squarely (the one whose smaller scale,
 * across or up, is the largest): how thin the joints are where they show best. `frame` is the
 * capture's size in pixels and `scale` the model input's (fluxInputLayout). 0 when no wall shows.
 */
export function inputPxPerMm(
  toFrame: FaceToFrame,
  room: { widthMm: number; depthMm: number; heightMm: number },
  frame: { width: number; height: number },
  scale: number,
): number {
  let best = 0;
  for (const face of ['back', 'left', 'right'] as const) {
    const a = toFrame(face, 0, 0.5),
      b = toFrame(face, 1, 0.5),
      c = toFrame(face, 0.5, 0),
      d = toFrame(face, 0.5, 1);
    if (!a || !b || !c || !d) continue;
    const length = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot((q.x - p.x) * frame.width, (q.y - p.y) * frame.height);
    const across = length(a, b) / (face === 'back' ? room.widthMm : room.depthMm),
      up = length(c, d) / room.heightMm;
    best = Math.max(best, Math.min(across, up));
  }
  return best * scale;
}
/**
 * The same snapshot with every After surface's joints at least `mm` wide (a surface without joints
 * keeps none). Only for measuring: the model never sees it.
 */
export function widenJoints(snapshot: RenderSnapshot, mm: number): RenderSnapshot {
  const scene = structuredClone(snapshot.scene);
  for (const surface of scene.surfaces)
    if (surface.tile.groutWidth > 0) surface.tile.groutWidth = Math.max(mm, surface.tile.groutWidth);
  return { ...snapshot, scene };
}

// ---------- the joint score ----------
type Field = { width: number; height: number; data: Float32Array };
const luminance = (data: ArrayLike<number>, o: number) =>
  0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
/** Gradient magnitude of luminance at half resolution (a 2 × 2 average first). */
export function edgeField(image: Pixels): Field {
  const width = Math.floor(image.width / 2),
    height = Math.floor(image.height / 2);
  const lum = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) sum += luminance(image.data, ((2 * y + j) * image.width + 2 * x + i) * 4);
      lum[y * width + x] = sum / 4;
    }
  const grad = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      grad[i] = Math.hypot(lum[i + 1] - lum[i - 1], lum[i + width] - lum[i - width]);
    }
  return { width, height, data: grad };
}
export type FaceScore = { key: string; kind: 'wall' | 'floor'; pixels: number; score: number };
/** How far a face's lines may sit from the reference's and still count (half-resolution pixels). */
const REACH = 3;
/** A face's rim left out, wider than REACH so a corner or a fixture's outline never counts. */
const RIM = 6;
/** A face smaller than this share of the picture is not scored. */
const MIN_SHARE = 0.01;
/** A face whose widened capture has edges weaker than this (variance, grey levels²) has no joints. */
const MIN_EDGE_VARIANCE = 1;
/**
 * The joint score of each face: the best correlation of the two pictures' edges inside the face, the
 * result moved by up to REACH pixels around the whole-picture shift (`dx`, `dy`, result pixels). The
 * face's rim and fixtures are left out. `mask` is at the pictures' size.
 */
export function faceScores(reference: Pixels, result: Pixels, mask: RegionMask, dx = 0, dy = 0): FaceScore[] {
  const a = edgeField(reference),
    b = edgeField(result);
  const { width, height } = a;
  // Each half-resolution pixel's face, or 0 at a rim, a fixture or the backdrop.
  const label = new Uint8Array(width * height);
  const at = (x: number, y: number) =>
    mask.data[Math.min(mask.height - 1, 2 * y) * mask.width + Math.min(mask.width - 1, 2 * x)];
  for (let y = RIM; y < height - RIM; y++)
    for (let x = RIM; x < width - RIM; x++) {
      const own = at(x, y);
      if (!own || own === FIXTURE_REGION) continue;
      if (
        [RIM, RIM / 2].every(
          (d) => at(x - d, y) === own && at(x + d, y) === own && at(x, y - d) === own && at(x, y + d) === own,
        )
      )
        label[y * width + x] = own;
    }
  const sx = Math.round(dx / 2),
    sy = Math.round(dy / 2);
  return mask.regions.flatMap((region, index) => {
    const own = index + 1;
    const where: number[] = [];
    for (let i = 0; i < label.length; i++) if (label[i] === own) where.push(i);
    if (where.length < width * height * MIN_SHARE) return [];
    // A face without joints in the design (a seamless surface) has nothing to judge.
    let sum = 0,
      squares = 0;
    for (const i of where) {
      sum += a.data[i];
      squares += a.data[i] * a.data[i];
    }
    if (squares / where.length - (sum / where.length) ** 2 < MIN_EDGE_VARIANCE) return [];
    let best = -1;
    for (let oy = -REACH; oy <= REACH; oy++)
      for (let ox = -REACH; ox <= REACH; ox++) {
        let n = 0,
          sa = 0,
          sb = 0,
          saa = 0,
          sbb = 0,
          sab = 0;
        for (const i of where) {
          const x = (i % width) + sx + ox,
            y = Math.floor(i / width) + sy + oy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const va = a.data[i],
            vb = b.data[y * width + x];
          n++;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
        if (n < where.length / 2) continue;
        const cov = sab - (sa * sb) / n,
          va = saa - (sa * sa) / n,
          vb = sbb - (sb * sb) / n;
        best = Math.max(best, va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0);
      }
    return [{ key: region.key, kind: region.kind, pixels: where.length, score: +best.toFixed(3) }];
  });
}

// ---------- putting the joints back ----------
/**
 * A box blur (two passes each way) of `value` weighted by `weight` (0 or 1): pixels outside the
 * weight do not bleed in. `cover` is the weighted share of the blur's window (1 deep inside).
 */
export function blurInside(
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
  const full = (2 * radius + 1) ** 4;
  const mean = new Float32Array(value.length),
    cover = new Float32Array(value.length);
  for (let i = 0; i < value.length; i++) {
    mean[i] = bottom[i] > 0 ? top[i] / bottom[i] : value[i];
    cover[i] = bottom[i] / full;
  }
  return { mean, cover };
}

/** Cells (pixels) the object search works in. */
const CELL = 4;
/** The median's window, in cells each way (an object up to about half of it is found). */
const MEDIAN_CELLS = 5;
/** A cell this much darker than the face around it (against the render) is an object the model added. */
const OBJECT_DARKER = 0.75;
/** Under this share of its window left, a pixel's light comes from the wider blur. */
const MIN_COVER = 0.25;

/**
 * Where on one face the model drew something dark that the render does not have (a toilet-roll
 * holder, a handle, a glass partition's frame, an invented shadow): per cell, the model's brightness
 * over the render's, against the median of the cells around it. The render's own shadows are in both
 * and cancel; a lighting gradient moves the median with it. Returns 1 per pixel to leave out.
 */
function addedObjects(result: Pixels, refLum: Float32Array, weight: Float32Array) {
  const { width, height } = result;
  const gw = Math.ceil(width / CELL),
    gh = Math.ceil(height / CELL);
  const ai = new Float32Array(gw * gh),
    ref = new Float32Array(gw * gh),
    n = new Float32Array(gw * gh);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!weight[i]) continue;
      const c = Math.floor(y / CELL) * gw + Math.floor(x / CELL);
      ai[c] += luminance(result.data, i * 4);
      ref[c] += refLum[i];
      n[c]++;
    }
  const q = new Float32Array(gw * gh).fill(NaN);
  for (let c = 0; c < q.length; c++) if (n[c] >= (CELL * CELL) / 2) q[c] = ai[c] / Math.max(1, ref[c]);
  const dark = new Uint8Array(gw * gh);
  const window = new Float32Array((2 * MEDIAN_CELLS + 1) ** 2);
  for (let cy = 0; cy < gh; cy++)
    for (let cx = 0; cx < gw; cx++) {
      const own = q[cy * gw + cx];
      if (Number.isNaN(own)) continue;
      let k = 0;
      for (let y = Math.max(0, cy - MEDIAN_CELLS); y <= Math.min(gh - 1, cy + MEDIAN_CELLS); y++)
        for (let x = Math.max(0, cx - MEDIAN_CELLS); x <= Math.min(gw - 1, cx + MEDIAN_CELLS); x++) {
          const value = q[y * gw + x];
          if (!Number.isNaN(value)) window[k++] = value;
        }
      if (k < 10) continue;
      const sorted = window.subarray(0, k).sort();
      if (own < sorted[k >> 1] * OBJECT_DARKER) dark[cy * gw + cx] = 1;
    }
  // One cell around each, for the object's soft edge and shadow.
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(x / CELL),
        cy = Math.floor(y / CELL);
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++)
        for (let dx = -1; dx <= 1 && !hit; dx++) {
          const nx = cx + dx,
            ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) hit = dark[ny * gw + nx];
        }
      out[y * width + x] = hit;
    }
  return out;
}

/**
 * The result with the render's fine detail on the faces `labels` names (mask labels, 1-based).
 * `reference` and `mask` are at the result's size, the mask already moved by the model's shift, and
 * `shift` (result pixels) says where the reference's pixel of a result pixel is. On those faces a dark
 * object the model added is left out of the light, so it goes rather than staying as a smudge.
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
  // The reference's pixel under each result pixel (its own pixel past the edge).
  const refLumAll = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rx = Math.max(0, Math.min(width - 1, x - shift.dx)),
        ry = Math.max(0, Math.min(height - 1, y - shift.dy));
      refLumAll[y * width + x] = luminance(reference.data, (ry * width + rx) * 4);
    }
  // Each face is worked on inside its box grown by the widest blur's reach (two passes of
  // radius × 4 each way), on the object search's cell grid: the same numbers as on the whole
  // picture, at a fraction of the cost when every face is restored.
  const reach = 2 * radius * 4 + 2 * CELL;
  for (const label of labels) {
    if (label === FIXTURE_REGION || label < 1) continue;
    let minX = width,
      minY = height,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (mask.data[y * width + x] === label) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
    if (maxX < 0) continue;
    const x0 = Math.max(0, Math.floor((minX - reach) / CELL) * CELL),
      y0 = Math.max(0, Math.floor((minY - reach) / CELL) * CELL),
      x1 = Math.min(width, maxX + reach + 1),
      y1 = Math.min(height, maxY + reach + 1);
    const w = x1 - x0,
      h = y1 - y0,
      count = w * h;
    const at = (i: number) => (y0 + Math.floor(i / w)) * width + x0 + (i % w);
    const weight = new Float32Array(count),
      refLum = new Float32Array(count),
      ones = new Float32Array(count).fill(1);
    const data = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      const j = at(i);
      if (mask.data[j] === label) weight[i] = 1;
      refLum[i] = refLumAll[j];
      for (let c = 0; c < 4; c++) data[i * 4 + c] = result.data[j * 4 + c];
    }
    const local: Pixels = { width: w, height: h, data };
    const refLight = blurInside(refLum, weight, w, h, radius).mean;
    // The light comes from the face without the objects the model added.
    const objects = addedObjects(local, refLum, weight);
    const lit = new Float32Array(count);
    for (let i = 0; i < count; i++) lit[i] = weight[i] && !objects[i] ? 1 : 0;
    // Near the face's rim the detail fades in over a few pixels.
    const inside = blurInside(weight, ones, w, h, 2).mean;
    const channels = [0, 1, 2].map((c) => {
      const plane = new Float32Array(count);
      for (let i = 0; i < count; i++) plane[i] = data[i * 4 + c];
      const near = blurInside(plane, lit, w, h, radius),
        far = blurInside(plane, lit, w, h, radius * 4);
      // Inside a large object the near window is empty: the wider one fills it.
      const light = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const t = Math.min(1, near.cover[i] / MIN_COVER);
        light[i] = far.cover[i] > 0 ? near.mean[i] * t + far.mean[i] * (1 - t) : plane[i];
      }
      return light;
    });
    for (let i = 0; i < count; i++) {
      if (!weight[i]) continue;
      const detail = Math.max(
        DETAIL_RANGE[0],
        Math.min(DETAIL_RANGE[1], refLum[i] / Math.max(1, refLight[i])),
      );
      const alpha = Math.max(0, Math.min(1, (inside[i] - 0.5) * 2));
      const j = at(i);
      for (let c = 0; c < 3; c++)
        out[j * 4 + c] = Math.round(data[i * 4 + c] * (1 - alpha) + channels[c][i] * detail * alpha);
    }
  }
  return { width, height, data: out };
}

export type JointRestore = {
  /** The faces whose joints drifted, with their scores (all scored faces in `scores`). */
  restored: FaceScore[];
  scores: FaceScore[];
  /** `onto` with those faces' joints put back; absent when no face needed it. */
  image?: Pixels;
};
/**
 * The whole step for one result that kept the framing: score each face against the widened capture,
 * then put the joints back on the faces under RESTORE_BELOW (every face with joints). `capture` and `joints` are the render and
 * its widened copy at capture size, `mask` their regions, `frame` the model's shift (result pixels) as
 * the colour check measured it. The faces are judged on `result` (the model's own picture); the joints
 * go onto `onto` (the colour-corrected result, by default `result`).
 */
export function restoreResultJoints(input: {
  capture: Pixels;
  joints: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  result: Pixels;
  frame: { dx: number; dy: number };
  onto?: Pixels;
  /** Faces under this joint score are restored (RESTORE_BELOW; Infinity restores every scored face). */
  restoreBelow?: number;
}): JointRestore {
  const { capture, joints, mask, layout, result, frame } = input;
  const below = input.restoreBelow ?? RESTORE_BELOW;
  const size = { width: result.width, height: result.height };
  const projected = projectMask(mask, layout, size);
  const scores = faceScores(projectCapture(joints, layout, size), result, projected, frame.dx, frame.dy);
  const restored = scores.filter((face) => face.score < below);
  if (!restored.length) return { restored, scores };
  const labels = new Set(
    restored.map((face) => mask.regions.findIndex((region) => region.key === face.key) + 1),
  );
  const image = restoreJoints(
    projectCapture(capture, layout, size),
    input.onto ?? result,
    shiftMask(projected, frame.dx, frame.dy),
    labels,
    frame,
  );
  return { restored, scores, image };
}
