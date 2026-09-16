import type { ReconstructionCandidate } from './types';

type ShapeEvidence = NonNullable<ReconstructionCandidate['evidence']['basinShape']>;
export type BasinShapeDiagnostic = {
  version: 1;
  method: 'semantic-contour-v1' | 'semantic-rgb-contour-v2';
  semanticRejection?: string[];
  rim?: PedestalRimDiagnostic;
  rejectedBy: string[];
  span?: number;
  rows?: number;
  cut?: number;
  stemWidth?: number;
  widestRow?: number;
  retainedColumns?: number;
  coverage?: number;
  line?: { values: number[]; error: number };
  curve?: { values: number[]; error: number };
  curvature?: number;
  vertex?: number;
  sideDepth?: number[];
  checks?: { round: Record<string, boolean>; rectangular: Record<string, boolean> };
  profiles?: {
    x0: number;
    y0: number;
    rowWidths: number[];
    lower: number[];
    upper: number[];
    points: { x: number; y: number }[];
  };
};
export type BasinComponentCapture = {
  id: string;
  bounds: ReconstructionCandidate['bounds'];
  hasPedestal: boolean;
  /** Row-major runs [start,length,...], in this analysis pass's coordinates. */
  pixelRuns: number[];
  inspection: { evidence?: ShapeEvidence; diagnostic: BasinShapeDiagnostic };
};
export function encodeBasinPixels(pixels: number[]): number[] {
  const sorted = [...pixels].sort((a, b) => a - b),
    runs: number[] = [];
  for (const p of sorted) {
    const n = runs.length;
    if (n && runs[n - 2] + runs[n - 1] === p) runs[n - 1]++;
    else runs.push(p, 1);
  }
  return runs;
}

