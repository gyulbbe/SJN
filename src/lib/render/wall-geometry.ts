import type { Point, Quad, Surface } from '../types';
import type { RoomSegmentation } from '../segmentation';
import { detectSurfaces, type WallSeam } from './auto-surfaces';
import { homography, transformPoint, validateQuad } from './math';

export type WallSide = 'left' | 'back' | 'right';
export type WallPlane = {
  side: WallSide;
  /** Texture reference rectangle only. Clipping to it would incorrectly remove upper side walls. */
  quad: Quad;
  heightFraction: number;
  widthFraction?: number;
  /** Relative to the full back-wall height. tile.offsetY = baseOffsetY + H * offsetFraction. */
  offsetFraction: number;
};
export type WallGeometryResult = {
  wallSeams: WallSeam[];
  planes: WallPlane[];
  warnings: string[];
  /** Evidence score, not a calibrated probability or metric survey confidence. */
  confidence: number;
};
type Line = { a: Point; b: Point };
type CornerEvidence = { line: Line; strength: number; coverage: number };
const UNIT: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function intersection(first: Line, second: Line): Point | undefined {
  const dx1 = first.b.x - first.a.x,
    dy1 = first.b.y - first.a.y;
  const dx2 = second.b.x - second.a.x,
    dy2 = second.b.y - second.a.y;
  const denominator = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denominator) < 1e-9) return;
  const t = ((second.a.x - first.a.x) * dy2 - (second.a.y - first.a.y) * dx2) / denominator;
  return { x: first.a.x + t * dx1, y: first.a.y + t * dy1 };
}
function xAt(line: Line, y: number) {
  return line.a.x + ((line.b.x - line.a.x) * (y - line.a.y)) / (line.b.y - line.a.y);
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function withinFrame(quad: Quad) {
  return (
    validateQuad(quad) &&
    quad.every(
      (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1,
    )
  );
}
function fail(message: string): WallGeometryResult {
  return { wallSeams: [], planes: [], warnings: [message], confidence: 0 };
}

function findCorner(
  anchor: Point,
  gray: Float32Array,
  wall: Uint8Array,
  width: number,
  height: number,
): CornerEvidence | undefined {
  const bottom = anchor.y * height,
    minY = Math.max(3, Math.round(bottom - height * 0.8)),
    maxY = Math.round(bottom - 4);
  if (maxY - minY < height * 0.25) return;
  let best: CornerEvidence | undefined,
    bestScore = -Infinity;
  const tolerance = Math.max(2, Math.round(width / 160));
  // An anchored line search tolerates camera roll without looking for arbitrary grout lines.
  for (let offset = -tolerance; offset <= tolerance; offset++)
    for (let angle = -60; angle <= 60; angle++) {
      const slope = angle * 0.004;
      const values: number[] = [];
      let valid = 0,
        strong = 0,
        firstStrong = height,
        lastStrong = 0;
      for (let y = minY; y <= maxY; y += 2) {
        const x = Math.round(anchor.x * width + offset + slope * (y - bottom));
        if (x < 4 || x >= width - 4 || !wall[y * width + x - 3] || !wall[y * width + x + 3]) continue;
        valid++;
        const gradient = Math.abs(gray[y * width + x - 2] - gray[y * width + x + 2]);
        values.push(Math.min(gradient, 35));
        if (gradient >= 3) {
          strong++;
          firstStrong = Math.min(firstStrong, y);
          lastStrong = Math.max(lastStrong, y);
        }
      }
      if (valid < height * 0.16 || strong / valid < 0.5 || lastStrong - firstStrong < height * 0.28) continue;
      const strength = median(values);
      if (strength < 3.5) continue;
      const score = strength + (strong / valid) * 3 - Math.abs(offset) * 0.3;
      if (score > bestScore) {
        bestScore = score;
        const at = (y: number) => ({
          x: (anchor.x * width + offset + slope * (y - bottom)) / width,
          y: y / height,
        });
        best = { line: { a: at(0), b: at(height) }, strength, coverage: strong / valid };
      }
    }
  return best;
}

function ceilingLine(
  wall: Uint8Array,
  width: number,
  height: number,
  rearLeft: Point,
  rearRight: Point,
): Line | undefined {
  const points: Point[] = [];
  const left = Math.ceil(rearLeft.x * width + 5),
    right = Math.floor(rearRight.x * width - 5);
  for (let x = left; x <= right; x += 2) {
    let y = 0;
    while (y < Math.min(rearLeft.y, rearRight.y) * height && !wall[y * width + x]) y++;
    // A wall touching the image border does not establish a visible ceiling junction.
    if (y > 1 && y < Math.min(rearLeft.y, rearRight.y) * height - height * 0.2) points.push({ x, y });
  }
  if (points.length < Math.max(10, (right - left) * 0.2)) return;
  let best: Point[] = [],
    bestScore = 0;
  const step = Math.max(1, Math.floor(points.length / 24));
  for (let i = 0; i < points.length; i += step)
    for (let j = i + step; j < points.length; j += step) {
      const a = points[i],
        b = points[j];
      if (b.x - a.x < (right - left) * 0.35) continue;
      const slope = (b.y - a.y) / (b.x - a.x);
      if (Math.abs(slope) > 0.4) continue;
      const intercept = a.y - slope * a.x;
      const inliers = points.filter((p) => Math.abs(p.y - slope * p.x - intercept) <= 2);
      const score = inliers.length;
      if (score > bestScore) {
        bestScore = score;
        best = inliers;
      }
    }
  if (best.length < points.length * 0.55 || best.at(-1)!.x - best[0].x < (right - left) * 0.5) return;
  const meanX = best.reduce((sum, p) => sum + p.x, 0) / best.length,
    meanY = best.reduce((sum, p) => sum + p.y, 0) / best.length;
  const numerator = best.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0);
  const denominator = best.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  if (denominator < 1e-8) return;
  const slope = numerator / denominator,
    intercept = meanY - slope * meanX;
  return { a: { x: 0, y: intercept / height }, b: { x: 1, y: (slope * width + intercept) / height } };
}

/** Pure image-evidence analysis, exported for synthetic geometry regressions. */
export function inferWallGeometry(
  input: RoomSegmentation & { rgba: Uint8ClampedArray; floorQuad?: Quad },
): WallGeometryResult {
  const { width, height, wall, floor, rgba } = input;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 512 ||
    height > 512 ||
    wall.length !== width * height ||
    floor.length !== wall.length ||
    rgba.length !== wall.length * 4
  )
    return fail('벽의 원근을 확인할 사진과 마스크 크기가 맞지 않아요.');
  const floorQuad =
    input.floorQuad ??
    detectSurfaces({ width, height, wallMask: new Uint8Array(wall.length), floorMask: floor }).surfaces.find(
      (surface) => surface.kind === 'floor',
    )?.quad;
  if (!floorQuad || !validateQuad(floorQuad))
    return fail('바닥과 벽이 만나는 모서리를 찾지 못했어요. 사진에 따른 원근 추정에는 한계가 있어요.');
  const [rearLeft, rearRight, frontRight, frontLeft] = floorQuad;
  if (
    rearLeft.x >= rearRight.x ||
    rearRight.x - rearLeft.x < 0.15 ||
    Math.min(frontLeft.y, frontRight.y) - Math.max(rearLeft.y, rearRight.y) < 0.08
  )
    return fail('벽을 나눌 바닥 모서리의 근거가 부족해요. 원근 추정이 부정확할 수 있어요.');
  // A supplied manual floor quad is evidence only when it still meets the observed floor.
  const floorNearby = (p: Point) => {
    const cx = Math.round(p.x * width),
      cy = Math.round(p.y * height),
      r = Math.max(3, Math.round(Math.max(width, height) * 0.02));
    for (let y = Math.max(0, cy - r); y < Math.min(height, cy + r + 1); y++)
      for (let x = Math.max(0, cx - r); x < Math.min(width, cx + r + 1); x++)
        if (floor[y * width + x]) return true;
    return false;
  };
  if (!floorNearby(rearLeft) || !floorNearby(rearRight))
    return fail('바닥의 원근점과 사진 경계가 달라 벽 분리를 확정하지 않았어요.');
  const gray = Float32Array.from(
    { length: wall.length },
    (_, i) => rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722,
  );
  const left = findCorner(rearLeft, gray, wall, width, height),
    right = findCorner(rearRight, gray, wall, width, height);
  if (!left || !right)
    return fail('두 벽 모서리의 긴 경계선을 확인하지 못했어요. 벽 분리를 수동으로 확인해 주세요.');
  const floorBack: Line = { a: rearLeft, b: rearRight };
  const bottomLeft = intersection(left.line, floorBack),
    bottomRight = intersection(right.line, floorBack);
  const ceiling = ceilingLine(wall, width, height, rearLeft, rearRight);
  const topLeft = ceiling && intersection(left.line, ceiling),
    topRight = ceiling && intersection(right.line, ceiling);
  if (!bottomLeft || !bottomRight || !topLeft || !topRight)
    return fail('천장과 벽이 만나는 선이 불분명해 세 벽의 원근을 확정하지 않았어요.');
  const backQuad: Quad = [topLeft, topRight, bottomRight, bottomLeft];
  if (!withinFrame(backQuad) || Math.min(bottomLeft.y - topLeft.y, bottomRight.y - topRight.y) < 0.2)
    return fail('벽의 기준 사각형을 안정적으로 만들지 못했어요.');
  const depth = intersection({ a: rearLeft, b: frontLeft }, { a: rearRight, b: frontRight });
  if (
    !depth ||
    depth.y >= Math.min(rearLeft.y, rearRight.y) - 0.05 ||
    depth.y < -0.8 ||
    depth.x < -0.5 ||
    depth.x > 1.5
  )
    return fail('사진의 깊이 방향 소실점을 안정적으로 확인하지 못했어요.');
  const vertical = intersection(left.line, right.line);
  const verticalLine = (bottom: Point): Line =>
    vertical && Math.abs(vertical.y) < 100
      ? { a: bottom, b: vertical }
      : {
          a: bottom,
          b: {
            x: bottom.x + (left.line.a.x - left.line.b.x + right.line.a.x - right.line.b.x) / 2,
            y: bottom.y - 1,
          },
        };
  const floorProjection = homography(UNIT, floorQuad);
  let sideFrontLeft: Point | undefined,
    sideFrontRight: Point | undefined,
    widthFraction = 1;
  for (let step = 0; step <= 8; step++) {
    const fraction = 1 - step * 0.025;
    const referenceLeft = transformPoint(floorProjection, { x: 0, y: fraction }),
      referenceRight = transformPoint(floorProjection, { x: 1, y: fraction });
    const candidateLeft = intersection({ a: bottomLeft, b: depth }, verticalLine(referenceLeft));
    const candidateRight = intersection({ a: bottomRight, b: depth }, verticalLine(referenceRight));
    if (
      candidateLeft &&
      candidateRight &&
      [candidateLeft, candidateRight].every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
    ) {
      sideFrontLeft = candidateLeft;
      sideFrontRight = candidateRight;
      widthFraction = fraction;
      break;
    }
  }
  if (!sideFrontLeft || !sideFrontRight) return fail('측벽의 바닥 접점을 화면 안에서 확인하지 못했어요.');
  const backProjection = homography(UNIT, backQuad);
  let planes: WallPlane[] | undefined;
  // Move a shared physical reference row down the back plane until the side reference
  // rectangles fit on-screen. Never clamp corner coordinates and alter a vanishing point.
  for (let step = 0; step <= 16; step++) {
    const v = step * 0.05,
      referenceLeft = transformPoint(backProjection, { x: 0, y: v }),
      referenceRight = transformPoint(backProjection, { x: 1, y: v });
    const outerLeft = intersection({ a: referenceLeft, b: depth }, verticalLine(sideFrontLeft));
    const outerRight = intersection({ a: referenceRight, b: depth }, verticalLine(sideFrontRight));
    if (!outerLeft || !outerRight) continue;
    const leftQuad: Quad = [outerLeft, referenceLeft, bottomLeft, sideFrontLeft],
      rightQuad: Quad = [referenceRight, outerRight, sideFrontRight, bottomRight];
    if (!withinFrame(leftQuad) || !withinFrame(rightQuad)) continue;
    planes = [
      { side: 'left', quad: leftQuad, heightFraction: 1 - v, widthFraction, offsetFraction: -v },
      { side: 'back', quad: backQuad, heightFraction: 1, widthFraction: 1, offsetFraction: 0 },
      { side: 'right', quad: rightQuad, heightFraction: 1 - v, widthFraction, offsetFraction: -v },
    ];
    break;
  }
  if (!planes)
    return fail('화면 안에서 세 벽의 원근 기준을 만들지 못했어요. 원근 추정이 부정확할 수 있어요.');
  return {
    wallSeams: [
      { top: topLeft, bottom: bottomLeft },
      { top: topRight, bottom: bottomRight },
    ],
    planes,
    warnings: ['사진의 경계로 벽 원근을 추정했어요. 실제 높이·폭과 문틀 보호는 별도로 확인해 주세요.'],
    confidence: Math.min(left.coverage, right.coverage, Math.min(left.strength, right.strength) / 12),
  };
}

