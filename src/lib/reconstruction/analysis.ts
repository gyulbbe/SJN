import type { Point, Quad, Scene } from '../types';
import type { RoomDefinition } from '../room-types';
import type { RoomSegmentation } from '../segmentation';
import { detectSurfaces } from '../render/auto-surfaces';
import { inferWallGeometry } from '../render/wall-geometry';
import { homography, inverseHomography, transformPoint, validateQuad } from '../render/math';
import { projectRoomFixture } from '../room-fixtures';
import { frontContactToCentre, projectReconstructionFixture } from './projection';
import { representativeColor } from './candidates';
import type { ReconstructionCandidate, ReconstructionPlane, ReconstructionReview } from './types';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

type LinePattern = { spacing: number; polarity: 1 | -1; strength: number; start: number; end: number };
function periodicPattern(profile: number[]): LinePattern | undefined {
  if (profile.length < 64) return;
  let best: LinePattern | undefined;
  for (const polarity of [1, -1] as const) {
    const local = profile.map((value, i) => {
      if (!Number.isFinite(value)) return NaN;
      const neighbors = profile
        .slice(Math.max(0, i - 5), Math.min(profile.length, i + 6))
        .filter(Number.isFinite);
      return neighbors.length >= 6 ? polarity * (value - median(neighbors)) : NaN;
    });
    const finite = local.filter(Number.isFinite);
    if (finite.length < 24) continue;
    const strength = [...finite].sort((a, b) => a - b)[Math.floor(finite.length * 0.97)];
    const noise = median(finite.map((value) => Math.abs(value)));
    const threshold = Math.max(2.2, strength * 0.32, noise * 3.5);
    if (strength < threshold) continue;
    const peaks: number[] = [];
    for (let i = 4; i < local.length - 4; i++) {
      if (
        !Number.isFinite(local[i]) ||
        local[i] < threshold ||
        local[i] < (local[i - 1] || 0) ||
        local[i] <= (local[i + 1] || 0)
      )
        continue;
      if (peaks.length && i - peaks.at(-1)! < 4) {
        if (local[i] > local[peaks.at(-1)!]) peaks[peaks.length - 1] = i;
      } else peaks.push(i);
    }
    if (peaks.length < 4) continue;
    const gaps = peaks.slice(1).map((value, i) => value - peaks[i]);
    for (const initial of gaps) {
      if (initial < 5 || initial > profile.length / 4) continue;
      const near = gaps.filter((gap) => Math.abs(gap - initial) <= Math.max(1.5, initial * 0.16));
      if (near.length < 3) continue;
      const spacing = median(near);
      const support = gaps.filter(
        (gap) => Math.abs(gap / spacing - Math.round(gap / spacing)) < 0.2 && gap / spacing < 4,
      ).length;
      if (support < gaps.length * 0.75) continue;
      const score = near.length * median(peaks.map((i) => local[i]));
      if (!best || score > best.strength) {
        const linked = gaps.flatMap((gap, i) =>
          Math.abs(gap - spacing) <= Math.max(1.5, spacing * 0.18) ? [peaks[i], peaks[i + 1]] : [],
        );
        best = {
          spacing: spacing / profile.length,
          polarity,
          strength: score,
          start: Math.max(0, (Math.min(...linked) - spacing * 0.5) / profile.length),
          end: Math.min(1, (Math.max(...linked) + spacing * 0.5) / profile.length),
        };
      }
    }
  }
  return best;
}
/** Detect either bright or dark repeated grout, including observed segments separated by an object. */
export function periodicLineSpacing(profile: number[]): number | undefined {
  return periodicPattern(profile)?.spacing;
}
type AppearanceInput = {
  plane: ReconstructionPlane;
  room: RoomDefinition;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  mask: Uint8Array;
};
function consensus(patterns: (LinePattern | undefined)[], minimum: number): LinePattern | undefined {
  const valid = patterns.filter((p): p is LinePattern => !!p);
  let best: LinePattern[] = [];
  for (const pattern of valid) {
    const group = valid.filter((p) => Math.abs(p.spacing - pattern.spacing) / pattern.spacing < 0.2);
    if (group.length > best.length) best = group;
  }
  if (best.length < minimum) return;
  return {
    spacing: median(best.map((p) => p.spacing)),
    polarity: best.filter((p) => p.polarity === 1).length >= best.length / 2 ? 1 : -1,
    strength: best.length,
    start: median(best.map((p) => p.start)),
    end: median(best.map((p) => p.end)),
  };
}
/** Correlation resolves weak repeated ridges without mistaking compression subpeaks for grout. */
function correlationPattern(profile: number[]): LinePattern | undefined {
  const signal = profile.map((value, i) => {
    if (!Number.isFinite(value)) return NaN;
    const neighborhood = profile
      .slice(Math.max(0, i - 12), Math.min(profile.length, i + 13))
      .filter(Number.isFinite);
    return neighborhood.length >= 9 ? value - median(neighborhood) : NaN;
  });
  let best: LinePattern | undefined;
  for (const [from, to] of [
    [0, 1],
    [0, 0.65],
    [0.25, 0.9],
    [0.45, 1],
  ]) {
    const start = Math.floor(from * profile.length),
      end = Math.floor(to * profile.length),
      length = end - start;
    const correlations: { lag: number; score: number; pairs: number }[] = [];
    for (let lag = 8; lag < length / 4; lag++) {
      let xy = 0,
        xx = 0,
        yy = 0,
        pairs = 0;
      for (let i = start; i < end - lag; i++) {
        const a = signal[i],
          b = signal[i + lag];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        xy += a * b;
        xx += a * a;
        yy += b * b;
        pairs++;
      }
      if (pairs < length * 0.55 || xx / pairs < 0.25 || yy / pairs < 0.25) continue;
      correlations.push({ lag, score: xy / Math.sqrt(xx * yy), pairs });
    }
    const peaks = correlations.filter(
      (p, i) =>
        p.score >= 0.4 &&
        p.score > (correlations[i - 1]?.score ?? 0) &&
        p.score >= (correlations[i + 1]?.score ?? 0),
    );
    const max = Math.max(...peaks.map((p) => p.score));
    const candidate = peaks.find((p) => p.score >= max * 0.85);
    if (!candidate) continue;
    const evidence = candidate.score * Math.sqrt(candidate.pairs / profile.length);
    if (!best || evidence > best.strength) {
      const values = signal
        .slice(start, end)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      best = {
        spacing: candidate.lag / profile.length,
        polarity:
          values[Math.floor(values.length * 0.95)] >= -values[Math.floor(values.length * 0.05)] ? 1 : -1,
        strength: evidence,
        start: from,
        end: to,
      };
    }
  }
  return best;
}
function aggregatedPatterns(light: Float32Array, n: number, vertical: boolean) {
  const patterns: (LinePattern | undefined)[] = [];
  for (const span of [Math.round(n / 4), Math.round(n / 2)])
    for (let start = 0; start + span <= n; start += Math.round(n / 12)) {
      const profile = Array.from({ length: n }, (_, position) => {
        const values: number[] = [];
        for (let across = start; across < start + span; across++) {
          const value = light[vertical ? position * n + across : across * n + position];
          if (Number.isFinite(value)) values.push(value);
        }
        return values.length >= span * 0.18
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : NaN;
      });
      patterns.push(correlationPattern(profile) ?? periodicPattern(profile));
    }
  return patterns;
}
/** Preserve appearance even where fixtures hide most of one profile or tiles cover only half the wall. */
export function analyzePlaneAppearanceDetails(input: AppearanceInput): {
  tile: ReconstructionPlane['tile'];
  bands?: ReconstructionPlane['bands'];
} {
  const { plane, room, rgba, width, height, mask } = input;
  const projection = inverseHomography(homography(plane.quad));
  const n = 384,
    light = new Float32Array(n * n).fill(NaN),
    source = new Int32Array(n * n).fill(-1);
  const samples: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const p = transformPoint(projection, { x: (x + 0.5) / n, y: (y + 0.5) / n });
      const px = Math.floor(p.x * width),
        py = Math.floor(p.y * height);
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const i = py * width + px;
      if (!mask[i]) continue;
      const l = rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722;
      if (l < 30 || l > 248 || !rgba[i * 4 + 3]) continue;
      light[y * n + x] = l;
      source[y * n + x] = i;
      samples.push(i);
    }
  const color = samples.length >= 8 ? representativeColor(rgba, samples) : plane.tile.color;
  const rowPatterns = Array.from({ length: n }, (_, y) =>
    periodicPattern(Array.from(light.subarray(y * n, (y + 1) * n))),
  );
  const columnPatterns = Array.from({ length: n }, (_, x) =>
    periodicPattern(Array.from({ length: n }, (_, y) => light[y * n + x])),
  );
  const sx =
      (plane.face === 'floor' ? consensus(aggregatedPatterns(light, n, false), 3) : undefined) ??
      consensus(rowPatterns, 5),
    sy =
      (plane.face === 'floor' ? consensus(aggregatedPatterns(light, n, true), 3) : undefined) ??
      consensus(columnPatterns, 5);
  if (!sx || !sy) return { tile: { ...plane.tile, color, groutWidth: 0, estimated: true } };
  const depth = room.depthMm * (plane.depthEnd - plane.depthStart);
  const physicalWidth =
    plane.face === 'left' || plane.face === 'right'
      ? depth
      : room.widthMm * ((plane.horizontalEnd ?? 1) - (plane.horizontalStart ?? 0));
  const physicalHeight =
    plane.face === 'floor' ? depth : room.heightMm * ((plane.verticalEnd ?? 1) - (plane.verticalStart ?? 0));
  const widthMm = Math.round((sx.spacing * physicalWidth) / 10) * 10,
    heightMm = Math.round((sy.spacing * physicalHeight) / 10) * 10;
  if (widthMm < 40 || heightMm < 40 || widthMm > 2000 || heightMm > 2000)
    return { tile: { ...plane.tile, color, groutWidth: 0, estimated: true } };
  const sorted = [...new Set(samples)].sort(
    (a, b) =>
      rgba[a * 4] + rgba[a * 4 + 1] + rgba[a * 4 + 2] - (rgba[b * 4] + rgba[b * 4 + 1] + rgba[b * 4 + 2]),
  );
  const groutPolarity = consensus(rowPatterns, 5)?.polarity ?? sx.polarity;
  const groutSamples =
    groutPolarity > 0
      ? sorted.slice(Math.floor(sorted.length * 0.88), Math.ceil(sorted.length * 0.98))
      : sorted.slice(Math.floor(sorted.length * 0.02), Math.ceil(sorted.length * 0.12));
  const tile: ReconstructionPlane['tile'] = {
    color,
    widthMm,
    heightMm,
    groutWidth: 2,
    groutColor: representativeColor(rgba, groutSamples),
    estimated: true,
  };
  if (plane.face === 'floor') return { tile };
  const consistentColumns = columnPatterns.filter(
    (p): p is LinePattern => !!p && Math.abs(p.spacing - sy.spacing) / sy.spacing < 0.2,
  );
  const support = Array.from(
    { length: n },
    (_, y) => consistentColumns.filter((p) => y / n >= p.start && y / n <= p.end).length,
  );
  const supportThreshold = Math.max(3, Math.max(...support) * 0.18);
  const rowEvidence = rowPatterns.map((p, y) => {
    const count = Array.from(source.subarray(y * n, (y + 1) * n)).filter((i) => i >= 0).length;
    return count < n * 0.12
      ? NaN
      : (p && Math.abs(p.spacing - sx.spacing) / sx.spacing < 0.22) || support[y] >= supportThreshold
        ? 1
        : 0;
  });
  let bestSplit = 0,
    bestScore = 0.55,
    tiledBottom = true;
  for (let split = Math.ceil(n * 0.18); split <= n * 0.82; split++) {
    const above = rowEvidence.slice(0, split).filter(Number.isFinite),
      below = rowEvidence.slice(split).filter(Number.isFinite);
    if (above.length < n * 0.13 || below.length < n * 0.13) continue;
    const a = above.reduce((sum, value) => sum + value, 0) / above.length,
      b = below.reduce((sum, value) => sum + value, 0) / below.length;
    const score = Math.abs(a - b);
    if (score > bestScore && Math.min(a, b) < 0.22 && Math.max(a, b) > 0.58) {
      bestScore = score;
      bestSplit = split;
      tiledBottom = b > a;
    }
  }
  if (!bestSplit) return { tile };
  // A cap strip may be the only exposed start of tiling while a large window hides the first rows.
  const edges: { row: number; strength: number }[] = [];
  for (let y = Math.ceil(n * 0.18); y < Math.min(n * 0.82, bestSplit); y++) {
    const residuals: number[] = [];
    for (let x = 0; x < n; x++) {
      const a = light[(y - 3) * n + x],
        b = light[y * n + x],
        c = light[(y + 3) * n + x];
      if ([a, b, c].every(Number.isFinite)) residuals.push(Math.abs(b - (a + c) / 2));
    }
    if (residuals.length >= n * 0.12) edges.push({ row: y, strength: median(residuals) });
  }
  const strongest = [...edges].sort((a, b) => b.strength - a.strength)[0];
  const typicalEdge = median(edges.map((e) => e.strength));
  if (
    tiledBottom &&
    strongest &&
    strongest.strength >= Math.max(3, typicalEdge * 2.5) &&
    strongest.row < bestSplit - n * 0.03
  )
    bestSplit = strongest.row;
  const colorBetween = (from: number, to: number) => {
    const indices = Array.from(source.subarray(Math.floor(from * n) * n, Math.ceil(to * n) * n)).filter(
      (i) => i >= 0,
    );
    return indices.length >= 8 ? representativeColor(rgba, indices) : color;
  };
  const split = Math.round((bestSplit / n) * 1000) / 1000;
  return {
    tile,
    bands: [
      {
        from: 0,
        to: split,
        tile: { ...tile, color: colorBetween(0, split), groutWidth: tiledBottom ? 0 : 2 },
      },
      {
        from: split,
        to: 1,
        tile: { ...tile, color: colorBetween(split, 1), groutWidth: tiledBottom ? 2 : 0 },
      },
    ],
  };
}
export function analyzePlaneAppearance(input: AppearanceInput): ReconstructionPlane['tile'] {
  return analyzePlaneAppearanceDetails(input).tile;
}