/** Conservative silhouette evidence, not a product measurement or a semantic model's shape label. */
function inspectSemanticBasinShape(
  pixels: number[],
  width: number,
  height: number,
  bounds: ReconstructionCandidate['bounds'],
  hasPedestal: boolean,
  captureProfiles = false,
): { evidence?: ShapeEvidence; diagnostic: BasinShapeDiagnostic } {
  const diagnostic: BasinShapeDiagnostic = { version: 1, method: 'semantic-contour-v1', rejectedBy: [] };
  const finish = (evidence?: ShapeEvidence, reason?: string) => {
    if (reason) diagnostic.rejectedBy.push(reason);
    return { evidence, diagnostic };
  };
  if (bounds.left <= 0 || bounds.top <= 0 || bounds.right >= 1 || bounds.bottom >= 1)
    return finish(undefined, 'frame-clipped');
  const x0 = Math.floor(bounds.left * width),
    x1 = Math.ceil(bounds.right * width);
  const y0 = Math.floor(bounds.top * height),
    y1 = Math.ceil(bounds.bottom * height);
  const span = x1 - x0;
  diagnostic.span = span;
  diagnostic.rows = y1 - y0;
  if (span < 48 || y1 - y0 < 14) return finish(undefined, 'insufficient-resolution');
  const rows = Array.from({ length: y1 - y0 }, () => ({ left: width, right: -1 }));
  for (const p of pixels) {
    const x = p % width,
      row = rows[Math.floor(p / width) - y0];
    if (row) {
      row.left = Math.min(row.left, x);
      row.right = Math.max(row.right, x);
    }
  }
  let cut = y1;
  if (hasPedestal) {
    const widest = rows.reduce(
      (best, r, i) => (r.right - r.left > rows[best].right - rows[best].left ? i : best),
      0,
    );
    const stemWidths = rows
      .slice(Math.floor(rows.length * 0.75), Math.ceil(rows.length * 0.95))
      .map((r) => r.right - r.left + 1)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const stemWidth = stemWidths[Math.floor(stemWidths.length / 2)] ?? 0;
    diagnostic.stemWidth = stemWidth;
    diagnostic.widestRow = widest + y0;
    for (let y = widest + 1; y < rows.length - 3; y++) {
      if (stemWidth > 0 && rows.slice(y, y + 3).every((r) => r.right - r.left + 1 <= stemWidth * 1.15)) {
        cut = y + y0;
        break;
      }
    }
  }
  diagnostic.cut = cut;
  const lower = new Int32Array(span).fill(-1),
    upper = new Int32Array(span).fill(height);
  for (const p of pixels) {
    const x = (p % width) - x0,
      y = Math.floor(p / width);
    if (x < 0 || x >= span || y >= cut) continue;
    lower[x] = Math.max(lower[x], y);
    upper[x] = Math.min(upper[x], y);
  }
  const points: { x: number; y: number }[] = [];
  for (let x = Math.ceil(span * 0.08); x < span * 0.92; x++) {
    // A clipped pedestal junction is not an observed straight edge of the bowl.
    if (lower[x] < 0 || (hasPedestal && lower[x] >= cut - 2)) continue;
    points.push({ x: x / span - 0.5, y: lower[x] / span });
  }
  const coverage = points.length / (span * 0.84);
  diagnostic.coverage = coverage;
  diagnostic.retainedColumns = points.length;
  if (captureProfiles)
    diagnostic.profiles = {
      x0,
      y0,
      rowWidths: rows.map((r) => Math.max(0, r.right - r.left + 1)),
      lower: Array.from(lower),
      upper: Array.from(upper),
      points,
    };
  if (coverage < 0.65) return finish(undefined, 'insufficient-contour-coverage');
  const fit = (degree: 1 | 2) => {
    const a = Array.from({ length: degree + 1 }, (_, row) =>
      Array.from({ length: degree + 2 }, (_, col) =>
        points.reduce((sum, p) => sum + Math.pow(p.x, row) * (col <= degree ? Math.pow(p.x, col) : p.y), 0),
      ),
    );
    for (let i = 0; i <= degree; i++) {
      let pivot = i;
      for (let r = i + 1; r <= degree; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
      [a[i], a[pivot]] = [a[pivot], a[i]];
      const denominator = a[i][i];
      if (Math.abs(denominator) < 1e-9) return;
      for (let c = i; c <= degree + 1; c++) a[i][c] /= denominator;
      for (let r = 0; r <= degree; r++)
        if (r !== i) {
          const factor = a[r][i];
          for (let c = i; c <= degree + 1; c++) a[r][c] -= factor * a[i][c];
        }
    }
    const values = a.map((r) => r[degree + 1]);
    const error = Math.sqrt(
      points.reduce(
        (sum, p) =>
          sum +
          Math.pow(p.y - values.reduce((v, coefficient, i) => v + coefficient * Math.pow(p.x, i), 0), 2),
        0,
      ) / points.length,
    );
    return { values, error };
  };
  const line = fit(1),
    curve = fit(2);
  if (!line || !curve) return finish(undefined, 'singular-contour-fit');
  diagnostic.line = line;
  diagnostic.curve = curve;
  const curvature = -curve.values[2] * 0.25;
  const vertex = -curve.values[1] / (2 * curve.values[2]);
  diagnostic.curvature = curvature;
  diagnostic.vertex = vertex;
  const sideDepth = [0.12, 0.88].map((t) => {
    const i = Math.round(t * (span - 1));
    return (lower[i] - upper[i]) / span;
  });
  diagnostic.sideDepth = sideDepth;
  const checks = (diagnostic.checks = {
    round: {
      curved: curvature >= 0.045,
      centred: Math.abs(vertex) <= 0.25,
      lowResidual: curve.error <= Math.max(1.5 / span, 0.012),
      preferredOverLine: line.error >= Math.max(curve.error * 2.5, 0.02),
    },
    rectangular: {
      lowResidual: line.error <= Math.max(1 / span, 0.008),
      lowCurvature: Math.abs(curvature) < 0.018,
      deepSides: sideDepth.every((v) => v >= 0.1),
      moderateSlope: Math.abs(line.values[1]) < 0.55,
    },
  });
  if (Object.values(checks.round).every(Boolean))
    return finish({
      value: 'round',
      source: 'semantic-contour',
      coverage: Math.min(1, coverage),
      fitError: curve.error,
      curvature,
    });
  if (Object.values(checks.rectangular).every(Boolean))
    return finish({
      value: 'rectangular',
      source: 'semantic-contour',
      coverage: Math.min(1, coverage),
      fitError: line.error,
      curvature,
    });
  return finish(undefined, 'no-supported-contour-fit');
}

type EdgePoint = { x: number; y: number; strength: number };
type EdgeLine = {
  slope: number;
  intercept: number;
  error: number;
  inliers: number;
  coverage: number;
  span: number;
};
type PedestalRimDiagnostic = {
  rejectedBy: string[];
  left?: EdgeLine;
  right?: EdgeLine;
  intersection?: { x: number; y: number };
  curveError?: number;
  pairedError?: number;
  points?: EdgePoint[];
};

function pedestalRim(
  pixels: number[],
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: ReconstructionCandidate['bounds'],
  base: BasinShapeDiagnostic,
  captureProfiles: boolean,
): { evidence?: ShapeEvidence; diagnostic: PedestalRimDiagnostic } {
  const diagnostic: PedestalRimDiagnostic = { rejectedBy: [] };
  const fail = (reason: string) => {
    diagnostic.rejectedBy.push(reason);
    return { diagnostic };
  };
  if (
    rgba.length !== width * height * 4 ||
    base.widestRow === undefined ||
    base.cut === undefined ||
    !base.span ||
    base.cut - base.widestRow < 8
  )
    return fail('missing-bowl-region');
  const span = base.span,
    x0 = Math.floor(bounds.left * width),
    start = base.widestRow,
    cut = base.cut;
  const membership = new Uint8Array(width * height);
  for (const p of pixels) membership[p] = 1;
  const luminance = (x: number, y: number) => {
    const p = (y * width + x) * 4;
    return rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722;
  };
  const points: EdgePoint[] = [];
  for (let x = Math.ceil(span * 0.08); x < span * 0.92; x++) {
    let best: EdgePoint | undefined;
    for (let y = Math.max(6, start + 3); y < Math.min(height - 6, cut + Math.ceil(span * 0.08)); y++) {
      // The brightness edge must touch the actual basin component, not just its rectangular crop.
      if (!membership[y * width + x0 + x] && !membership[(y - 3) * width + x0 + x]) continue;
      let above = 0,
        below = 0;
      for (let d = 2; d <= 5; d++) {
        above += luminance(x0 + x, y - d);
        below += luminance(x0 + x, y + d);
      }
      const strength = (above - below) / 4;
      if (strength >= 12 && (!best || strength > best.strength))
        best = { x: x / span - 0.5, y: y / span, strength };
    }
    if (best) points.push(best);
  }
  if (captureProfiles) diagnostic.points = points;
  const lineFit = (p: EdgePoint[]): Omit<EdgeLine, 'inliers' | 'coverage' | 'span'> | undefined => {
    const n = p.length,
      sx = p.reduce((s, p) => s + p.x, 0),
      sy = p.reduce((s, p) => s + p.y, 0),
      xx = p.reduce((s, p) => s + p.x * p.x, 0),
      xy = p.reduce((s, p) => s + p.x * p.y, 0);
    const denominator = n * xx - sx * sx;
    if (n < 2 || Math.abs(denominator) < 1e-9) return;
    const slope = (n * xy - sx * sy) / denominator,
      intercept = (sy - slope * sx) / n;
    return {
      slope,
      intercept,
      error: Math.sqrt(p.reduce((s, p) => s + (p.y - intercept - slope * p.x) ** 2, 0) / n),
    };
  };
  const robust = (p: EdgePoint[], possibleColumns: number): EdgeLine | undefined => {
    const tolerance = Math.max(1 / span, 0.008);
    let best: EdgePoint[] = [];
    for (let a = 0; a < p.length; a++)
      for (let b = a + 1; b < p.length; b++) {
        if (p[b].x - p[a].x < 0.15) continue;
        const f = lineFit([p[a], p[b]]);
        if (!f) continue;
        const inliers = p.filter((point) => Math.abs(point.y - f.intercept - f.slope * point.x) <= tolerance);
        if (inliers.length > best.length) best = inliers;
      }
    const fitted = lineFit(best);
    if (!fitted) return;
    return {
      ...fitted,
      inliers: best.length,
      coverage: best.length / possibleColumns,
      span: best.at(-1)!.x - best[0].x,
    };
  };
  const left = robust(
      points.filter((p) => p.x <= -0.05),
      span * 0.37,
    ),
    right = robust(
      points.filter((p) => p.x >= 0.05),
      span * 0.37,
    );
  diagnostic.left = left;
  diagnostic.right = right;
  if (!left || !right) return fail('missing-paired-edges');
  if (
    [left, right].some(
      (line) => line.coverage < 0.7 || line.span < 0.25 || line.error > Math.max(1 / span, 0.008),
    )
  )
    return fail('insufficient-straight-edge-support');
  if (
    left.slope <= 0.06 ||
    right.slope >= -0.06 ||
    Math.max(Math.abs(left.slope), Math.abs(right.slope)) >= 0.8
  )
    return fail('edges-do-not-form-front-rim');
  // Two short chords can also fit a rounded rim. Compare the same supported points
  // against one smooth quadratic before treating their junction as a square corner.
  const supported = points.filter((p) => {
    const edge = p.x <= -0.05 ? left : p.x >= 0.05 ? right : undefined;
    return edge && Math.abs(p.y - edge.intercept - edge.slope * p.x) <= Math.max(1 / span, 0.008);
  });
  const matrix = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 4 }, (_, col) =>
      supported.reduce((sum, p) => sum + p.x ** row * (col < 3 ? p.x ** col : p.y), 0),
    ),
  );
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(matrix[r][i]) > Math.abs(matrix[pivot][i])) pivot = r;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    const denominator = matrix[i][i];
    if (Math.abs(denominator) < 1e-9) return fail('ambiguous-rim-curve');
    for (let c = i; c < 4; c++) matrix[i][c] /= denominator;
    for (let r = 0; r < 3; r++)
      if (r !== i) {
        const factor = matrix[r][i];
        for (let c = i; c < 4; c++) matrix[r][c] -= factor * matrix[i][c];
      }
  }
  const coefficients = matrix.map((row) => row[3]);
  diagnostic.curveError = Math.sqrt(
    supported.reduce(
      (sum, p) => sum + (p.y - coefficients[0] - coefficients[1] * p.x - coefficients[2] * p.x ** 2) ** 2,
      0,
    ) / supported.length,
  );
  diagnostic.pairedError = Math.sqrt(
    supported.reduce((sum, p) => {
      const edge = p.x < 0 ? left : right;
      return sum + (p.y - edge.intercept - edge.slope * p.x) ** 2;
    }, 0) / supported.length,
  );
  if (diagnostic.curveError <= Math.max(diagnostic.pairedError * 1.3, 0.002))
    return fail('smooth-curve-explains-rim');
  const x = (right.intercept - left.intercept) / (left.slope - right.slope),
    y = (left.intercept + left.slope * x) * span;
  diagnostic.intersection = { x: x + 0.5, y };
  if (x < -0.25 || x > 0.25 || y < start || y > cut) return fail('rim-junction-outside-bowl');
  return {
    evidence: {
      value: 'rectangular',
      source: 'semantic-rgb-contour',
      coverage: Math.min(1, left.coverage, right.coverage),
      fitError: Math.max(left.error, right.error),
      edgeSlopes: [left.slope, right.slope],
      rimIntersection: { x: (x0 + (x + 0.5) * span) / width, y: y / height },
      observedEdgeCoverage: [Math.min(1, left.coverage), Math.min(1, right.coverage)],
    },
    diagnostic,
  };
}

