/**
 * Where the input photo's camera stood, found from the product's silhouette.
 *
 * TripoSR rebuilds a product from one photo, so the photographed side of the mesh lines up with the
 * photo again when seen from the camera the model assumed (about +x, +z up, 40° wide, 1.9 away).
 * That camera is only about right: the model also adapts to a photo taken from a diagonal or from
 * above. So the camera is searched for, and the one thing the search is judged by is how well the
 * mesh's outline covers the photo's cut-out (intersection over union). Nothing else is assumed.
 *
 * Coordinates are the mesh's own (+z up). Images are square, y down; image positions are in half
 * image widths from the centre, so the photo spans −1…1 in both directions.
 */
export interface PhotoCamera {
  /** Degrees around +z from +x towards +y. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
  /** From the origin, in mesh units. */
  distance: number;
  /** Focal length in half image widths: 1 / tan(field of view / 2). */
  focal: number;
  /** Where the origin lands in the image, in half image widths (x right, y up). */
  shift: [number, number];
}

/** The camera TripoSR is built for: on +x, level, 40° field of view, 1.9 from the middle. */
export const SOURCE_CAMERA: PhotoCamera = {
  azimuth: 0,
  elevation: 0,
  distance: 1.9,
  focal: 1 / Math.tan((20 * Math.PI) / 180),
  shift: [0, 0],
};

/** The search accepts a camera when the outline overlaps the photo's by at least this much. */
export const MIN_PHOTO_IOU = 0.85;

const RADIANS = Math.PI / 180;
const LIMITS = {
  azimuth: [-100, 100],
  elevation: [-60, 70],
  distance: [1.2, 6],
  focal: [1.2, 8],
  shift: [-0.6, 0.6],
} as const;

export interface CameraBasis {
  position: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
}

export function cameraBasis(camera: PhotoCamera): CameraBasis {
  const az = camera.azimuth * RADIANS,
    el = camera.elevation * RADIANS;
  const dir: [number, number, number] = [
    Math.cos(el) * Math.cos(az),
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
  ];
  const forward: [number, number, number] = [-dir[0], -dir[1], -dir[2]];
  // right = forward × world up, up = right × forward
  const rx = forward[1],
    ry = -forward[0];
  const rl = Math.hypot(rx, ry) || 1;
  const right: [number, number, number] = [rx / rl, ry / rl, 0];
  const up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return {
    position: [dir[0] * camera.distance, dir[1] * camera.distance, dir[2] * camera.distance],
    right,
    up,
    forward,
  };
}

export interface Projected {
  /** Pixel position (pixel centres at +0.5) and distance along the view direction, per vertex. */
  x: Float32Array;
  y: Float32Array;
  depth: Float32Array;
}

/** Projects every vertex (or every `stride`-th) into a `size` × `size` picture. */
export function projectVertices(
  positions: Float32Array,
  camera: PhotoCamera,
  size: number,
  stride = 1,
): Projected {
  const count = Math.ceil(positions.length / 3 / stride);
  const x = new Float32Array(count),
    y = new Float32Array(count),
    depth = new Float32Array(count);
  const { position: c, right, up, forward } = cameraBasis(camera);
  const half = size / 2;
  for (let i = 0; i < count; i++) {
    const v = i * stride * 3;
    const dx = positions[v] - c[0],
      dy = positions[v + 1] - c[1],
      dz = positions[v + 2] - c[2];
    const z = dx * forward[0] + dy * forward[1] + dz * forward[2];
    const inverse = camera.focal / Math.max(z, 1e-6);
    x[i] = ((dx * right[0] + dy * right[1] + dz * right[2]) * inverse + camera.shift[0] + 1) * half;
    y[i] = (1 - ((dx * up[0] + dy * up[1] + dz * up[2]) * inverse + camera.shift[1])) * half;
    depth[i] = z;
  }
  return { x, y, depth };
}

