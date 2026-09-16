/** Browser port of scripts/reconstruction_geometry/{planes,consensus}.py.
 * Observed support only, never measured/full room boundaries. No image-specific rules.
 */
import type { DepthPlaneObservation } from '../depth-room-geometry';
import type { MogeDensePrediction } from './postprocess';
import { PlaneRandom as Random, MOGE_PLANE_RNG, MOGE_PLANE_SEED } from './plane-random';
export { MOGE_PLANE_RNG } from './plane-random';

export const MOGE_PLANE_REVISION = 'moge2-browser-semantic-planes-v2-pcg64';
export const MOGE_PLANES_VERSION = MOGE_PLANE_REVISION;
export const MOGE_PLANE_CONFIG = {
  seed: MOGE_PLANE_SEED,
  erosionGridPixels: 2,
  objectMarginGridPixels: 2,
  ransacTrials: 384,
  normalSeedTrials: 96,
  maximumScoringPoints: 6000,
  maximumRefinedHypotheses: 12,
  distanceThresholdMedianDepthRatio: 0.008,
  maximumNormalAngleDegrees: 15,
  wallVerticalToleranceDegrees: 15,
  minimumInlierPixels: 300,
  minimumImageAreaRatio: 0.0025,
  minimumRemainingInlierRatio: 0.12,
  minimumPcaSecondToFirstSpread: 0.01,
  maximumFloorPlanes: 3,
  maximumWallPlanes: 6,
} as const;
type Vec3 = [number, number, number];
type Bounds = { left: number; top: number; right: number; bottom: number };
export type MogeSemanticInput = {
  width: number;
  height: number;
  /** Aligned full-frame binary masks; 0/1 or 0/255. */
  floor: Uint8Array;
  wall: Uint8Array;
  regions: readonly { id: string; kind: string; bounds: Bounds; source?: string; requiresReview?: boolean }[];
};
export type MogePlaneResult = {
  floor: DepthPlaneObservation | null;
  walls: DepthPlaneObservation[];
  evidence: Record<string, unknown>;
  labels: { floor: Int16Array; wall: Int16Array; excluded: Uint8Array; width: number; height: number };
};
const C = MOGE_PLANE_CONFIG,
  cosNormal = Math.cos((C.maximumNormalAngleDegrees * Math.PI) / 180),
  sinVertical = Math.sin((C.wallVerticalToleranceDegrees * Math.PI) / 180);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a: Vec3, b: Vec3, unsigned = true) =>
  (Math.acos(Math.max(-1, Math.min(1, unsigned ? Math.abs(dot(a, b)) : dot(a, b)))) * 180) / Math.PI;
const point = (p: Float64Array, i: number): Vec3 => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
const dotAt = (p: Float64Array, i: number, n: Vec3) =>
  p[3 * i] * n[0] + p[3 * i + 1] * n[1] + p[3 * i + 2] * n[2];
function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const x = (values.length - 1) * q,
    a = Math.floor(x),
    t = x - a;
  return values[a] * (1 - t) + values[Math.min(a + 1, values.length - 1)] * t;
}