/** Diagnose exactly the same observation path used by production; profiles are opt-in. */
export function inspectBasinShape(
  pixels: number[],
  width: number,
  height: number,
  bounds: ReconstructionCandidate['bounds'],
  hasPedestal: boolean,
  captureProfiles = false,
  rgba?: Uint8ClampedArray,
): { evidence?: ShapeEvidence; diagnostic: BasinShapeDiagnostic } {
  const semantic = inspectSemanticBasinShape(pixels, width, height, bounds, hasPedestal, captureProfiles);
  if (
    semantic.evidence ||
    !hasPedestal ||
    !rgba ||
    semantic.diagnostic.rejectedBy.includes('frame-clipped') ||
    semantic.diagnostic.rejectedBy.includes('insufficient-resolution')
  )
    return semantic;
  const rim = pedestalRim(pixels, rgba, width, height, bounds, semantic.diagnostic, captureProfiles);
  semantic.diagnostic.method = 'semantic-rgb-contour-v2';
  semantic.diagnostic.rim = rim.diagnostic;
  if (!rim.evidence) return semantic;
  semantic.diagnostic.semanticRejection = [...semantic.diagnostic.rejectedBy];
  semantic.diagnostic.rejectedBy = [];
  return { evidence: rim.evidence, diagnostic: semantic.diagnostic };
}

