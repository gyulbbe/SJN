import { DEFAULT_COLOR, DEFAULT_TILE, type Mask, type Point, type Quad, type Surface } from '../types';
import { validateQuad } from './math';
import { pointInPolygon } from './mask';

export type WallSeam = { top: Point; bottom: Point };
export type AutoSurfaceInput = {
  width: number;
  height: number;
  /** Row-major class membership. Zero means outside; either 1 or 255 means inside. */
  wallMask: Uint8Array;
  floorMask: Uint8Array;
  /** Optional independently detected image corner lines; no seams are fabricated from class labels. */
  wallSeams?: WallSeam[];
  minComponentPixels?: number;
  minAreaRatio?: number;
};
export type AutoSurfaceResult = { surfaces: Surface[]; warnings: string[] };
type Component = { kind: Surface['kind']; pixels: number[]; label: number };
type Edge = { start: number; end: number; direction: number };
const MAX_VERTICES = 32768;
const MAX_CONTOURS = 1000;
const MAX_CONTOUR_VERTICES = 10000;
const MAX_SURFACES = 24;

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}
function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Remove only exactly collinear grid corners: no smoothing can expand into excluded pixels. */
function compressGridContour(points: Point[]): Point[] {
  return points.filter(
    (point, i) =>
      cross(points[(i + points.length - 1) % points.length], point, points[(i + 1) % points.length]) !== 0,
  );
}

function contoursFor(
  component: Pick<Component, 'pixels' | 'label'>,
  labels: Int32Array,
  width: number,
  height: number,
): Point[][] {
  const edges: Edge[] = [];
  const outgoing = new Map<number, number[]>();
  const stride = width + 1;
  const add = (start: number, end: number, direction: number) => {
    const index = edges.length;
    edges.push({ start, end, direction });
    const choices = outgoing.get(start);
    if (choices) choices.push(index);
    else outgoing.set(start, [index]);
  };
  for (const pixel of component.pixels) {
    const x = pixel % width,
      y = Math.floor(pixel / width);
    const tl = y * stride + x,
      tr = tl + 1,
      bl = tl + stride,
      br = bl + 1;
    // Directed boundary edges keep the classified pixel on the right, in image coordinates.
    if (y === 0 || labels[pixel - width] !== component.label) add(tl, tr, 0);
    if (x === width - 1 || labels[pixel + 1] !== component.label) add(tr, br, 1);
    if (y === height - 1 || labels[pixel + width] !== component.label) add(br, bl, 2);
    if (x === 0 || labels[pixel - 1] !== component.label) add(bl, tl, 3);
  }
  const used = new Uint8Array(edges.length);
  const contours: Point[][] = [];
  for (let first = 0; first < edges.length; first++) {
    if (used[first]) continue;
    const points: Point[] = [];
    let edgeIndex = first;
    let closed = false;
    for (let step = 0; step <= edges.length; step++) {
      if (used[edgeIndex]) break;
      const edge = edges[edgeIndex];
      used[edgeIndex] = 1;
      points.push({ x: edge.start % stride, y: Math.floor(edge.start / stride) });
      if (edge.end === edges[first].start) {
        closed = true;
        break;
      }
      const choices = (outgoing.get(edge.end) ?? []).filter((index) => !used[index]);
      if (!choices.length) break;
      // At a diagonal touch, take the tight right-hand turn instead of bridging empty pixels.
      const preference = (index: number) =>
        [1, 0, 3, 2].indexOf((edges[index].direction - edge.direction + 4) % 4);
      edgeIndex = choices.reduce((best, index) => (preference(index) < preference(best) ? index : best));
    }
    if (!closed) throw new Error('영역 경계를 닫지 못했습니다.');
    const compressed = compressGridContour(points);
    if (compressed.length >= 3) contours.push(compressed);
  }
  return contours;
}