/** Symmetric 3x3 Jacobi eigensolver; columns in vectors, eigenvalues ascending. */
export function symmetricEigen3(matrix: readonly number[]) {
  if (matrix.length !== 9 || matrix.some((v) => !Number.isFinite(v)))
    throw new Error('Invalid covariance matrix.');
  const a = [...matrix],
    vectors = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iteration = 0; iteration < 32; iteration++) {
    let p = 0,
      q = 1;
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ])
      if (Math.abs(a[3 * i + j]) > Math.abs(a[3 * p + q])) {
        p = i;
        q = j;
      }
    const off = a[p * 3 + q],
      scale = Math.max(Math.abs(a[0]), Math.abs(a[4]), Math.abs(a[8]), 1e-30);
    if (Math.abs(off) <= scale * 1e-14) break;
    const tau = (a[q * 3 + q] - a[p * 3 + p]) / (2 * off);
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau)),
      c = 1 / Math.sqrt(1 + t * t),
      s = t * c;
    const app = a[p * 3 + p],
      aqq = a[q * 3 + q];
    for (let k = 0; k < 3; k++)
      if (k !== p && k !== q) {
        const akp = a[k * 3 + p],
          akq = a[k * 3 + q];
        a[k * 3 + p] = a[p * 3 + k] = c * akp - s * akq;
        a[k * 3 + q] = a[q * 3 + k] = s * akp + c * akq;
      }
    a[p * 3 + p] = app - t * off;
    a[q * 3 + q] = aqq + t * off;
    a[p * 3 + q] = a[q * 3 + p] = 0;
    for (let k = 0; k < 3; k++) {
      const vp = vectors[k * 3 + p],
        vq = vectors[k * 3 + q];
      vectors[k * 3 + p] = c * vp - s * vq;
      vectors[k * 3 + q] = s * vp + c * vq;
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i * 3 + i] - a[j * 3 + j]);
  return {
    values: order.map((i) => a[3 * i + i]) as Vec3,
    vectors: order.map((i) => [vectors[i], vectors[3 + i], vectors[6 + i]] as Vec3),
  };
}
function pca(points: Float64Array, ids: readonly number[]) {
  if (ids.length < 3) throw new Error('PCA requires three points.');
  const center: Vec3 = [0, 0, 0];
  for (const i of ids) for (let j = 0; j < 3; j++) center[j] += points[3 * i + j];
  for (let j = 0; j < 3; j++) center[j] /= ids.length;
  const covariance = new Array<number>(9).fill(0);
  for (const i of ids) {
    const d = point(points, i).map((v, j) => v - center[j]);
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) covariance[j * 3 + k] += (d[j] * d[k]) / ids.length;
  }
  const eigen = symmetricEigen3(covariance),
    normal: Vec3 = [...eigen.vectors[0]];
  if (dot(normal, center) > 0) for (let j = 0; j < 3; j++) normal[j] *= -1;
  return {
    normal,
    offset: -dot(normal, center),
    center,
    eigenvalues: eigen.values,
    eigenvectors: eigen.vectors,
  };
}
type Fit = ReturnType<typeof pca> & {
  ids: number[];
  converged: boolean;
  diagnostics: Record<string, unknown>;
};
function ransac(
  points: Float64Array,
  normals: Float64Array,
  remaining: readonly number[],
  threshold: number,
  rng: Random,
  gravity?: Vec3,
  parallel?: Vec3,
): { fit: Fit | null; diagnostics: Record<string, unknown> } {
  const diagnostics: Record<string, unknown> = { candidatePixels: remaining.length };
  const reject = (termination: string) => ({ fit: null, diagnostics: { ...diagnostics, termination } });
  if (remaining.length < C.minimumInlierPixels) return reject('insufficient-remaining-candidate-pixels');
  const sample = rng.sample(remaining, Math.min(remaining.length, C.maximumScoringPoints));
  const hypotheses: { normal: Vec3; offset: number; score: number }[] = [];
  for (let trial = 0; trial < C.ransacTrials; trial++) {
    const a = point(points, sample[rng.integer(sample.length)]),
      b = point(points, sample[rng.integer(sample.length)]),
      c = point(points, sample[rng.integer(sample.length)]);
    const u = b.map((v, j) => v - a[j]),
      v = c.map((n, j) => n - a[j]);
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      length = Math.hypot(...n);
    if (length <= threshold * threshold) continue;
    for (let j = 0; j < 3; j++) n[j] /= length;
    hypotheses.push({ normal: n, offset: -dot(n, a), score: 0 });
  }
  for (const i of rng.sample(sample, Math.min(sample.length, C.normalSeedTrials))) {
    const normal = point(normals, i);
    hypotheses.push({ normal, offset: -dotAt(points, i, normal), score: 0 });
  }
  const plane = pca(points, sample);
  hypotheses.push({ normal: plane.normal, offset: plane.offset, score: 0 });
  diagnostics.hypothesesBeforeOrientation = hypotheses.length;
  const permitted = hypotheses.filter(
    (p) =>
      (!gravity || Math.abs(dot(p.normal, gravity)) <= sinVertical) &&
      (!parallel || Math.abs(dot(p.normal, parallel)) >= cosNormal),
  );
  diagnostics.hypothesesAfterOrientation = permitted.length;
  if (!permitted.length) return reject('no-orientation-compatible-hypothesis');
  for (const p of permitted)
    for (const i of sample)
      if (
        Math.abs(dotAt(points, i, p.normal) + p.offset) <= threshold &&
        Math.abs(dotAt(normals, i, p.normal)) >= cosNormal
      )
        p.score++;
  permitted.sort((a, b) => b.score - a.score);
  diagnostics.bestJointDistanceNormalConsensusOnSample = permitted[0].score;
  const ranked: typeof hypotheses = [];
  for (const h of permitted) {
    if (h.score < 3) break;
    if (
      ranked.some(
        (p) =>
          angle(h.normal, p.normal) < 5 &&
          Math.abs(h.offset - (dot(h.normal, p.normal) >= 0 ? p.offset : -p.offset)) < 2 * threshold,
      )
    )
      continue;
    ranked.push(h);
    if (ranked.length === C.maximumRefinedHypotheses) break;
  }
  let best: Fit | null = null;
  const evaluations: Record<string, unknown>[] = [];
  const inliers = (normal: Vec3, offset: number) =>
    remaining.filter(
      (i) =>
        Math.abs(dotAt(points, i, normal) + offset) <= threshold &&
        Math.abs(dotAt(normals, i, normal)) >= cosNormal,
    );
  for (const h of ranked) {
    let normal = h.normal,
      offset = h.offset,
      ids = inliers(normal, offset),
      converged = false,
      reason: string | null = null;
    const initial = ids.length;
    for (let iteration = 0; iteration < 12; iteration++) {
      if (ids.length < 3) {
        reason = 'pca-refinement-lost-normal-distance-consensus';
        break;
      }
      const refinedPlane = pca(points, ids);
      normal = refinedPlane.normal;
      offset = refinedPlane.offset;
      const next = inliers(normal, offset);
      if (next.length === ids.length && next.every((v, i) => v === ids[i])) {
        converged = true;
        break;
      }
      ids = next;
    }
    if (ids.length < 3) reason = 'pca-refinement-lost-normal-distance-consensus';
    if (!reason && gravity && Math.abs(dot(normal, gravity)) > sinVertical)
      reason = 'pca-refinement-lost-verticality';
    if (!reason && parallel && Math.abs(dot(normal, parallel)) < cosNormal)
      reason = 'pca-refinement-lost-floor-parallelism';
    const support = ids.length >= 3 ? pca(points, ids) : null;
    if (
      !reason &&
      support &&
      support.eigenvalues[1] / Math.max(support.eigenvalues[2], 1e-12) < C.minimumPcaSecondToFirstSpread
    )
      reason = 'near-collinear-refined-support';
    evaluations.push({
      sampleScore: h.score,
      initialInliers: initial,
      finalInliers: ids.length,
      refinementConverged: converged,
      rejection: reason,
    });
    if (!reason && support && (!best || ids.length > best.ids.length))
      best = { ...support, normal, offset, ids, converged, diagnostics };
  }
  diagnostics.rankedHypothesisEvaluations = evaluations;
  diagnostics.termination = best ? 'consensus-found' : 'all-ranked-hypotheses-failed-refined-consensus';
  return { fit: best, diagnostics };
}

