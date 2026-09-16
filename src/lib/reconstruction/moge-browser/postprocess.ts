/**
 * MoGe-2 forward -> infer postprocessing, OpenCV x-right/y-down/z-forward.
 * The pinned ONNX forward already remaps points, normalizes normals, applies
 * sigmoid(mask), exp(scale), and ImageNet input normalization. Do NONE twice.
 * Reference: Microsoft/MoGe 925b8ed, model/v2.py and utils/geometry_torch.py.
 */
export const MOGE_POSTPROCESS_REVISION = 'moge2-browser-postprocess-v1-fp32-lm';
export const MOGE_POSTPROCESS_VERSION = MOGE_POSTPROCESS_REVISION;
import type { MogeRawPrediction } from './protocol';
export type { MogeRawPrediction } from './protocol';
export type MogeDensePrediction = {
  width: number;
  height: number;
  points: Float32Array;
  normal: Float32Array;
  depth: Float32Array;
  mask: Uint8Array;
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  diagnostics: {
    revision: typeof MOGE_POSTPROCESS_REVISION;
    focal: number;
    shift: number;
    samples: number;
    iterations: number;
    residualMeanSquare: number;
    converged: boolean;
    metricScale: number;
    validPixels: number;
    forceProjection: boolean;
    applyMask: boolean;
    scale: 'model-estimated-metres';
    focalSampling: '64x64-torch-nearest-floor-not-semantic-pixel-centres';
  };
};
type Sample = { x: number; y: number; z: number; u: number; v: number };
const f32 = Math.fround;

function dimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width * height > 4_194_304
  )
    throw new Error('MoGe point map dimensions are invalid.');
}

/** Torch nearest (not nearest-exact): floor(outputIndex * inputSize / 64). */
export function sampleFocalPoints(raw: MogeRawPrediction): Sample[] {
  dimensions(raw.width, raw.height);
  const { width, height } = raw;
  const aspect = width / height;
  const sx = aspect / Math.sqrt(1 + aspect * aspect),
    sy = 1 / Math.sqrt(1 + aspect * aspect);
  const samples: Sample[] = [];
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const ix = Math.floor((x * width) / 64),
        iy = Math.floor((y * height) / 64),
        i = iy * width + ix;
      if (raw.mask[i] <= 0.5 || !Number.isFinite(raw.mask[i])) continue;
      const px = raw.points[3 * i],
        py = raw.points[3 * i + 1],
        pz = raw.points[3 * i + 2];
      if (![px, py, pz].every(Number.isFinite))
        throw new Error('Valid MoGe sample has nonfinite coordinates.');
      samples.push({
        x: px,
        y: py,
        z: pz,
        u: f32(sx * ((2 * (ix + 0.5)) / width - 1)),
        v: f32(sy * ((2 * (iy + 0.5)) / height - 1)),
      });
    }
  return samples;
}

/** Variable-projection least squares: eliminate focal, optimize scalar z shift. */
export function recoverMogeFocalShift(raw: MogeRawPrediction, knownFocal?: number) {
  const samples = sampleFocalPoints(raw);
  if (knownFocal !== undefined && (!Number.isFinite(knownFocal) || knownFocal <= 0))
    throw new Error('Invalid known focal.');
  if (samples.length < 2)
    return {
      focal: knownFocal ?? 1,
      shift: 0,
      samples: samples.length,
      iterations: 0,
      residualMeanSquare: 0,
      converged: true,
    };
  const evaluate = (shift: number) => {
    let a = 0,
      b = 0,
      da = 0,
      db = 0;
    for (const p of samples) {
      const z = p.z + shift;
      if (Math.abs(z) < 1e-12) return null;
      const inv = 1 / z,
        cross = p.x * p.u + p.y * p.v,
        norm = p.x * p.x + p.y * p.y;
      a += cross * inv;
      b += norm * inv * inv;
      da -= cross * inv * inv;
      db -= 2 * norm * inv * inv * inv;
    }
    if (b < 1e-24) return null;
    const focal = knownFocal ?? a / b;
    const df = knownFocal === undefined ? (da * b - a * db) / (b * b) : 0;
    let cost = 0,
      gradient = 0,
      curvature = 0;
    for (const p of samples) {
      const inv = 1 / (p.z + shift),
        factor = focal * inv,
        derivative = df * inv - focal * inv * inv;
      const rx = factor * p.x - p.u,
        ry = factor * p.y - p.v;
      const jx = derivative * p.x,
        jy = derivative * p.y;
      cost += rx * rx + ry * ry;
      gradient += rx * jx + ry * jy;
      curvature += jx * jx + jy * jy;
    }
    return { focal, cost, gradient, curvature };
  };
  let shift = 0,
    state = evaluate(0),
    damping = 1e-3,
    iterations = 0,
    converged = false;
  if (!state) throw new Error('MoGe focal recovery has degenerate input.');
  for (; iterations < 100; iterations++) {
    if (Math.abs(state.gradient) < 1e-12 || state.curvature < 1e-24) {
      converged = true;
      break;
    }
    const step = -state.gradient / (state.curvature * (1 + damping));
    if (Math.abs(step) < 1e-10 * (Math.abs(shift) + 1)) {
      converged = true;
      break;
    }
    const next = evaluate(shift + step);
    if (next && next.cost < state.cost) {
      const improvement = state.cost - next.cost;
      shift += step;
      state = next;
      damping = Math.max(1e-12, damping / 3);
      if (improvement < 1e-9 * Math.max(state.cost, 1e-20)) {
        converged = true;
        break;
      }
    } else damping = Math.min(1e16, damping * 10);
  }
  // Python casts the optimized shift to float32 before its final focal estimate.
  shift = f32(shift);
  state = evaluate(shift);
  if (!state || !Number.isFinite(state.focal) || state.focal <= 0)
    throw new Error('MoGe focal recovery did not produce a positive finite focal.');
  return {
    focal: f32(state.focal),
    shift,
    samples: samples.length,
    iterations,
    residualMeanSquare: state.cost / (2 * samples.length),
    converged,
  };
}