/** Normal callers receive only bounded evidence. Raw masks/RGB/profiles stay in opt-in diagnostics. */
export function observeBasinShape(
  pixels: number[],
  width: number,
  height: number,
  bounds: ReconstructionCandidate['bounds'],
  hasPedestal: boolean,
  rgba?: Uint8ClampedArray,
): ShapeEvidence | undefined {
  return inspectBasinShape(pixels, width, height, bounds, hasPedestal, false, rgba).evidence;
}

/** Two distinct, supported bowl regions are evidence; a wide cabinet or one wide region is not. */
export function observeBasinCount(
  basins: ReconstructionCandidate[],
  cabinet: ReconstructionCandidate,
): ReconstructionCandidate['evidence']['bowlCount'] {
  if (basins.length !== 2 || basins.some((b) => b.requiresReview || b.evidence.meanMargin < 2)) return;
  const [a, b] = [...basins].sort((a, b) => a.bounds.left - b.bounds.left).map((c) => c.bounds);
  const cabinetWidth = cabinet.bounds.right - cabinet.bounds.left;
  const aw = a.right - a.left,
    bw = b.right - b.left;
  const ah = a.bottom - a.top,
    bh = b.bottom - b.top;
  if (
    Math.min(aw, bw) < cabinetWidth * 0.18 ||
    Math.min(aw, bw) / Math.max(aw, bw) < 0.55 ||
    a.right > b.left + Math.min(aw, bw) * 0.08 ||
    Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) > Math.max(ah, bh) * 0.55
  )
    return;
  return { value: 2, source: 'separate-basin-components', candidateIds: basins.map((b) => b.id) };
}