type PlaneReport = {
  observation: DepthPlaneObservation;
  fit: Fit;
  kind: 'floor' | 'wall';
  reasons: string[];
  summary: Record<string, unknown>;
  groupedFrom?: string[];
};
function summarize(
  fit: Fit,
  points: Float64Array,
  normals: Float64Array,
  width: number,
  height: number,
  denominator: number,
  remainingCount: number,
  kind: 'floor' | 'wall',
  index: number,
  threshold: number,
  gravity?: Vec3,
): PlaneReport {
  const ids = fit.ids,
    xs = ids.map((i) => i % width),
    ys = ids.map((i) => Math.floor(i / width));
  let left = width,
    top = height,
    right = 0,
    bottom = 0;
  const occupied = new Uint8Array(4096),
    rows8 = new Set<number>(),
    columns8 = new Set<number>();
  for (let i = 0; i < ids.length; i++) {
    const x = xs[i],
      y = ys[i];
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
    occupied[Math.min(63, Math.floor((y * 64) / height)) * 64 + Math.min(63, Math.floor((x * 64) / width))] =
      1;
    rows8.add(Math.floor(((y + 0.5) / height) * 8));
    columns8.add(Math.floor(((x + 0.5) / width) * 8));
  }
  const median = [0, 1, 2].map((j) =>
    quantile(
      ids.map((i) => points[3 * i + j]),
      0.5,
    ),
  ) as Vec3;
  const distance = dot(median, fit.normal) + fit.offset;
  const medianProjected = median.map((v, j) => v - distance * fit.normal[j]) as Vec3;
  const residuals = ids.map((i) => Math.abs(dotAt(points, i, fit.normal) + fit.offset));
  const angles = ids.map(
    (i) => (Math.acos(Math.min(1, Math.abs(dotAt(normals, i, fit.normal)))) * 180) / Math.PI,
  );
  const bounds = { left: left / width, top: top / height, right: right / width, bottom: bottom / height };
  const reasons: string[] = [],
    area = ids.length / (width * height),
    spread = fit.eigenvalues[1] / Math.max(fit.eigenvalues[2], 1e-12);
  if (ids.length < C.minimumInlierPixels) reasons.push('insufficient-inlier-pixels');
  if (area < C.minimumImageAreaRatio) reasons.push('insufficient-image-area-support');
  if (ids.length / remainingCount < C.minimumRemainingInlierRatio) reasons.push('low-inlier-ratio');
  if (spread < C.minimumPcaSecondToFirstSpread) reasons.push('near-collinear-support');
  if (rows8.size < 2 || columns8.size < 2) reasons.push('support-concentrated-in-single-grid-row-or-column');
  if (kind === 'wall' && gravity && Math.abs(dot(fit.normal, gravity)) > sinVertical)
    reasons.push('not-vertical-relative-to-observed-floor');
  const observation: DepthPlaneObservation = {
    id: kind + '-' + index,
    normalCamera: [...fit.normal],
    offset: fit.offset,
    medianPointCamera: medianProjected,
    inlierCount: ids.length,
    inlierFraction: ids.length / denominator,
    imageAreaFraction: area,
    rmsResidual: Math.sqrt(Math.max(0, fit.eigenvalues[0])),
    imageSupport: { bounds, width: 64, height: 64, occupied: Array.from(occupied).join('') },
  };
  return {
    observation,
    fit,
    kind,
    reasons,
    summary: {
      id: observation.id,
      kind,
      status: reasons.length ? 'insufficient-support' : 'supported-observed-plane',
      reasons,
      support: {
        pixels: ids.length,
        remainingCandidateRatio: ids.length / remainingCount,
        originalCandidateRatio: ids.length / denominator,
        imageAreaRatio: area,
        bboxNormalized: bounds,
        occupied8x8Rows: rows8.size,
        occupied8x8Columns: columns8.size,
        medianPointCamera: median,
        medianPointProjectedOntoPlaneCamera: medianProjected,
        boundsMeaning: 'Inlier support only, not complete room extent',
      },
      residual: {
        thresholdModelUnits: threshold,
        inlierMedian: quantile([...residuals], 0.5),
        inlierP95: quantile([...residuals], 0.95),
        inlierMax: quantile([...residuals], 1),
        normalAngleMedianDegrees: quantile([...angles], 0.5),
        normalAngleP95Degrees: quantile([...angles], 0.95),
        pcaEigenvaluesAscending: fit.eigenvalues,
        pcaSecondToFirstSpreadRatio: spread,
      },
      fitDiagnostics: fit.diagnostics,
    },
  };
}

