import type { RoomDefinition } from '../room-types';
import { inspectStrictPlacement, type PlacementReview } from './strict-placement';
import { placementFromWallReference, type InstallationWall } from './wall-relative-placement';

export type ReviewPlacementPreset = {
  wall: InstallationWall;
  label: string;
  /** Explicit category/layout defaults, never inferred photo coordinates. */
  proposal: PlacementReview['requested'];
  valid: boolean;
  reasons: string[];
};

/** Alternatives require a user choice. No original proposal, dimension or observation is modified. */
export function reviewPlacementPresets(
  room: RoomDefinition,
  requested: PlacementReview['requested'],
): ReviewPlacementPreset[] {
  if (requested.face !== 'floor' || requested.support) return [];
  const labels = { back: '뒤쪽 벽 쪽', left: '왼쪽 벽 쪽', right: '오른쪽 벽 쪽' };
  return (['back', 'left', 'right'] as const).map((wall) => {
    const reference = {
      wall,
      alongMm: (wall === 'back' ? room.widthMm : room.depthMm) / 2,
      clearanceMm: 50,
    };
    try {
      const proposal = {
        ...requested,
        ...placementFromWallReference(room, reference, requested.depthMm * (requested.scale ?? 1)),
        orientation: wall,
        // Preserve an explicit raised base; these are wall-distance alternatives, not height edits.
        baseHeightMm: requested.baseHeightMm ?? 0,
      };
      const check = inspectStrictPlacement(room, { ...proposal, version: 2 });
      return {
        wall,
        label: labels[wall],
        proposal,
        valid: check.status === 'accepted',
        reasons: check.reasons,
      };
    } catch {
      return {
        wall,
        label: labels[wall],
        proposal: { ...requested },
        valid: false,
        reasons: ['공간 크기와 제품 규격을 먼저 확인해 주세요.'],
      };
    }
  });
}

/** A click sets the plan centre, or the wall object's bottom. No bounds fitting or product scaling. */
export function reviewPlacementPoint(
  room: RoomDefinition,
  requested: PlacementReview['requested'],
  point: { u: number; v: number },
): Partial<PlacementReview['requested']> {
  return {
    ...point,
    ...(requested.face !== 'floor' ? { baseHeightMm: (1 - point.v) * room.heightMm } : {}),
  };
}
