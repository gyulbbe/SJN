import type { Quad } from '../types';
import type { ReconstructionCandidate, ReconstructionPlane } from './types';
import { homography, inverseHomography, transformPoint, validateQuad } from '../render/math';

/** Fit an observed frame to the source wall's directions, not to a screen-aligned crop. */
export function reconstructionAppearanceQuad(
  candidate: ReconstructionCandidate,
  plane: ReconstructionPlane,
): Quad | undefined {
  if (!['window', 'mirror'].includes(candidate.kind) || !validateQuad(plane.quad)) return;
  const b = candidate.bounds,
    inverse = homography(plane.quad),
    forward = inverseHomography(inverse);
  const target = [b.left, b.top, b.right, b.bottom];
  const corners = [
    { x: b.left, y: b.top },
    { x: b.right, y: b.top },
    { x: b.right, y: b.bottom },
    { x: b.left, y: b.bottom },
  ];
  const mapped = corners.map((p) => transformPoint(inverse, p));
  const xs = mapped.map((p) => p.x),
    ys = mapped.map((p) => p.y);
  let params = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
    (Math.max(...xs) - Math.min(...xs)) / 2,
    (Math.max(...ys) - Math.min(...ys)) / 2,
  ];
  const quad = (v: number[]): Quad =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) => transformPoint(forward, { x: v[0] + x * v[2], y: v[1] + y * v[3] })) as Quad;
  function error(v: number[]) {
    if (v[2] <= 0 || v[3] <= 0) return Infinity;
    const points = quad(v);
    if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return Infinity;
    const observed = [
      Math.min(...points.map((p) => p.x)),
      Math.min(...points.map((p) => p.y)),
      Math.max(...points.map((p) => p.x)),
      Math.max(...points.map((p) => p.y)),
    ];
    return observed.reduce((sum, n, i) => sum + (n - target[i]) ** 2, 0);
  }
  let step = Math.max(params[2], params[3]) * 0.25;
  for (let round = 0; round < 36; round++) {
    let improved = false;
    for (let axis = 0; axis < 4; axis++) {
      let best = error(params),
        choice = params;
      for (const direction of [-1, 1]) {
        const attempt = [...params];
        attempt[axis] += direction * step;
        const e = error(attempt);
        if (e < best) {
          best = e;
          choice = attempt;
        }
      }
      if (choice !== params) {
        params = choice;
        improved = true;
      }
    }
    if (!improved) step *= 0.5;
  }
  const fitted = quad(params);
  if (!validateQuad(fitted) || fitted.some((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return;
  return fitted;
}