/** Exact generic bitmap tracing: no component filtering, smoothing, or semantic-class guessing. */
export function binaryMaskToMask({
  width,
  height,
  data,
}: {
  width: number;
  height: number;
  data: Uint8Array;
}): Mask {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512 ||
    data.length !== width * height
  )
    throw new Error('마스크 크기는 각 변 512px 이내여야 해요.');
  const labels = new Int32Array(data.length);
  const pixels: number[] = [];
  for (let i = 0; i < data.length; i++)
    if (data[i]) {
      labels[i] = 1;
      pixels.push(i);
    }
  if (!pixels.length) return { polygon: [], strokes: [] };
  const contours = contoursFor({ pixels, label: 1 }, labels, width, height);
  if (
    contours.length > MAX_CONTOURS ||
    contours.reduce((count, contour) => count + contour.length, 0) > MAX_VERTICES ||
    contours.some((contour) => contour.length > MAX_CONTOUR_VERTICES)
  )
    throw new Error('경계가 너무 복잡해 마스크를 정밀화하지 못했어요.');
  const normalize = (points: Point[]) => points.map((point) => ({ x: point.x / width, y: point.y / height }));
  const outer = contours
    .filter((contour) => signedArea(contour) > 0)
    .sort((a, b) => signedArea(b) - signedArea(a));
  const holes = contours.filter((contour) => signedArea(contour) < 0);
  if (outer.some((contour) => holes.some((hole) => pointInPolygon(contour[0], hole)))) {
    // Mask holes subtract from every polygon. An island nested inside a hole therefore
    // needs an exact rectangle partition instead of losing that island during rendering.
    const rectangles: { left: number; right: number; top: number; bottom: number }[] = [];
    let previous = new Map<string, number>();
    for (let y = 0; y < height; y++) {
      const current = new Map<string, number>();
      for (let x = 0; x < width;) {
        if (!data[y * width + x]) {
          x++;
          continue;
        }
        const left = x;
        while (x < width && data[y * width + x]) x++;
        const key = `${left}:${x}`,
          existing = previous.get(key);
        if (existing !== undefined) {
          rectangles[existing].bottom = y + 1;
          current.set(key, existing);
        } else {
          current.set(key, rectangles.length);
          rectangles.push({ left, right: x, top: y, bottom: y + 1 });
        }
      }
      previous = current;
      if (rectangles.length > MAX_CONTOURS || rectangles.length * 4 > MAX_VERTICES)
        throw new Error('경계가 너무 복잡해 마스크를 정밀화하지 못했어요.');
    }
    const polygons = rectangles.map((rectangle) =>
      normalize([
        { x: rectangle.left, y: rectangle.top },
        { x: rectangle.right, y: rectangle.top },
        { x: rectangle.right, y: rectangle.bottom },
        { x: rectangle.left, y: rectangle.bottom },
      ]),
    );
    return { polygon: polygons[0] ?? [], polygons: polygons.slice(1), strokes: [] };
  }
  return {
    polygon: normalize(outer[0] ?? []),
    polygons: outer.slice(1).map(normalize),
    holes: holes.map(normalize),
    strokes: [],
  };
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter((p, i) => !i || p.x !== sorted[i - 1].x || p.y !== sorted[i - 1].y);
  const half = (source: Point[]) => {
    const result: Point[] = [];
    for (const point of source) {
      while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], point) <= 0)
        result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(unique), ...half([...unique].reverse())];
}

/** The quad controls texture perspective only. The full exact silhouette remains the clip mask. */
export function estimatePlaneQuad(contours: Point[][]): Quad {
  const points = contours.flat();
  if (!points.length) throw new Error('원근을 추정할 경계가 없습니다.');
  const hull = convexHull(points);
  while (hull.length > 4) {
    let least = 0,
      leastArea = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const area = Math.abs(
        cross(hull[(i + hull.length - 1) % hull.length], hull[i], hull[(i + 1) % hull.length]),
      );
      if (area < leastArea) {
        least = i;
        leastArea = area;
      }
    }
    hull.splice(least, 1);
  }
  let quad: Quad;
  if (hull.length === 4) {
    let topLeft = 0;
    hull.forEach((point, index) => {
      if (point.x + point.y < hull[topLeft].x + hull[topLeft].y) topLeft = index;
    });
    quad = [0, 1, 2, 3].map((offset) => ({ ...hull[(topLeft + offset) % 4] })) as Quad;
  } else {
    // A triangular or clipped region cannot determine four perspective corners. Its own tight
    // bounds supply an explicitly uncalibrated plane; this never changes its triangular mask.
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const point of points) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    quad = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
  }
  if (!validateQuad(quad)) throw new Error('너무 좁은 영역의 원근을 추정할 수 없습니다.');
  return quad;
}

