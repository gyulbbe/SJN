import type { Point, Quad } from '../types';
import type { RoomSegmentation } from '../segmentation';
import { validateQuad } from '../render/math';

export type ObservedCeiling = {
  rearLeft: number;
  rearRight: number;
  level: number;
  vanishing: Point;
};
export type PartialWallEvidence = {
  method: 'ceiling-wall-floor-lines';
  lines: {
    role: 'ceiling' | 'floor' | 'left-junction' | 'right-junction';
    a: Point;
    b: Point;
    support: number;
    span: number;
  }[];
  /** Intersections of observed line fits; never labelled as directly visible corners. */
  cornerSource: 'line-intersections';
  reasons: string[];
};
type Fit = { slope: number; intercept: number; points: Point[]; error: number };
type Junction = { x0: number; dx: number; support: number; a: Point; b: Point; span: number };
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

function leastSquares(points: Point[]): Fit | undefined {
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  const variance = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (points.length < 6 || variance < 1e-8) return;
  const slope = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / variance;
  const intercept = my - slope * mx;
  return {
    slope,
    intercept,
    points,
    error: median(points.map((p) => Math.abs(p.y - (slope * p.x + intercept)))),
  };
}

/** Reject tall isolated silhouettes: require a wide, repeated semantic wall-to-floor transition. */
function floorJunction(input: RoomSegmentation, left: number, right: number): Fit | undefined {
  const { width, height, wall, floor } = input;
  const points: Point[] = [];
  for (let x = Math.ceil(left * width); x < right * width; x++) {
    const column: number[] = [];
    for (let y = Math.ceil(height * 0.35); y < height - 8; y++) {
      if (
        [0, 1, 2].filter((d) => !!wall[(y - d) * width + x]).length >= 2 &&
        [3, 4, 5, 6, 7].filter((d) => !!floor[(y + d) * width + x]).length >= 4
      )
        column.push(y / height);
    }
    // More than one separated transition in a column is an occluder/ledge ambiguity.
    if (column.length && column.at(-1)! - column[0] <= 8 / height)
      points.push({ x: (x + 0.5) / width, y: median(column) });
  }
  const span = right - left;
  if (points.length < width * span * 0.12) return;
  let best: Fit | undefined;
  const sampled = points.filter((_, i) => i % Math.max(1, Math.floor(points.length / 35)) === 0);
  for (let i = 0; i < sampled.length; i++)
    for (let j = i + 1; j < sampled.length; j++) {
      const a = sampled[i],
        b = sampled[j];
      if (b.x - a.x < span * 0.3) continue;
      const slope = (b.y - a.y) / (b.x - a.x);
      if (Math.abs(slope) > 0.3) continue;
      const intercept = a.y - slope * a.x;
      const inliers = points.filter((p) => Math.abs(p.y - slope * p.x - intercept) <= 2.5 / height);
      const fit = leastSquares(inliers);
      if (!fit || fit.points.length < width * span * 0.12 || fit.error > 1.5 / height) continue;
      if (fit.points.at(-1)!.x - fit.points[0].x < span * 0.3) continue;
      if (!best || fit.points.length > best.points.length) best = fit;
    }
  return best;
}

function ceilingJunction(input: RoomSegmentation, observation: ObservedCeiling): Fit | undefined {
  const points: Point[] = [],
    { width, height, wall } = input;
  for (let x = Math.ceil(observation.rearLeft * width) + 4; x < observation.rearRight * width - 4; x++) {
    for (let y = 0; y < height * 0.25; y++) {
      if ([0, 1, 2, 3].every((d) => !!wall[(y + d) * width + x])) {
        if (y > 1 && Math.abs(y / height - observation.level) <= 0.025)
          points.push({ x: x / width, y: y / height });
        break;
      }
    }
  }
  const fit = leastSquares(points);
  return fit &&
    fit.error <= 2 / height &&
    points.length >= width * (observation.rearRight - observation.rearLeft) * 0.45
    ? fit
    : undefined;
}