function erode(mask: Uint8Array, width: number, height: number) {
  // Two 3x3 binary erosions equal one 5x5 erosion, including zero image borders.
  const out = new Uint8Array(mask.length),
    r = C.erosionGridPixels;
  for (let y = r; y < height - r; y++)
    for (let x = r; x < width - r; x++) {
      let keep = true;
      for (let dy = -r; dy <= r && keep; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (!mask[(y + dy) * width + x + dx]) {
            keep = false;
            break;
          }
      if (keep) out[y * width + x] = 1;
    }
  return out;
}
function extract(
  points: Float64Array,
  normals: Float64Array,
  ids: number[],
  width: number,
  height: number,
  threshold: number,
  rng: Random,
  kind: 'floor' | 'wall',
  gravity?: Vec3,
) {
  const accepted: PlaneReport[] = [],
    rejected: PlaneReport[] = [],
    attempts: Record<string, unknown>[] = [],
    labels = new Int16Array(width * height);
  let remaining = ids,
    parallel: Vec3 | undefined;
  for (let index = 1; index <= (kind === 'floor' ? C.maximumFloorPlanes : C.maximumWallPlanes); index++) {
    const { fit, diagnostics } = ransac(points, normals, remaining, threshold, rng, gravity, parallel);
    attempts.push({ iteration: index, ...diagnostics });
    if (!fit) break;
    const report = summarize(
      fit,
      points,
      normals,
      width,
      height,
      ids.length,
      remaining.length,
      kind,
      index,
      threshold,
      gravity,
    );
    if (!report.reasons.length) {
      accepted.push(report);
      for (const i of fit.ids) labels[i] = index + (kind === 'wall' ? 10 : 0);
      if (kind === 'floor' && !parallel) parallel = fit.normal;
    } else rejected.push(report);
    const chosen = new Set(fit.ids);
    remaining = remaining.filter((i) => !chosen.has(i));
  }
  return {
    accepted,
    rejected,
    labels,
    counts: { candidatePixels: ids.length, unassignedCandidatePixels: remaining.length, attempts },
  };
}
function mergeWalls(
  walls: PlaneReport[],
  labels: Int16Array,
  points: Float64Array,
  normals: Float64Array,
  width: number,
  height: number,
  threshold: number,
  denominator: number,
  gravity?: Vec3,
) {
  const groups: { members: PlaneReport[]; report: PlaneReport }[] = [],
    checks: Record<string, unknown>[] = [];
  const adjacent = (a: PlaneReport, b: PlaneReport) => {
    const mask = new Set(b.fit.ids);
    return a.fit.ids.some((i) => {
      const x = i % width,
        y = Math.floor(i / width);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (
            x + dx >= 0 &&
            x + dx < width &&
            y + dy >= 0 &&
            y + dy < height &&
            mask.has(i + dy * width + dx)
          )
            return true;
      return false;
    });
  };
  for (const wall of walls) {
    let accepted = false;
    for (const group of groups) {
      const members = [...group.members, wall],
        check: Record<string, unknown> = {
          members: members.map((m) => m.observation.id),
          status: 'rejected',
        };
      checks.push(check);
      let reason: string | undefined;
      for (let i = 0; i < members.length; i++)
        for (let j = i + 1; j < members.length; j++) {
          if (angle(members[i].fit.normal, members[j].fit.normal, false) > 5)
            reason ??= 'different-normal-directions';
          if (Math.abs(members[i].fit.offset - members[j].fit.offset) > 2 * threshold)
            reason ??= 'different-plane-offsets';
        }
      const visited = new Set([0]);
      let changed = true;
      while (changed && !reason) {
        changed = false;
        for (let j = 0; j < members.length; j++)
          if (!visited.has(j) && [...visited].some((i) => adjacent(members[i], members[j]))) {
            visited.add(j);
            changed = true;
          }
      }
      if (visited.size !== members.length) reason ??= 'disconnected-image-support';
      if (reason) {
        check.reason = reason;
        continue;
      }
      const ids = members.flatMap((m) => m.fit.ids).sort((a, b) => a - b);
      if (
        new Set(ids).size !== ids.length ||
        members.some((m) => m.fit.ids.length !== m.observation.inlierCount)
      ) {
        check.reason = 'missing-or-duplicate-independent-support';
        continue;
      }
      const joint = pca(points, ids);
      let maximumResidual = 0,
        compatible = true;
      for (const i of ids) {
        maximumResidual = Math.max(maximumResidual, Math.abs(dotAt(points, i, joint.normal) + joint.offset));
        if (Math.abs(dotAt(normals, i, joint.normal)) < cosNormal) compatible = false;
      }
      if (maximumResidual > threshold + 1e-10 || !compatible) {
        check.reason = 'joint-refit-loses-independent-support';
        check.maximumResidual = maximumResidual;
        continue;
      }
      if (gravity && Math.abs(dot(joint.normal, gravity)) > sinVertical) {
        check.reason = 'joint-plane-not-vertical';
        continue;
      }
      const fit: Fit = {
        ...joint,
        ids,
        converged: true,
        diagnostics: {
          termination: 'disjoint-observed-patches-joint-consensus',
          members: check.members,
          independentPixelCounts: members.map((m) => m.fit.ids.length),
          discardedPixels: 0,
        },
      };
      const index = Number(members[0].observation.id.split('-')[1]);
      const report = summarize(
        fit,
        points,
        normals,
        width,
        height,
        denominator,
        ids.length,
        'wall',
        index,
        threshold,
        gravity,
      );
      if (report.reasons.length) {
        check.reason = 'joint-summary-has-insufficient-support';
        continue;
      }
      report.groupedFrom = members.map((m) => m.observation.id);
      report.summary.groupedFrom = report.groupedFrom;
      group.members = members;
      group.report = report;
      accepted = true;
      Object.assign(check, {
        status: 'accepted',
        reason: 'direction-offset-adjacency-and-all-support-agree',
        maximumResidual,
      });
      break;
    }
    if (!accepted) groups.push({ members: [wall], report: wall });
  }
  const mergedLabels = new Int16Array(labels);
  for (const group of groups)
    for (const i of group.report.fit.ids)
      mergedLabels[i] = 10 + Number(group.report.observation.id.split('-')[1]);
  return { reports: groups.map((g) => g.report), labels: mergedLabels, checks };
}

export function extractMogePlanes(dense: MogeDensePrediction, semantic: MogeSemanticInput): MogePlaneResult {
  const { width, height } = semantic,
    n = width * height;
  if (
    ![dense.width, dense.height].every((v) => Number.isInteger(v) && v >= 2) ||
    dense.width * dense.height > 4_194_304
  )
    throw new Error('Invalid dense map dimensions.');
  if (
    ![width, height].every((v) => Number.isInteger(v) && v >= 8 && v <= 2048) ||
    n > 1_048_576 ||
    semantic.floor.length !== n ||
    semantic.wall.length !== n ||
    semantic.regions.length > 128
  )
    throw new Error('Invalid semantic mask dimensions/regions.');
  if (Math.abs(width / height - dense.width / dense.height) > 2 / Math.min(width, height))
    throw new Error('Semantic masks must align to the full oriented photo.');
  if (
    dense.points.length !== dense.width * dense.height * 3 ||
    dense.normal.length !== dense.points.length ||
    dense.mask.length !== dense.width * dense.height
  )
    throw new Error('Dense map dimensions mismatch.');
  for (const mask of [semantic.floor, semantic.wall])
    for (const v of mask)
      if (v !== 0 && v !== 1 && v !== 255) throw new Error('Semantic masks must be binary.');
  const points = new Float64Array(n * 3),
    normals = new Float64Array(n * 3),
    valid = new Uint8Array(n),
    excluded = new Uint8Array(n),
    depths: number[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        j =
          Math.floor(((y + 0.5) / height) * dense.height) * dense.width +
          Math.floor(((x + 0.5) / width) * dense.width);
      const p = [dense.points[3 * j], dense.points[3 * j + 1], dense.points[3 * j + 2]],
        normal = [dense.normal[3 * j], dense.normal[3 * j + 1], dense.normal[3 * j + 2]],
        length = Math.hypot(...normal);
      points.set(p, i * 3);
      if (
        !dense.mask[j] ||
        !p.every(Number.isFinite) ||
        !normal.every(Number.isFinite) ||
        p[2] <= 0 ||
        length <= 0.9 ||
        length >= 1.1
      )
        continue;
      valid[i] = 1;
      depths.push(p[2]);
      normals.set(
        normal.map((v) => v / length),
        i * 3,
      );
    }
  const exclusionRecords = semantic.regions.map((region) => {
    const b = region.bounds,
      values = [b.left, b.top, b.right, b.bottom];
    if (
      !values.every(Number.isFinite) ||
      b.left < 0 ||
      b.top < 0 ||
      b.right > 1 ||
      b.bottom > 1 ||
      b.left >= b.right ||
      b.top >= b.bottom
    )
      throw new Error('Invalid exclusion region bounds.');
    const left = Math.max(0, Math.floor(b.left * width) - 2),
      top = Math.max(0, Math.floor(b.top * height) - 2),
      right = Math.min(width, Math.ceil(b.right * width) + 2),
      bottom = Math.min(height, Math.ceil(b.bottom * height) + 2);
    for (let y = top; y < bottom; y++) excluded.fill(1, y * width + left, y * width + right);
    return { ...region, bounds: { ...b }, exclusion: 'whole-bounding-rectangle-plus-2-grid-pixels' };
  });
  const floorEroded = erode(semantic.floor, width, height),
    wallEroded = erode(semantic.wall, width, height),
    floorIds: number[] = [],
    wallIds: number[] = [];
  let rawFloor = 0,
    rawWall = 0,
    overlap = 0,
    excludedFloor = 0,
    excludedWall = 0;
  for (let i = 0; i < n; i++) {
    if (semantic.floor[i]) rawFloor++;
    if (semantic.wall[i]) rawWall++;
    if (semantic.floor[i] && semantic.wall[i]) overlap++;
    if (floorEroded[i] && excluded[i]) excludedFloor++;
    if (wallEroded[i] && excluded[i]) excludedWall++;
    if (floorEroded[i] && valid[i] && !excluded[i] && !semantic.wall[i]) floorIds.push(i);
    if (wallEroded[i] && valid[i] && !excluded[i] && !semantic.floor[i]) wallIds.push(i);
  }
  const threshold = depths.length ? quantile([...depths], 0.5) * C.distanceThresholdMedianDepthRatio : 0.01,
    rng = new Random();
  const floors = extract(points, normals, floorIds, width, height, threshold, rng, 'floor'),
    gravity = floors.accepted[0]?.fit.normal;
  const walls = extract(points, normals, wallIds, width, height, threshold, rng, 'wall', gravity);
  const merged = mergeWalls(
    walls.accepted,
    walls.labels,
    points,
    normals,
    width,
    height,
    threshold,
    wallIds.length,
    gravity,
  );
  return {
    floor: floors.accepted[0]?.observation ?? null,
    walls: merged.reports.map((p) => p.observation),
    labels: { floor: floors.labels, wall: merged.labels, excluded, width, height },
    evidence: {
      revision: MOGE_PLANE_REVISION,
      browserRng: MOGE_PLANE_RNG,
      seed: C.seed,
      config: C,
      reference: 'scripts/reconstruction_geometry/planes.py+consensus.py',
      rngReference:
        'NumPy 2.2.6 PCG64, fixed seed 20260913; bounded integers and choice sequence reproduced. Floating point plane fitting is tolerance-tested.',
      scope: 'observed-model-planes-not-physical-room-boundaries',
      coordinateSystem: 'opencv-camera',
      scale: 'model-estimated-metres',
      maskSize: { width, height },
      geometryAnalysisSize: { width: dense.width, height: dense.height },
      coordinateMapping: 'full-frame normalized nearest pixel centres; no crop',
      candidateFiltering: {
        validGeometryPixels: depths.length,
        rawFloorPixels: rawFloor,
        rawWallPixels: rawWall,
        excludedFloorPixels: excludedFloor,
        excludedWallPixels: excludedWall,
        cleanFloorPixels: floorIds.length,
        cleanWallPixels: wallIds.length,
        overlappingSemanticPixels: overlap,
      },
      excludedRegions: exclusionRecords,
      thresholdModelUnits: threshold,
      planes: [...floors.accepted, ...merged.reports].map((p) => p.summary),
      unmergedWalls: walls.accepted.map((p) => p.summary),
      rejectedPlanes: [...floors.rejected, ...walls.rejected].map((p) => p.summary),
      wallPatchGrouping: {
        enabled: true,
        maximumNormalDegrees: 5,
        maximumOffsetThresholdMultiple: 2,
        adjacencyGridPixels: 2,
        allOriginalPointsRequired: true,
        discardedPixels: 0,
        checks: merged.checks,
      },
      unassigned: { floor: floors.counts, wall: walls.counts },
      warnings: [
        '모델이 추정한 거리이며 실측값이 아닙니다.',
        '설비 사각 영역을 제외하므로 뒤쪽 실제 벽의 지지도 일부 제거될 수 있습니다.',
        '관측 평면 조각을 전체 방 경계로 승격하지 않습니다.',
        '반사·유리·미검출 물체로 깊이와 표면을 오인할 수 있습니다.',
      ],
    },
  };
}