type FittedLine = { slope: number; intercept: number };

/** Deterministic consensus fit. Grid noise and object/crop boundaries must not rotate the plane. */
function boundaryLine(
  points: Point[],
  minSpan: number,
  tolerance: number,
  slopeAllowed: (slope: number) => boolean,
): FittedLine | undefined {
  if (points.length < 8) return;
  const candidates = points.filter((_, i) => i % Math.max(1, Math.ceil(points.length / 40)) === 0);
  let best: Point[] = [];
  let bestScore = -Infinity;
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      const first = candidates[a],
        last = candidates[b];
      if (Math.abs(last.x - first.x) < minSpan) continue;
      const slope = (last.y - first.y) / (last.x - first.x);
      if (!slopeAllowed(slope)) continue;
      const intercept = first.y - slope * first.x;
      const inliers = points.filter((point) => Math.abs(point.y - slope * point.x - intercept) <= tolerance);
      if (inliers.length < Math.max(8, points.length * 0.25)) continue;
      const span = inliers[inliers.length - 1].x - inliers[0].x;
      if (span < minSpan) continue;
      const error =
        inliers.reduce((sum, point) => sum + Math.abs(point.y - slope * point.x - intercept), 0) /
        inliers.length;
      const score = inliers.length - error * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = inliers;
      }
    }
  }
  if (!best.length) return;
  const meanX = best.reduce((sum, point) => sum + point.x, 0) / best.length;
  const meanY = best.reduce((sum, point) => sum + point.y, 0) / best.length;
  let covariance = 0,
    variance = 0;
  for (const point of best) {
    covariance += (point.x - meanX) * (point.y - meanY);
    variance += (point.x - meanX) ** 2;
  }
  if (variance < 1e-8) return;
  const slope = covariance / variance;
  return slopeAllowed(slope) ? { slope, intercept: meanY - slope * meanX } : undefined;
}

/**
 * Fit the three observed floor/wall boundaries, not the image's foreground crop edge.
 * For example a door can hide the continuation of a diagonal floor boundary: using the
 * visible silhouette's bottom corner would give that door edge the floor's vanishing point.
 * Only texture coordinates are extrapolated; every classified pixel and hole stays exact.
 */