/**
 * The outline of the vertices as a mask (1 inside): every vertex marks its pixel, then one round of
 * closing fills the gaps between them. The mesh is dense enough at these sizes that nothing more is needed.
 */
export function outlineMask(projected: Projected, size: number, into = new Uint8Array(size * size)) {
  into.fill(0);
  for (let i = 0; i < projected.x.length; i++) {
    const px = Math.floor(projected.x[i]),
      py = Math.floor(projected.y[i]);
    if (px >= 0 && py >= 0 && px < size && py < size) into[py * size + px] = 1;
  }
  const grown = new Uint8Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < size && into[yy * size + xx]) {
            hit = 1;
            break;
          }
        }
      }
      grown[y * size + x] = hit;
    }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < size && !grown[yy * size + xx]) {
            all = 0;
            break;
          }
        }
      }
      into[y * size + x] = all;
    }
  return into;
}

/** Intersection over union of two masks of the same size (1 when both are empty). */
export function maskIou(a: Uint8Array, b: Uint8Array) {
  let both = 0,
    either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
  }
  return either ? both / either : 1;
}

/** The photo's cut-out at a smaller size: a pixel is inside when half or more of its block is. */
export function shrinkMask(alpha: Uint8Array | Uint8ClampedArray, from: number, to: number, threshold = 128) {
  const out = new Uint8Array(to * to);
  const block = from / to;
  for (let y = 0; y < to; y++)
    for (let x = 0; x < to; x++) {
      let inside = 0,
        total = 0;
      for (let yy = Math.floor(y * block); yy < Math.floor((y + 1) * block); yy++)
        for (let xx = Math.floor(x * block); xx < Math.floor((x + 1) * block); xx++) {
          total++;
          if (alpha[yy * from + xx] >= threshold) inside++;
        }
      out[y * to + x] = total && inside * 2 >= total ? 1 : 0;
    }
  return out;
}

const clamp = (value: number, [low, high]: readonly [number, number] | readonly number[]) =>
  Math.min(high, Math.max(low, value));

export const clampCamera = (camera: PhotoCamera): PhotoCamera => ({
  azimuth: clamp(camera.azimuth, LIMITS.azimuth),
  elevation: clamp(camera.elevation, LIMITS.elevation),
  distance: clamp(camera.distance, LIMITS.distance),
  focal: clamp(camera.focal, LIMITS.focal),
  shift: [clamp(camera.shift[0], LIMITS.shift), clamp(camera.shift[1], LIMITS.shift)],
});

/** The overlap of the mesh's outline, seen from `camera`, with the photo's cut-out (see fitPhotoCamera). */
export function outlineIou(
  positions: Float32Array,
  alpha: Uint8Array | Uint8ClampedArray,
  size: number,
  camera: PhotoCamera,
  resolution = 256,
) {
  const stride = Math.max(1, Math.floor(positions.length / 3 / 120_000));
  return maskIou(
    outlineMask(projectVertices(positions, camera, resolution, stride), resolution),
    shrinkMask(alpha, size, resolution),
  );
}

/** Whether a camera read back from storage can be used as it is. */
export function validPhotoCamera(camera: PhotoCamera) {
  const again = clampCamera(camera);
  return (
    Number.isFinite(camera.azimuth) &&
    Number.isFinite(camera.elevation) &&
    Number.isFinite(camera.distance) &&
    Number.isFinite(camera.focal) &&
    camera.shift.every(Number.isFinite) &&
    again.azimuth === camera.azimuth &&
    again.elevation === camera.elevation &&
    again.distance === camera.distance &&
    again.focal === camera.focal &&
    again.shift[0] === camera.shift[0] &&
    again.shift[1] === camera.shift[1]
  );
}

/**
 * The search's own coordinates: the picture's scale (focal length / distance) is kept apart from
 * the perspective (the distance), because moving along the one at a fixed other is what the
 * outline is sensitive to.
 */
type Parameters = [
  azimuth: number,
  elevation: number,
  logScale: number,
  logDistance: number,
  x: number,
  y: number,
];

