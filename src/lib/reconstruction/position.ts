import type { FixtureInstance, Point, Quad } from '../types';
import type { RoomDefinition } from '../room-types';
import { createRoomCamera } from '../room-geometry';
import { homography, transformPoint } from '../render/math';
import { reconstructionModelTransform } from './projection';

/** Invert the actual model anchor plane, including wall depth and elevated glass bottoms. */
export function reconstructionPositionFromPhoto(
  room: RoomDefinition,
  fixture: FixtureInstance,
  photo: Point,
  aspect: number,
) {
  const placement = fixture.roomPlacement!,
    meta = fixture.reconstruction!;
  const camera = createRoomCamera(room, aspect);
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => {
    const { origin } = reconstructionModelTransform(room, {
      ...meta,
      ...placement,
      u,
      v,
      baseHeightMm: placement.face === 'floor' ? (meta.baseHeightMm ?? 0) : (1 - v) * room.heightMm,
    });
    origin.project(camera);
    return { x: (origin.x + 1) / 2, y: (1 - origin.y) / 2 };
  }) as Quad;
  const uv = transformPoint(homography(corners), photo);
  return { u: Math.max(0, Math.min(1, uv.x)), v: Math.max(0, Math.min(1, uv.y)) };
}

export function syncReconstructionHeight(
  room: RoomDefinition,
  fixture: FixtureInstance,
  previous?: FixtureInstance,
) {
  const meta = fixture.reconstruction,
    placement = fixture.roomPlacement;
  if (meta?.version !== 2 || !placement) return;
  if (placement.face !== 'floor') {
    placement.scale = Math.min(placement.scale, room.heightMm / meta.heightMm);
    if (
      previous?.roomPlacement &&
      previous.reconstruction?.baseHeightMm === meta.baseHeightMm &&
      (previous.roomPlacement.v !== placement.v || previous.roomPlacement.face !== placement.face)
    )
      meta.baseHeightMm = (1 - placement.v) * room.heightMm;
  }
  meta.baseHeightMm = Math.max(
    0,
    Math.min(
      room.heightMm - meta.heightMm * placement.scale,
      meta.baseHeightMm ?? (placement.face === 'floor' ? 0 : (1 - placement.v) * room.heightMm),
    ),
  );
  if (placement.face !== 'floor') placement.v = 1 - meta.baseHeightMm / room.heightMm;
  if (
    previous?.roomPlacement &&
    (previous.roomPlacement.u !== placement.u || previous.roomPlacement.v !== placement.v)
  )
    meta.provenance = { ...meta.provenance, position: 'user' };
}
