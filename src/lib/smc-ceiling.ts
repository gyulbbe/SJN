import { Vector3 } from 'three';
import { createRoomCamera } from './room-geometry';
import type { RoomDimensions } from './room-types';
import type { Point, Quad, Scene } from './types';

/**
 * The SMC ceiling option (docs/smc-ceiling-results-20261031.md): one click shows it. It is not a
 * surface, so no area, usage, quote or tile setting ever sees it; a scene without it is unchanged.
 */
export const SMC_CEILING_COLOR = '#ece7da';
/** The 600 mm panel where the room light hangs (room-viewer/ceiling.ts, createRoomLightRig). */
const LAMP_SIZE_MM = 600;
const LAMP_DEPTH = 0.52;
/**
 * The 2D composite's room with the light off: the 3D room's mean brightness without its downlight
 * over with it (measured, tests/smc-ceiling-browser.ts). The 2D room has no light to switch off.
 */
export const CEILING_LIGHT_OFF_LEVEL = 0.53;

/** Why the ceiling option cannot be used now, or null. */
export function ceilingToolIssue(input: {
  scene?: Pick<Scene, 'room'>;
  editing: 'before' | 'after';
  writable: boolean;
  mode: 'before' | 'after' | 'split';
}): string | null {
  if (!input.scene?.room) return 'SMC 천장은 방 치수가 있는 공간에서만 쓸 수 있어요.';
  if (input.editing === 'before') return 'SMC 천장은 After 시안에서만 써요.';
  if (!input.writable) return '읽기 전용이라 SMC 천장을 바꿀 수 없어요.';
  if (input.mode !== 'after') return '비교 보기에서는 SMC 천장을 바꿀 수 없어요.';
  return null;
}

/** The ceiling on or off; a new one has its light on, as a room without one looks. */
export function toggleCeiling(scene: Scene): void {
  if (scene.ceiling) delete scene.ceiling;
  else scene.ceiling = { kind: 'smc', light: true };
}
/** The light panel and its light, together. */
export function toggleCeilingLight(scene: Scene): void {
  if (scene.ceiling) scene.ceiling.light = !scene.ceiling.light;
}

/** The ceiling in the room camera's frame: u left wall to right wall, v back wall to front. */
export function ceilingQuad(room: RoomDimensions, aspect: number): Quad {
  const camera = createRoomCamera(room, aspect);
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  return corners.map(([u, v]): Point => {
    const point = new Vector3((u - 0.5) * room.widthMm, room.heightMm, v * room.depthMm).project(camera);
    return { x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
  }) as Quad;
}

/** The room's open front in the frame, which encloses all that the room camera sees of the room. */
export function roomOpeningQuad(room: RoomDimensions, aspect: number): Quad {
  const camera = createRoomCamera(room, aspect);
  const corners: [number, number][] = [
    [-0.5, room.heightMm],
    [0.5, room.heightMm],
    [0.5, 0],
    [-0.5, 0],
  ];
  return corners.map(([x, y]): Point => {
    const point = new Vector3(x * room.widthMm, y, room.depthMm).project(camera);
    return { x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
  }) as Quad;
}
/** The light panel in ceiling u, v: left, top, right, bottom. */
export function ceilingLampBounds(room: RoomDimensions): [number, number, number, number] {
  const halfU = LAMP_SIZE_MM / 2 / room.widthMm,
    halfV = LAMP_SIZE_MM / 2 / room.depthMm;
  return [0.5 - halfU, LAMP_DEPTH - halfV, 0.5 + halfU, LAMP_DEPTH + halfV];
}