function verticalJunction(
  input: RoomSegmentation & { rgba: Uint8ClampedArray },
  anchor: Point,
  bottom: number,
): Junction | undefined {
  const { width, height, wall, rgba } = input;
  const light = (i: number) => rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722;
  let best: (Junction & { score: number }) | undefined;
  const radius = Math.max(2, Math.round(width / 200));
  for (let offset = -radius; offset <= radius; offset++)
    for (let angle = -60; angle <= 60; angle++) {
      const slope = angle * 0.004,
        values: number[] = [],
        strong: number[] = [];
      for (let y = Math.ceil(anchor.y * height + 4); y < bottom * height - 3; y += 2) {
        const x = Math.round(anchor.x * width + offset + slope * (y - anchor.y * height));
        if (x < 4 || x >= width - 4 || !wall[y * width + x - 3] || !wall[y * width + x + 3]) continue;
        const gradient = Math.abs(light(y * width + x - 2) - light(y * width + x + 2));
        values.push(gradient);
        if (gradient >= 3.5) strong.push(y);
      }
      const span = ((strong.at(-1) ?? 0) - (strong[0] ?? 0)) / height;
      const support = strong.length / Math.max(1, values.length),
        strength = median(values);
      if (values.length < height * 0.1 || support < 0.7 || span < 0.28 || strength < 4) continue;
      // Repeated support wins over a short, high-contrast window/door trim crossing the anchor.
      const score = strong.length * Math.min(strength, 12) - Math.abs(offset) * 2;
      if (best && best.score >= score) continue;
      const x0 = anchor.x + offset / width - (slope * anchor.y * height) / width;
      const dx = (slope * height) / width;
      const at = (y: number) => ({ x: x0 + dx * y, y });
      best = { x0, dx, score, support, span, a: at(strong[0] / height), b: at(strong.at(-1)! / height) };
    }
  return best;
}

/** A back wall can be supported independently of hidden side-floor corners. No camera calibration. */
export function inferPartialBackWall(
  input: RoomSegmentation & { rgba: Uint8ClampedArray },
  observation?: ObservedCeiling,
): { quad: Quad; evidence: PartialWallEvidence } | undefined {
  const { width, height, wall, floor, rgba } = input;
  if (
    !observation ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 512 ||
    height > 512 ||
    wall.length !== width * height ||
    floor.length !== wall.length ||
    rgba.length !== wall.length * 4 ||
    !Object.values(observation.vanishing).every(Number.isFinite)
  )
    return;
  const { rearLeft, rearRight, level } = observation;
  if (
    ![rearLeft, rearRight, level].every(Number.isFinite) ||
    rearLeft <= 0 ||
    rearRight >= 1 ||
    rearRight - rearLeft < 0.25 ||
    level <= 1 / height ||
    level >= 0.25
  )
    return;
  const top = ceilingJunction(input, observation),
    bottom = floorJunction(input, rearLeft, rearRight);
  if (!top || !bottom) return;
  const left = verticalJunction(
    input,
    { x: rearLeft, y: top.slope * rearLeft + top.intercept },
    bottom.slope * rearLeft + bottom.intercept,
  );
  const right = verticalJunction(
    input,
    { x: rearRight, y: top.slope * rearRight + top.intercept },
    bottom.slope * rearRight + bottom.intercept,
  );
  if (!left || !right) return;
  const intersect = (horizontal: Fit, vertical: Junction): Point => {
    const y = (horizontal.slope * vertical.x0 + horizontal.intercept) / (1 - horizontal.slope * vertical.dx);
    return { x: vertical.x0 + vertical.dx * y, y };
  };
  const quad: Quad = [
    intersect(top, left),
    intersect(top, right),
    intersect(bottom, right),
    intersect(bottom, left),
  ];
  if (
    !validateQuad(quad) ||
    quad.some((p) => !Number.isFinite(p.x + p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) ||
    Math.min(quad[3].y - quad[0].y, quad[2].y - quad[1].y) < 0.3
  )
    return;
  // Both junction fits must extend through genuinely observed wall, not solely furniture edges.
  // An unseen endpoint remains an inferred line intersection; no named source-camera corner is emitted.
  const reasons = [
    '천장 교차점에서 이어지는 두 벽 이음선과 별도로 관측된 벽·바닥 접합선을 맞춰 정면 벽만 추정했어요.',
    '가려진 모서리는 관측선의 교차로 계산한 값이에요. 직접 관측한 코너나 실측 카메라 복원으로 표시하지 않아요.',
    '방 전체 높이·폭을 정면 벽에 대응한 추정이며 측벽 깊이와 제품의 실제 치수는 확인이 필요해요.',
  ];
  const line = (role: 'ceiling' | 'floor', fit: Fit) => ({
    role,
    a: { ...fit.points[0] },
    b: { ...fit.points.at(-1)! },
    support: fit.points.length / Math.max(1, width * (rearRight - rearLeft)),
    span: fit.points.at(-1)!.x - fit.points[0].x,
  });
  return {
    quad,
    evidence: {
      method: 'ceiling-wall-floor-lines',
      cornerSource: 'line-intersections',
      reasons,
      lines: [
        line('ceiling', top),
        line('floor', bottom),
        { role: 'left-junction', a: left.a, b: left.b, support: left.support, span: left.span },
        { role: 'right-junction', a: right.a, b: right.b, support: right.support, span: right.span },
      ],
    },
  };
}