function estimateFloorQuad(component: Component, width: number, height: number): Quad | undefined {
  const left = new Float64Array(height).fill(Infinity);
  const right = new Float64Array(height).fill(-Infinity);
  const top = new Float64Array(width).fill(Infinity);
  let minY = height,
    maxY = 0,
    minX = width,
    maxX = 0;
  for (const pixel of component.pixels) {
    const x = pixel % width,
      y = Math.floor(pixel / width);
    left[y] = Math.min(left[y], x);
    right[y] = Math.max(right[y], x + 1);
    top[x] = Math.min(top[x], y);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + 1);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + 1);
  }
  const observedHeight = maxY - minY,
    observedWidth = maxX - minX;
  if (observedHeight < 12 || observedWidth < 16) return;
  // Use row/column envelopes, so toilet and basin holes do not participate in side fitting.
  const leftPoints: Point[] = [],
    rightPoints: Point[] = [],
    backPoints: Point[] = [];
  for (let y = minY; y < maxY; y++) {
    if (right[y] - left[y] < observedWidth * 0.1) continue;
    if (left[y] > 0) leftPoints.push({ x: y + 0.5, y: left[y] });
    if (right[y] < width) rightPoints.push({ x: y + 0.5, y: right[y] });
  }
  for (let x = minX; x < maxX; x++)
    if (Number.isFinite(top[x]) && top[x] > 0) backPoints.push({ x: x + 0.5, y: top[x] });
  const tolerance = Math.max(1.25, Math.max(width, height) / 256);
  // An almost vertical row envelope supplies no evidence that it is a floor edge rather
  // than an image crop or door jamb. Keep the generic uncalibrated estimate in that case.
  const sideSlope = (slope: number) => Math.abs(slope) >= 0.08 && Math.abs(slope) < 8;
  const leftLine = boundaryLine(leftPoints, observedHeight * 0.25, tolerance, sideSlope);
  const rightLine = boundaryLine(rightPoints, observedHeight * 0.25, tolerance, sideSlope);
  const backLine = boundaryLine(
    backPoints,
    observedWidth * 0.25,
    tolerance,
    (slope) => Math.abs(slope) <= 0.5,
  );
  if (!leftLine || !rightLine || !backLine || rightLine.slope <= leftLine.slope) return;
  const intersectAcross = (side: FittedLine, intercept: number): Point => {
    const x = (side.slope * intercept + side.intercept) / (1 - side.slope * backLine.slope);
    return { x, y: backLine.slope * x + intercept };
  };
  const rearLeft = intersectAcross(leftLine, backLine.intercept),
    rearRight = intersectAcross(rightLine, backLine.intercept);
  if (
    [rearLeft, rearRight].some(
      (point) =>
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.x > width ||
        point.y < minY - tolerance * 2 ||
        point.y > minY + observedHeight * 0.2,
    )
  )
    return;
  if (rearRight.x - rearLeft.x < observedWidth * 0.2) return;
  let frontIntercept = Infinity;
  // A projective reference rectangle may end before the image bottom. The renderer tiles
  // beyond it through the unchanged mask; clamping x alone would alter perspective again.
  for (const line of [leftLine, rightLine]) {
    frontIntercept = Math.min(frontIntercept, maxY - backLine.slope * (line.slope * maxY + line.intercept));
    const boundaryY = line.slope < 0 ? -line.intercept / line.slope : (width - line.intercept) / line.slope;
    frontIntercept = Math.min(frontIntercept, boundaryY - backLine.slope * (line.slope < 0 ? 0 : width));
  }
  const frontLeft = intersectAcross(leftLine, frontIntercept),
    frontRight = intersectAcross(rightLine, frontIntercept);
  if (Math.min(frontLeft.y, frontRight.y) - Math.max(rearLeft.y, rearRight.y) < observedHeight * 0.3) return;
  // Keep the observed transverse direction under camera roll. One photograph does not
  // establish metric calibration; this remains an editable, uncalibrated approximation.
  const quad: Quad = [rearLeft, rearRight, frontRight, frontLeft].map((point) => ({
    x: Math.max(0, Math.min(1, point.x / width)),
    y: point.y / height,
  })) as Quad;
  return validateQuad(quad) ? quad : undefined;
}