/** Decode locally; no photo upload or external inference endpoint is involved. */
export async function analyzeWallGeometry(
  blob: Blob,
  masks: RoomSegmentation,
  floorQuad?: Quad,
): Promise<WallGeometryResult> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = masks.width;
    canvas.height = masks.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return fail('벽 경계를 분석할 사진을 읽지 못했어요.');
    ctx.drawImage(bitmap, 0, 0, masks.width, masks.height);
    return inferWallGeometry({
      ...masks,
      rgba: ctx.getImageData(0, 0, masks.width, masks.height).data,
      floorQuad,
    });
  } finally {
    bitmap.close();
  }
}

/** Call after detectSurfaces({wallSeams: result.wallSeams}); the exact masks remain untouched. */
export function applyWallGeometry(
  surfaces: Surface[],
  result: WallGeometryResult,
  options: { preserveWidths?: boolean } = {},
): Surface[] {
  if (result.wallSeams.length !== 2 || result.planes.length !== 3) return surfaces;
  const lines = result.wallSeams.map((seam) => ({ a: seam.top, b: seam.bottom }));
  const sideOf = (surface: Surface): WallSide | undefined => {
    const points = [surface.mask.polygon, ...(surface.mask.polygons ?? [])].flat();
    if (!points.length) return;
    const point = {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    };
    const side: WallSide =
      point.x < xAt(lines[0], point.y) - 1e-5
        ? 'left'
        : point.x > xAt(lines[1], point.y) + 1e-5
          ? 'right'
          : 'back';
    if (
      points.some((p) =>
        side === 'left'
          ? p.x > xAt(lines[0], p.y) + 0.005
          : side === 'right'
            ? p.x < xAt(lines[1], p.y) - 0.005
            : p.x < xAt(lines[0], p.y) - 0.005 || p.x > xAt(lines[1], p.y) + 0.005,
      )
    )
      return;
    return side;
  };
  const reference = surfaces.find((surface) => surface.kind === 'wall' && sideOf(surface) === 'back');
  const height = reference?.heightMm ?? 2000,
    offset = reference?.tile.offsetY ?? 0;
  return surfaces.map((surface) => {
    if (surface.kind !== 'wall') return surface;
    const side = sideOf(surface),
      plane = result.planes.find((plane) => plane.side === side);
    if (!plane) return surface;
    return {
      ...surface,
      name: side === 'left' ? '왼쪽 벽' : side === 'back' ? '정면 벽' : '오른쪽 벽',
      quad: plane.quad,
      widthMm: options.preserveWidths ? surface.widthMm : surface.widthMm * (plane.widthFraction ?? 1),
      heightMm: height * plane.heightFraction,
      calibrated: false,
      tile: { ...surface.tile, offsetY: offset + height * plane.offsetFraction },
    };
  });
}