const toParameters = (c: PhotoCamera): Parameters => [
  c.azimuth,
  c.elevation,
  Math.log(c.focal / c.distance),
  Math.log(c.distance),
  c.shift[0],
  c.shift[1],
];
const fromParameters = (p: Parameters): PhotoCamera => {
  const distance = Math.exp(p[3]);
  return clampCamera({
    azimuth: p[0],
    elevation: p[1],
    distance,
    focal: Math.exp(p[2]) * distance,
    shift: [p[4], p[5]],
  });
};

export interface PhotoCameraFit {
  camera: PhotoCamera;
  /** Intersection over union of the mesh's outline and the photo's cut-out, 0–1. */
  iou: number;
}

export interface FitOptions {
  /** Cameras the search starts from; the best result of them all is kept. */
  starts?: PhotoCamera[];
  /** Size of the coarse search and of the last refinement (pixels). */
  coarse?: number;
  fine?: number;
  /** About this many vertices are drawn for the search (a dense mesh needs no more). */
  points?: number;
}

/**
 * Searches the camera that makes the mesh's outline cover the photo's cut-out. `alpha` is the
 * cut-out's alpha channel, `size` × `size` (the 512 picture the model was given).
 */
export function fitPhotoCamera(
  positions: Float32Array,
  alpha: Uint8Array | Uint8ClampedArray,
  size: number,
  {
    starts = [
      SOURCE_CAMERA,
      { ...SOURCE_CAMERA, azimuth: 25 },
      { ...SOURCE_CAMERA, azimuth: -25 },
      { ...SOURCE_CAMERA, azimuth: 45, elevation: 10 },
      { ...SOURCE_CAMERA, azimuth: -45, elevation: 10 },
    ],
    coarse = 96,
    fine = 256,
    points = 60_000,
  }: FitOptions = {},
): PhotoCameraFit {
  const vertices = positions.length / 3;
  if (vertices < 3) return { camera: SOURCE_CAMERA, iou: 0 };
  const stride = Math.max(1, Math.floor(vertices / points));
  const evaluator = (resolution: number, every: number) => {
    const target = shrinkMask(alpha, size, resolution);
    const scratch = new Uint8Array(resolution * resolution);
    return (parameters: Parameters) =>
      maskIou(
        outlineMask(
          projectVertices(positions, fromParameters(parameters), resolution, every),
          resolution,
          scratch,
        ),
        target,
      );
  };
  const steps: Parameters = [6, 5, 0.08, 0.15, 0.06, 0.06];
  const search = (
    start: Parameters,
    score: (p: Parameters) => number,
    scale: number,
    shrink: number,
    rounds: number,
  ) => {
    let best = start,
      bestScore = score(start),
      step = steps.map((s) => s * scale) as Parameters;
    for (let round = 0; round < rounds; round++) {
      let improved = false;
      for (let k = 0; k < 6; k++)
        for (const sign of [1, -1]) {
          const candidate = [...best] as Parameters;
          candidate[k] += sign * step[k];
          const value = score(candidate);
          if (value > bestScore + 1e-6) {
            best = candidate;
            bestScore = value;
            improved = true;
          }
        }
      if (!improved) step = step.map((s) => s * shrink) as Parameters;
    }
    return { parameters: best, iou: bestScore };
  };
  const coarseScore = evaluator(coarse, stride);
  let leader: { parameters: Parameters; iou: number } | undefined;
  for (const start of starts) {
    const found = search(toParameters(clampCamera(start)), coarseScore, 1, 0.55, 36);
    if (!leader || found.iou > leader.iou) leader = found;
  }
  // The finer picture settles the last pixels of the best start.
  const fineScore = evaluator(fine, Math.max(1, Math.floor(vertices / (points * 2))));
  const refined = search(leader!.parameters, fineScore, 0.12, 0.6, 24);
  return { camera: fromParameters(refined.parameters), iou: refined.iou };
}