/** Converts actual semantic class masks into editable surfaces; never guesses image-class regions. */
export function detectSurfaces(input: AutoSurfaceInput): AutoSurfaceResult {
  const { width, height, wallMask, floorMask, wallSeams = [] } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 512 ||
    height > 512
  )
    throw new Error('자동 감지 마스크는 각 변 512px 이내의 유효한 크기여야 합니다.');
  const size = width * height;
  if (wallMask.length !== size || floorMask.length !== size)
    throw new Error('자동 감지 마스크와 이미지 크기가 일치하지 않습니다.');
  if (
    wallSeams.length > 3 ||
    wallSeams.some(
      ({ top, bottom }) =>
        [top.x, top.y, bottom.x, bottom.y].some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
        Math.hypot(top.x - bottom.x, top.y - bottom.y) < 0.05,
    )
  )
    throw new Error('벽의 꺾임 경계가 올바르지 않습니다.');
  const minRatio = input.minAreaRatio ?? 0.002;
  const minPixels = input.minComponentPixels ?? 16;
  if (
    !Number.isFinite(minRatio) ||
    minRatio < 0 ||
    minRatio > 1 ||
    !Number.isFinite(minPixels) ||
    minPixels < 1
  )
    throw new Error('최소 자동 감지 영역 크기가 올바르지 않습니다.');
  const minimum = Math.max(Math.ceil(minPixels), Math.ceil(size * minRatio));
  const labels = new Int32Array(size);
  const classes = new Uint8Array(size);
  const groups = new Uint8Array(size);
  let overlap = 0;
  for (let i = 0; i < size; i++) {
    if (wallMask[i] && floorMask[i]) {
      overlap++;
      continue;
    }
    classes[i] = wallMask[i] ? 1 : floorMask[i] ? 2 : 0;
    if (classes[i] !== 1) continue;
    const point = { x: ((i % width) + 0.5) / width, y: (Math.floor(i / width) + 0.5) / height };
    wallSeams.forEach(({ top, bottom }, index) => {
      if (cross(top, bottom, point) >= 0) groups[i] |= 1 << index;
    });
  }
  const queue = new Int32Array(size);
  const components: Component[] = [];
  let nextLabel = 0,
    tiny = 0;
  for (let origin = 0; origin < size; origin++) {
    if (!classes[origin] || labels[origin]) continue;
    const label = ++nextLabel,
      category = classes[origin],
      group = groups[origin];
    let read = 0,
      written = 1;
    queue[0] = origin;
    labels[origin] = label;
    while (read < written) {
      const pixel = queue[read++],
        x = pixel % width;
      const visit = (neighbor: number) => {
        if (!labels[neighbor] && classes[neighbor] === category && groups[neighbor] === group) {
          labels[neighbor] = label;
          queue[written++] = neighbor;
        }
      };
      if (x > 0) visit(pixel - 1);
      if (x < width - 1) visit(pixel + 1);
      if (pixel >= width) visit(pixel - width);
      if (pixel + width < size) visit(pixel + width);
    }
    if (written < minimum) {
      tiny++;
      continue;
    }
    components.push({
      kind: category === 1 ? 'wall' : 'floor',
      pixels: Array.from(queue.subarray(0, written)),
      label,
    });
  }
  const warnings: string[] = [];
  if (overlap) warnings.push('벽과 바닥으로 중복 판정된 픽셀은 자동 적용에서 제외했어요.');
  if (tiny) warnings.push(`너무 작은 감지 영역 ${tiny}개는 자동 적용에서 제외했어요.`);
  const surfaces: Surface[] = [];
  let verticesRemaining = MAX_VERTICES;
  const names = { wall: 0, floor: 0 };
  components.sort((a, b) => b.pixels.length - a.pixels.length);
  for (const component of components) {
    if (surfaces.length >= MAX_SURFACES) {
      warnings.push('감지 영역이 많아 큰 영역부터 24개까지 준비했어요.');
      break;
    }
    const contours = contoursFor(component, labels, width, height);
    const vertices = contours.reduce((count, contour) => count + contour.length, 0);
    if (
      contours.length > MAX_CONTOURS ||
      vertices > verticesRemaining ||
      contours.some((contour) => contour.length > MAX_CONTOUR_VERTICES)
    ) {
      warnings.push(
        '경계가 지나치게 복잡한 영역은 물체를 침범하지 않도록 제외했어요. 해당 부분은 자동 적용하지 않았어요.',
      );
      continue;
    }
    const outer = contours
      .filter((contour) => signedArea(contour) > 0)
      .sort((a, b) => signedArea(b) - signedArea(a));
    const holes = contours.filter((contour) => signedArea(contour) < 0);
    const normalize = (contour: Point[]) =>
      contour.map((point) => ({ x: point.x / width, y: point.y / height }));
    const polygons = outer.map(normalize);
    if (!polygons.length) continue;
    let quad: Quad;
    try {
      quad =
        component.kind === 'floor'
          ? (estimateFloorQuad(component, width, height) ?? estimatePlaneQuad(polygons))
          : estimatePlaneQuad(polygons);
    } catch {
      warnings.push('너무 좁은 영역은 원근을 추정하지 못해 제외했어요.');
      continue;
    }
    surfaces.push({
      id: crypto.randomUUID(),
      name: `${component.kind === 'wall' ? '벽' : '바닥'} ${++names[component.kind]}`,
      kind: component.kind,
      mask: { polygon: polygons[0], polygons: polygons.slice(1), holes: holes.map(normalize), strokes: [] },
      quad,
      widthMm: 2000,
      heightMm: 2000,
      calibrated: false,
      tile: { ...DEFAULT_TILE, shading: component.kind === 'wall' ? 0.55 : DEFAULT_TILE.shading },
      color: { ...DEFAULT_COLOR },
    });
    verticesRemaining -= vertices;
  }
  if (surfaces.some((surface) => surface.kind === 'wall') && !wallSeams.length)
    warnings.push('맞닿은 벽의 꺾임은 자동으로 확정하지 않았어요. 타일 방향과 원근이 부정확할 수 있어요.');
  if (!surfaces.length)
    warnings.push(
      '자동으로 적용할 벽이나 바닥을 찾지 못했어요. 기본 공간이나 사진으로 비교 공간 만들기에서 작업해 주세요.',
    );
  return { surfaces, warnings };
}
