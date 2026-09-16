import type { RoomDefinition } from '../room-types';

export type InstallationWall = 'back' | 'left' | 'right';
/** Confirmed plan distances, independent of the camera and an ambiguous photo silhouette. */
export type WallRelativePosition = {
  wall: InstallationWall;
  /** Back wall: from left corner. Side walls: from the back corner. To product centre. */
  alongMm: number;
  /** Distance from supporting wall to the rear of the nominal product box. */
  clearanceMm: number;
};

function assertInputs(room: RoomDefinition, depthMm: number) {
  if (![room.widthMm, room.depthMm, room.heightMm, depthMm].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('공간과 제품 깊이는 0보다 큰 유효한 규격이어야 해요.');
}

export function placementFromWallReference(
  room: RoomDefinition,
  reference: WallRelativePosition,
  depthMm: number,
) {
  assertInputs(room, depthMm);
  if (
    !['back', 'left', 'right'].includes(reference.wall) ||
    ![reference.alongMm, reference.clearanceMm].every((n) => Number.isFinite(n) && n >= 0)
  )
    throw new Error('설치 벽과 0 이상인 거리(mm)를 확인해 주세요.');
  const centreFromWall = reference.clearanceMm + depthMm / 2;
  // Never clamp the result to the room: full model validation must report an oversized or misplaced object.
  return {
    face: 'floor' as const,
    u:
      reference.wall === 'back'
        ? reference.alongMm / room.widthMm
        : reference.wall === 'left'
          ? centreFromWall / room.widthMm
          : 1 - centreFromWall / room.widthMm,
    v: reference.wall === 'back' ? centreFromWall / room.depthMm : reference.alongMm / room.depthMm,
    baseHeightMm: 0,
    yawDegrees: reference.wall === 'left' ? 90 : reference.wall === 'right' ? -90 : 0,
  };
}

/** Show the current plan position as a starting estimate; this does not confirm the selected wall. */
export function wallReferenceFromPlacement(
  room: RoomDefinition,
  wall: InstallationWall,
  placement: { u: number; v: number },
  depthMm: number,
): WallRelativePosition {
  assertInputs(room, depthMm);
  if (!['back', 'left', 'right'].includes(wall) || ![placement.u, placement.v].every(Number.isFinite))
    throw new Error('설치 벽과 위치를 확인해 주세요.');
  return {
    wall,
    alongMm: wall === 'back' ? placement.u * room.widthMm : placement.v * room.depthMm,
    clearanceMm:
      (wall === 'back'
        ? placement.v * room.depthMm
        : wall === 'left'
          ? placement.u * room.widthMm
          : (1 - placement.u) * room.widthMm) -
      depthMm / 2,
  };
}
