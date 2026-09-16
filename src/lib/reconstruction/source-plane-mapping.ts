import type { Point } from '../types';
import { homography, transformPoint, validateQuad } from '../render/math';
import type { ReconstructionPlane } from './types';

export type SourcePlanePosition = { face: ReconstructionPlane['face']; u: number; v: number };

/** Quad order describes a declared plane, not the visual top/bottom of an arbitrary mask. */
export function projectSourcePlanePoint(
  plane: ReconstructionPlane,
  point: Point,
): { uv: Point; position: SourcePlanePosition; inside: boolean } | undefined {
  const horizontal = [plane.horizontalStart ?? 0, plane.horizontalEnd ?? 1];
  const vertical = [plane.verticalStart ?? 0, plane.verticalEnd ?? 1];
  const depth = [plane.depthStart, plane.depthEnd];
  if (
    !validateQuad(plane.quad) ||
    ![point.x, point.y].every(Number.isFinite) ||
    [horizontal, vertical, depth].some(
      ([start, end]) =>
        !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1 || start >= end,
    )
  )
    return;
  try {
    const uv = transformPoint(homography(plane.quad), point);
    if (![uv.x, uv.y].every(Number.isFinite)) return;
    const alongDepth = depth[0] + (plane.face === 'left' ? 1 - uv.x : uv.x) * (depth[1] - depth[0]);
    const position: SourcePlanePosition =
      plane.face === 'floor'
        ? {
            face: 'floor',
            u: horizontal[0] + uv.x * (horizontal[1] - horizontal[0]),
            v: depth[0] + uv.y * (depth[1] - depth[0]),
          }
        : {
            face: plane.face,
            u:
              plane.face === 'back'
                ? horizontal[0] + uv.x * (horizontal[1] - horizontal[0])
                : plane.face === 'left'
                  ? 1 - alongDepth
                  : alongDepth,
            v: vertical[0] + uv.y * (vertical[1] - vertical[0]),
          };
    // Reject a singular/near-horizon result that cannot be stored safely; raw photo input stays intact.
    if (![position.u, position.v].every((value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000))
      return;
    // Numerical tolerance is not a movement: the exact projection is always retained.
    const inside = [uv.x, uv.y].every((value) => value >= -1e-9 && value <= 1 + 1e-9);
    return { uv, position, inside };
  } catch {
    return;
  }
}

/** Visible floor extent / texture rectification alone never determines a physical room rectangle. */
export function hasPhysicalFloorExtent(plane: ReconstructionPlane): boolean {
  return plane.face === 'floor' && (plane.confirmed || plane.geometrySource === 'room-boundaries');
}