export function postprocessMoge(
  raw: MogeRawPrediction,
  options: { forceProjection?: boolean; applyMask?: boolean; fovXDegrees?: number } = {},
): MogeDensePrediction {
  dimensions(raw.width, raw.height);
  const n = raw.width * raw.height;
  if (
    raw.points.length !== n * 3 ||
    raw.normal.length !== n * 3 ||
    raw.mask.length !== n ||
    !Number.isFinite(raw.metricScale) ||
    raw.metricScale <= 0
  )
    throw new Error('MoGe forward tensor shape/scale mismatch.');
  for (const probability of raw.mask)
    if (!Number.isFinite(probability) || probability < 0 || probability > 1)
      throw new Error('MoGe mask must be an already activated probability.');
  const aspect = raw.width / raw.height,
    diagonal = Math.sqrt(1 + aspect * aspect);
  const fov = options.fovXDegrees;
  if (fov !== undefined && (!Number.isFinite(fov) || fov <= 0 || fov >= 180))
    throw new Error('Invalid horizontal field of view.');
  const knownFocal = fov === undefined ? undefined : f32(aspect / diagonal / Math.tan((fov * Math.PI) / 360));
  const fit = recoverMogeFocalShift(raw, knownFocal);
  const intrinsics = {
    fx: f32(f32(f32(fit.focal / 2) * diagonal) / aspect),
    fy: f32(f32(fit.focal / 2) * diagonal),
    cx: 0.5,
    cy: 0.5,
  };
  const points = new Float32Array(n * 3),
    normal = new Float32Array(raw.normal),
    depth = new Float32Array(n),
    mask = new Uint8Array(n);
  const forceProjection = options.forceProjection ?? true,
    applyMask = options.applyMask ?? true;
  let validPixels = 0;
  for (let i = 0; i < n; i++) {
    const z = f32(raw.points[i * 3 + 2] + fit.shift);
    const valid = raw.mask[i] > 0.5 && Number.isFinite(z) && z > 0;
    if (valid) {
      if (
        ![raw.points[i * 3], raw.points[i * 3 + 1], ...normal.subarray(i * 3, i * 3 + 3)].every(
          Number.isFinite,
        )
      )
        throw new Error('Valid MoGe point/normal is nonfinite.');
      mask[i] = 1;
      validPixels++;
    }
    if (!valid && applyMask) {
      depth[i] = Infinity;
      points.fill(Infinity, i * 3, i * 3 + 3);
      normal.fill(0, i * 3, i * 3 + 3);
      continue;
    }
    depth[i] = f32(z * raw.metricScale);
    const x = i % raw.width,
      y = Math.floor(i / raw.width);
    points[i * 3] = forceProjection
      ? f32(f32(f32((x + 0.5) / raw.width - 0.5) / intrinsics.fx) * depth[i])
      : f32(raw.points[i * 3] * raw.metricScale);
    points[i * 3 + 1] = forceProjection
      ? f32(f32(f32((y + 0.5) / raw.height - 0.5) / intrinsics.fy) * depth[i])
      : f32(raw.points[i * 3 + 1] * raw.metricScale);
    points[i * 3 + 2] = depth[i];
  }
  return {
    width: raw.width,
    height: raw.height,
    points,
    normal,
    depth,
    mask,
    intrinsics,
    diagnostics: {
      revision: MOGE_POSTPROCESS_REVISION,
      ...fit,
      metricScale: raw.metricScale,
      validPixels,
      forceProjection,
      applyMask,
      scale: 'model-estimated-metres',
      focalSampling: '64x64-torch-nearest-floor-not-semantic-pixel-centres',
    },
  };
}
