import { PerspectiveCamera, Vector3 } from 'three';
import { DEFAULT_COLOR, DEFAULT_TILE, type Point, type Quad, type Surface } from './types';
import type { RoomDefinition, RoomDimensions, RoomFace } from './room-types';

export const DEFAULT_ROOM: RoomDefinition = {
  kind: 'parametric',
  version: 1,
  widthMm: 2400,
  depthMm: 2400,
  heightMm: 2400,
};
export const ROOM_ASPECT = 1.5;
const FIELD_OF_VIEW = 50;
const FRAME_MARGIN = 0.06;

export function validateRoomDimensions(room: RoomDimensions): boolean {
  return (
    Number.isFinite(room.widthMm) &&
    room.widthMm >= 500 &&
    room.widthMm <= 20000 &&
    Number.isFinite(room.depthMm) &&
    room.depthMm >= 500 &&
    room.depthMm <= 20000 &&
    Number.isFinite(room.heightMm) &&
    room.heightMm >= 1000 &&
    room.heightMm <= 6000
  );
}

function checkRoom(room: RoomDimensions): void {
  if (!validateRoomDimensions(room))
    throw new Error('공간 가로·깊이는 0.5–20m, 높이는 1–6m로 입력해 주세요.');
}

/** Millimetre world coordinates: back z=0, front z=depth; floor y=0. */
export function createRoomCamera(room: RoomDimensions, aspect = ROOM_ASPECT): PerspectiveCamera {
  checkRoom(room);
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('공간 미리보기 비율이 올바르지 않습니다.');
  const tanVertical = Math.tan((FIELD_OF_VIEW * Math.PI) / 360);
  const available = 1 - FRAME_MARGIN * 2;
  const eyeHeight = room.heightMm * 0.55;
  const distance = Math.max(
    room.widthMm / (2 * aspect * tanVertical * available),
    eyeHeight / (tanVertical * available),
  );
  const camera = new PerspectiveCamera(FIELD_OF_VIEW, aspect, distance / 100, distance + room.depthMm + 1000);
  camera.position.set(0, eyeHeight, room.depthMm + distance);
  camera.lookAt(0, eyeHeight, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/** Face u follows screen left-to-right; wall v is top-to-bottom, floor v is back-to-front. */
export function roomFacePoint(room: RoomDimensions, face: RoomFace, u: number, v: number): Vector3 {
  switch (face) {
    case 'floor':
      return new Vector3((u - 0.5) * room.widthMm, 0, v * room.depthMm);
    case 'back':
      return new Vector3((u - 0.5) * room.widthMm, (1 - v) * room.heightMm, 0);
    case 'left':
      return new Vector3(-room.widthMm / 2, (1 - v) * room.heightMm, (1 - u) * room.depthMm);
    case 'right':
      return new Vector3(room.widthMm / 2, (1 - v) * room.heightMm, u * room.depthMm);
  }
}

export function projectRoomPoint(room: RoomDimensions, world: Vector3, aspect = ROOM_ASPECT): Point {
  const ndc = world.clone().project(createRoomCamera(room, aspect));
  return { x: (ndc.x + 1) / 2, y: (1 - ndc.y) / 2 };
}

export function roomFaceAreaM2(room: RoomDimensions, face: RoomFace): number {
  checkRoom(room);
  return (
    (face === 'floor'
      ? room.widthMm * room.depthMm
      : face === 'back'
        ? room.widthMm * room.heightMm
        : room.depthMm * room.heightMm) / 1e6
  );
}

export function createRoomSurfaces(room: RoomDimensions, aspect = ROOM_ASPECT): Surface[] {
  const camera = createRoomCamera(room, aspect);
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const;
  const names: Record<RoomFace, string> = {
    floor: '바닥',
    left: '왼쪽 벽',
    back: '정면 벽',
    right: '오른쪽 벽',
  };
  return (['floor', 'left', 'back', 'right'] as const).map((face): Surface => {
    const quad = corners.map(([u, v]) => {
      const point = roomFacePoint(room, face, u, v).project(camera);
      return { x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
    }) as Quad;
    const kind = face === 'floor' ? 'floor' : 'wall';
    return {
      id: crypto.randomUUID(),
      name: names[face],
      kind,
      roomFace: face,
      geometryMode: 'room',
      quad,
      mask: { polygon: quad.map((point) => ({ ...point })), strokes: [] },
      widthMm: face === 'left' || face === 'right' ? room.depthMm : room.widthMm,
      heightMm: face === 'floor' ? room.depthMm : room.heightMm,
      // These are user-entered settings, not dimensions measured from a photograph.
      calibrated: false,
      tile: { ...DEFAULT_TILE, shading: kind === 'wall' ? 0.35 : 0.25 },
      color: { ...DEFAULT_COLOR },
    };
  });
}