function fittedLine(points: Point[]) {
  if (points.length < 6) return;
  const mx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const my = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const denominator = points.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
  if (denominator < 1e-6) return;
  const slope = points.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0) / denominator;
  const intercept = my - slope * mx;
  if (median(points.map((p) => Math.abs(p.y - slope * p.x - intercept))) > 0.008) return;
  return { slope, intercept };
}
/** Independent ceiling boundaries provide a depth vanishing point even when furniture hides floor corners. */
function ceilingObservation(masks: RoomSegmentation) {
  const { width, height, wall } = masks;
  const tops = Array.from({ length: width }, (_, x) => {
    for (let y = 0; y < height * 0.25 - 4; y++)
      if ([0, 1, 2, 3].every((dy) => !!wall[(y + dy) * width + x])) return y / height;
    return NaN;
  });
  const level = median(tops.slice(Math.floor(width * 0.35), Math.ceil(width * 0.65)).filter(Number.isFinite));
  if (level < 0.015 || level > 0.2) return;
  const line = (left: boolean) => {
    const points = tops.flatMap((y, x) =>
      y > 1 / height &&
      y < level * 0.9 &&
      (left ? x / width > 0.02 && x / width < 0.45 : x / width > 0.55 && x / width < 0.98)
        ? [{ x: x / width, y }]
        : [],
    );
    const groups: Point[][] = [];
    for (const point of points) {
      const previous = groups.at(-1);
      if (!previous || point.x - previous.at(-1)!.x > 3 / width) groups.push([point]);
      else previous.push(point);
    }
    return groups
      .sort((a, b) => b.length - a.length)
      .map((group) => fittedLine(group))
      .find((value) => value && (left ? value.slope > 0.1 : value.slope < -0.1));
  };
  const left = line(true),
    right = line(false);
  if (!left || !right || left.slope < 0.1 || right.slope > -0.1) return;
  const rearLeft = (level - left.intercept) / left.slope,
    rearRight = (level - right.intercept) / right.slope;
  const x = (right.intercept - left.intercept) / (left.slope - right.slope),
    y = left.slope * x + left.intercept;
  if (
    rearLeft < 0 ||
    rearRight > 1 ||
    rearRight - rearLeft < 0.25 ||
    x < rearLeft ||
    x > rearRight ||
    y < level + 0.06 ||
    y > 0.62
  )
    return;
  return { rearLeft, rearRight, level, vanishing: { x, y } };
}
/** These source points describe a visible physical subrectangle, not the silhouette of a cabinet. */
export function alignedReconstructionFloor(
  masks: RoomSegmentation,
  walls: ReconstructionPlane[],
  original: ReconstructionPlane,
): ReconstructionPlane {
  const back = walls.find((p) => p.face === 'back'),
    ceiling = ceilingObservation(masks);
  if (!back || !ceiling) return original;
  const { width, height, wall, floor } = masks;
  const transitions: Point[] = [];
  for (let x = Math.ceil(back.quad[0].x * width); x < back.quad[1].x * width; x++) {
    for (let y = Math.ceil(height * 0.45); y < height - 8; y++) {
      if (!wall[y * width + x]) continue;
      if ([2, 3, 4, 5, 6, 7].filter((dy) => !!floor[(y + dy) * width + x]).length >= 4)
        transitions.push({ x: x / width, y: y / height });
    }
  }
  if (transitions.length < width * 0.06) return original;
  const baseY = median(transitions.map((p) => p.y));
  if (baseY < ceiling.vanishing.y + 0.12 || baseY > 0.88) return original;
  const left = { x: back.quad[0].x, y: baseY },
    right = { x: back.quad[1].x, y: baseY };
  const observedRows = Array.from(floor)
    .flatMap((value, i) => (value ? [Math.floor(i / width) / height] : []))
    .sort((a, b) => a - b);
  const frontY = Math.min(1, observedRows[Math.floor(observedRows.length * 0.995)] + 1 / height);
  if (frontY - baseY < 0.12) return original;
  const factor = (frontY - ceiling.vanishing.y) / (baseY - ceiling.vanishing.y);
  const frontLeft = ceiling.vanishing.x + (left.x - ceiling.vanishing.x) * factor;
  const frontRight = ceiling.vanishing.x + (right.x - ceiling.vanishing.x) * factor;
  const from = clamp((0 - frontLeft) / (frontRight - frontLeft)),
    to = clamp((1 - frontLeft) / (frontRight - frontLeft));
  if (to - from < 0.4) return original;
  const quad: Quad = [
    { x: left.x + from * (right.x - left.x), y: baseY },
    { x: left.x + to * (right.x - left.x), y: baseY },
    { x: frontLeft + to * (frontRight - frontLeft), y: frontY },
    { x: frontLeft + from * (frontRight - frontLeft), y: frontY },
  ];
  for (const point of quad) {
    point.x = clamp(point.x);
    point.y = clamp(point.y);
  }
  if (!validateQuad(quad)) return original;
  return { ...original, quad, horizontalStart: from, horizontalEnd: to };
}

/** A labelled wall still supplies colour and a provisional plane when floor corners are obscured. */
export function observedWallPlanes(masks: RoomSegmentation, rgba: Uint8ClampedArray): ReconstructionPlane[] {
  const { width, height, wall } = masks;
  const pixels: number[] = [],
    columnCounts = new Uint16Array(width);
  for (let i = 0; i < wall.length; i++)
    if (wall[i]) {
      pixels.push(i);
      columnCounts[i % width]++;
    }
  if (pixels.length < width * height * 0.05) return [];
  const xs = pixels.map((i) => i % width).sort((a, b) => a - b),
    ys = pixels.map((i) => Math.floor(i / width)).sort((a, b) => a - b);
  const left = xs[Math.floor(xs.length * 0.005)] / width,
    right = (xs[Math.floor(xs.length * 0.995)] + 1) / width;
  const top = ys[Math.floor(ys.length * 0.015)] / height,
    bottom = (ys[Math.floor(ys.length * 0.985)] + 1) / height;
  if (right - left < 0.25 || bottom - top < 0.22) return [];
  const band = Math.max(3, Math.round(width * 0.017));
  const corner = (min: number, max: number): number | undefined => {
    let best: { x: number; score: number } | undefined;
    for (
      let x = Math.max(band + 1, Math.ceil(min * width));
      x <= Math.min(width - band - 2, max * width);
      x++
    ) {
      const strengths: number[] = [],
        high: number[] = [];
      for (let y = Math.ceil(top * height); y < bottom * height; y += 2) {
        const a = y * width + x - band,
          b = y * width + x + band;
        if (!wall[a] || !wall[b]) continue;
        const distance =
          Math.hypot(
            rgba[a * 4] - rgba[b * 4],
            rgba[a * 4 + 1] - rgba[b * 4 + 1],
            rgba[a * 4 + 2] - rgba[b * 4 + 2],
          ) / Math.sqrt(3);
        strengths.push(distance);
        if (distance >= 3.5) high.push(y);
      }
      if (
        strengths.length < height * 0.09 ||
        high.length < strengths.length * 0.65 ||
        high.at(-1)! - high[0] < height * 0.22 ||
        high.filter((y) => y < (top + (bottom - top) * 0.4) * height).length < height * 0.025
      )
        continue;
      const score = median(strengths) * Math.sqrt(strengths.length / height);
      if (score > 3 && (!best || score > best.score)) best = { x: x / width, score };
    }
    return best?.x;
  };
  const span = right - left;
  const topRows = Array.from({ length: width }, (_, x) => {
    for (let y = 0; y < height * 0.35 - 4; y++)
      if ([0, 1, 2, 3].every((dy) => !!wall[(y + dy) * width + x])) return y;
    return NaN;
  });
  const centerTop = median(
    topRows
      .slice(Math.floor((left + span * 0.35) * width), Math.ceil((left + span * 0.65) * width))
      .filter(Number.isFinite),
  );
  const ceilingCorner = (side: 'left' | 'right') => {
    if (centerTop < height * 0.015 || centerTop > height * 0.25) return;
    const start =
      side === 'left' ? Math.ceil((left + span * 0.04) * width) : Math.floor((right - span * 0.04) * width);
    const limit = side === 'left' ? (left + span * 0.42) * width : (left + span * 0.58) * width;
    const step = side === 'left' ? 1 : -1;
    let low = 0;
    for (let x = start; side === 'left' ? x < limit : x > limit; x += step) {
      const values = Array.from({ length: 7 }, (_, i) => topRows[x + i * step]).filter(Number.isFinite);
      if (values.length < 5) continue;
      const value = median(values);
      if (value <= centerTop * 0.35) low++;
      if (low >= width * 0.025 && value >= centerTop * 0.8 && value <= centerTop * 1.4)
        return (x + step * 3) / width;
    }
  };
  const perspective = ceilingObservation(masks);
  const a = perspective?.rearLeft ?? ceilingCorner('left') ?? corner(left + span * 0.06, left + span * 0.42),
    b = perspective?.rearRight ?? ceilingCorner('right') ?? corner(left + span * 0.58, right - span * 0.06);
  const regions: { face: ReconstructionPlane['face']; left: number; right: number }[] = [
    ...(a ? [{ face: 'left' as const, left, right: a }] : []),
    { face: 'back', left: a ?? left, right: b ?? right },
    ...(b ? [{ face: 'right' as const, left: b, right }] : []),
  ];
  return regions
    .filter((region) => {
      let observed = 0;
      for (let x = Math.floor(region.left * width); x < region.right * width; x++)
        observed += columnCounts[x] || 0;
      return region.right - region.left > 0.035 && observed > width * height * 0.01;
    })
    .map((region) => ({
      id: 'observed-' + region.face,
      face: region.face,
      quad: [
        { x: region.left, y: top },
        { x: region.right, y: top },
        { x: region.right, y: bottom },
        { x: region.left, y: bottom },
      ],
      depthStart: 0,
      depthEnd: region.face === 'back' ? 1 : 0.65,
      confirmed: false,
      verticalStart: 0,
      verticalEnd: 1,
      tile: { color: '#d8d8d0', widthMm: 300, heightMm: 600, groutWidth: 0, estimated: true },
    }));
}
/** Borrow a neighbouring grid only when the same cap line and finish are independently visible. */
export function continueObservedWallBands(
  planes: ReconstructionPlane[],
  rgba: Uint8ClampedArray,
  masks: RoomSegmentation,
) {
  const back = planes.find(
    (p) => p.face === 'back' && p.bands?.length === 2 && p.bands.some((b) => b.tile.groutWidth > 0),
  );
  if (!back?.bands) return;
  const originalSplit = back.bands[0].to;
  const worldSplit =
    (back.verticalStart ?? 0) + originalSplit * ((back.verticalEnd ?? 1) - (back.verticalStart ?? 0));
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const plane of planes) {
    if (plane.face === 'back' || plane.face === 'floor' || plane.bands) continue;
    const projection = inverseHomography(homography(plane.quad)),
      n = 192;
    const expected =
      (worldSplit - (plane.verticalStart ?? 0)) / ((plane.verticalEnd ?? 1) - (plane.verticalStart ?? 0));
    if (expected < 0.15 || expected > 0.85) continue;
    const sample = (u: number, v: number) => {
      const p = transformPoint(projection, { x: u, y: v }),
        x = Math.floor(p.x * masks.width),
        y = Math.floor(p.y * masks.height);
      if (x < 0 || x >= masks.width || y < 0 || y >= masks.height) return;
      const i = y * masks.width + x;
      if (!masks.wall[i]) return;
      return i;
    };
    let boundary: { v: number; strength: number } | undefined;
    for (let y = Math.ceil((expected - 0.08) * n); y < Math.min(n - 3, (expected + 0.08) * n); y++) {
      const values: number[] = [];
      for (let x = 0; x < n; x++) {
        const a = sample((x + 0.5) / n, (y - 2) / n),
          b = sample((x + 0.5) / n, y / n),
          c = sample((x + 0.5) / n, (y + 2) / n);
        if (a === undefined || b === undefined || c === undefined) continue;
        const l = (i: number) => rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722;
        values.push(Math.abs(l(b) - (l(a) + l(c)) / 2));
      }
      if (values.length < n * 0.06) continue;
      const strength = median(values);
      if (strength >= 3 && (!boundary || strength > boundary.strength)) boundary = { v: y / n, strength };
    }
    if (!boundary) continue;
    const bands = back.bands.map((sourceBand, i) => {
      const from = i === 0 ? 0 : boundary!.v,
        to = i === 0 ? boundary!.v : 1;
      const samples: number[] = [];
      for (let y = Math.ceil(from * n); y < to * n; y++)
        for (let x = 0; x < n; x++) {
          const index = sample((x + 0.5) / n, (y + 0.5) / n);
          if (index !== undefined) samples.push(index);
        }
      const color = samples.length >= 8 ? representativeColor(rgba, samples) : plane.tile.color;
      return { from, to, tile: { ...sourceBand.tile, color } };
    });
    const difference = Math.hypot(
      ...rgb(bands[1].tile.color).map((v, i) => v - rgb(back.bands![1].tile.color)[i]),
    );
    if (difference > 60) continue;
    plane.bands = bands;
    plane.tile = { ...bands.find((band) => band.tile.groutWidth > 0)!.tile };
  }
}

export function reviewFromSegmentation(
  masks: RoomSegmentation,
  rgba: Uint8ClampedArray,
  room: RoomDefinition,
): ReconstructionReview {
  const detected = detectSurfaces({
    width: masks.width,
    height: masks.height,
    wallMask: masks.wall,
    floorMask: masks.floor,
  });
  const floor = detected.surfaces.find((surface) => surface.kind === 'floor');
  const geometry = inferWallGeometry({ ...masks, rgba, floorQuad: floor?.quad });
  const planes: ReconstructionPlane[] = [];
  const make = (face: ReconstructionPlane['face'], quad: Quad): ReconstructionPlane => ({
    id: `source-${face}`,
    face,
    quad: structuredClone(quad),
    depthStart: 0,
    depthEnd: 0.65,
    confirmed: false,
    tile: {
      color: face === 'floor' ? '#b4b1aa' : '#e6e3da',
      widthMm: 300,
      heightMm: face === 'floor' ? 300 : 600,
      groutWidth: 0,
      estimated: true,
    },
  });
  if (floor) planes.push(make('floor', floor.quad));
  for (const p of geometry.planes) {
    const plane = make(p.side, p.quad);
    plane.depthEnd = p.side === 'back' ? 1 : 0.65 * (p.widthFraction ?? 1);
    plane.verticalStart = 1 - p.heightFraction;
    plane.verticalEnd = 1;
    planes.push(plane);
  }
  if (!geometry.planes.length) {
    const observedWalls = observedWallPlanes(masks, rgba);
    planes.push(...observedWalls);
    if (planes[0]?.face === 'floor') planes[0] = alignedReconstructionFloor(masks, observedWalls, planes[0]);
  }
  for (const plane of planes) {
    const appearance = analyzePlaneAppearanceDetails({
      plane,
      room,
      rgba,
      width: masks.width,
      height: masks.height,
      mask: plane.face === 'floor' ? masks.floor : masks.wall,
    });
    plane.tile = appearance.tile;
    plane.bands = appearance.bands;
  }
  continueObservedWallBands(planes, rgba, masks);
  const warnings = [
    ...geometry.warnings,
    '사진에 보이는 깊이는 방 전체가 아니에요. 보이는 깊이 구간은 임시로 뒤쪽 65%에 맞췄어요. 제품 위치는 원본과 비교해 확인해 주세요.',
    '기구는 실제 상품 복원이 아닌 기본 모형이에요. 종류·규격·위치를 확인해 주세요.',
  ];
  if (!planes.some((plane) => plane.tile.groutWidth > 0))
    warnings.push(
      '일관된 줄눈 반복을 확인하지 못해 대표색으로 준비했어요. 타일 규격과 줄눈을 직접 설정할 수 있어요.',
    );
  if (!geometry.planes.length)
    warnings.push(
      planes.some((p) => p.face !== 'floor')
        ? '벽 모서리를 정밀하게 확정하지 못했지만 관측된 벽 색과 무늬는 보존했어요. 제품 설치 위치를 원본과 비교해 확인해 주세요.'
        : '관측된 벽이 충분하지 않아 벽은 중립색으로 남겼어요. 벽 타일에서 원하는 자재를 적용해 주세요.',
    );
  return {
    version: 1,
    analysis: planes.length && geometry.planes.length ? 'complete' : 'partial',
    planes,
    candidates: structuredClone(masks.objects ?? []),
    warnings: [...new Set(warnings)],
  };
}
function inPlane(plane: ReconstructionPlane, point: Point, tolerance = 0.08) {
  if (
    !validateQuad(plane.quad) ||
    plane.depthStart < 0 ||
    plane.depthEnd > 1 ||
    plane.depthStart >= plane.depthEnd
  )
    return;
  try {
    const uv = transformPoint(homography(plane.quad), point);
    if (uv.x < -tolerance || uv.x > 1 + tolerance || uv.y < -tolerance || uv.y > 1 + tolerance) return;
    return uv;
  } catch {
    return;
  }
}
export function mapReconstructionCandidate(
  candidate: ReconstructionCandidate,
  review: ReconstructionReview,
): { face: ReconstructionPlane['face']; u: number; v: number } | undefined {
  // A weak semantic runner-up can be a patch of wall, especially near doors. Keep it reviewable.
  if (candidate.requiresReview || candidate.evidence.meanMargin < 1.5) return;
  const floorObject =
    candidate.kind === 'toilet' ||
    candidate.kind === 'basin' ||
    candidate.kind === 'vanity' ||
    candidate.kind === 'bath';
  if (floorObject) {
    const plane = review.planes.find((p) => p.face === 'floor');
    const uv = plane && inPlane(plane, candidate.foot);
    if (!plane || !uv) return;
    return {
      face: 'floor',
      u:
        (plane.horizontalStart ?? 0) +
        clamp(uv.x) * ((plane.horizontalEnd ?? 1) - (plane.horizontalStart ?? 0)),
      v: plane.depthStart + clamp(uv.y) * (plane.depthEnd - plane.depthStart),
    };
  }
  const point =
    candidate.kind === 'door'
      ? candidate.foot
      : {
          x: (candidate.bounds.left + candidate.bounds.right) / 2,
          y: (candidate.bounds.top + candidate.bounds.bottom) / 2,
        };
  const matching = review.planes
    .filter((p) => p.face !== 'floor')
    .map((plane) => ({ plane, uv: inPlane(plane, point, 0.01) }))
    .filter((p) => p.uv);
  if (matching.length !== 1) return;
  const { plane, uv } = matching[0];
  const v =
    (plane.verticalStart ?? 0) + clamp(uv!.y) * ((plane.verticalEnd ?? 1) - (plane.verticalStart ?? 0));
  const depth =
    plane.depthStart +
    (plane.face === 'left' ? 1 - clamp(uv!.x) : clamp(uv!.x)) * (plane.depthEnd - plane.depthStart);
  return {
    face: plane.face,
    u: plane.face === 'back' ? clamp(uv!.x) : plane.face === 'left' ? 1 - depth : depth,
    v,
  };
}
/** Source-plane corrections relocate linked candidates; unrelated manually added objects stay as edited. */
export function remapReconstructionCandidates(scene: Scene, review: ReconstructionReview): Scene {
  const next = structuredClone(scene);
  if (!next.room) return next;
  for (const candidate of review.candidates) {
    if (candidate.status !== 'placed' || !candidate.fixtureId) continue;
    const placement = mapReconstructionCandidate(candidate, review),
      fixture = next.fixtures.find((f) => f.id === candidate.fixtureId);
    if (!placement || !fixture?.roomPlacement) continue;
    Object.assign(
      fixture.roomPlacement,
      fixture.reconstruction
        ? frontContactToCentre(
            next.room,
            placement,
            fixture.reconstruction.depthMm * fixture.roomPlacement.scale,
            fixture.reconstruction.orientation,
          )
        : placement,
    );
    projectRoomFixture(next.room, fixture, next.imageWidth / next.imageHeight);
    projectReconstructionFixture(next.room, fixture, next.imageWidth / next.imageHeight);
  }
  return next;
}
