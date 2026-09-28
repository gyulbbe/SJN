import { Vector3 } from 'three';
import type { RoomDimensions } from '../room-types';
import { validateRoomDimensions } from '../room-geometry';
import type { Scene } from '../types';
import {
  clampRoomEye,
  createRoomViewCamera,
  defaultRoomView,
  ROOM_EYE_MAX_PITCH,
  ROOM_EYE_WALL_MARGIN_MM,
  type RoomViewState,
} from '../room-viewer/view-state';

/**
 * Where the AI conversion looks from: one in-room eye the user turns (left–right and up–down) in
 * the dialog's live 3D view. The room is closed on every side the camera may see, so the model
 * has no empty margin or open top to fill in: an orbit view or the 2D front composite showed a grey
 * margin, which FLUX turned into extra walls, glass partitions and windows (2026-09-27). The 3D
 * room has no front wall, so any direction that would show the open front is refused, not filled.
 */

/**
 * The room the input is drawn in: the After's, when Before has the same size (the 3D renderer
 * needs both). Undefined for legacy photo-only scenes, which keep the 2D front composite.
 */
export function fluxRoom(after: Scene, before: Scene): RoomDimensions | undefined {
  const room = after.room,
    other = before.room;
  if (!room || !other || !validateRoomDimensions(room)) return;
  if (room.widthMm !== other.widthMm || room.heightMm !== other.heightMm || room.depthMm !== other.depthMm)
    return;
  return room;
}

/**
 * The AI lens: an architectural photographer's framing of a small bathroom, lower and wider than
 * the space viewer's standing eye (1500 mm, 74°, framed down). In the default 2.4 m room that eye
 * left the front-left basin out of frame and showed no ceiling (2026-09-27); from 1200 mm with a
 * 90° lens the room's fixtures, ceiling and floor fit. The lens is fixed; only the direction turns.
 */
export const FLUX_EYE_HEIGHT_MM = 1200;
export const FLUX_EYE_FOV = 90;
/** One arrow press or key press turns this many degrees. */
export const FLUX_TURN_STEP = 5;

/** Degrees: yaw positive turns right (towards +x), pitch positive looks up. 0, 0 faces the back wall. */
export type FluxDirection = { yaw: number; pitch: number };
export const FLUX_FRONT: FluxDirection = { yaw: 0, pitch: 0 };

/**
 * The camera for a direction: standing at the middle of the open front (the wall margin inside
 * it), eye height 1200 mm (below a low ceiling), 90° lens, no lens shift, turned and tilted.
 */
export function fluxEyeView(room: RoomDimensions, direction: FluxDirection): RoomViewState {
  return {
    ...defaultRoomView(),
    projection: 'room-eye',
    eye: clampRoomEye(room, {
      position: [0, FLUX_EYE_HEIGHT_MM, room.depthMm - ROOM_EYE_WALL_MARGIN_MM],
      yaw: direction.yaw,
      shift: 0,
      fov: FLUX_EYE_FOV,
      pitch: direction.pitch,
    }),
  };
}

/** A ray must meet a wall, the floor or the ceiling at least this far behind the open front. */
const FRONT_CLEARANCE_MM = 30;
/** Sampled beyond the frame edge by this much, so an antialiased edge pixel never sees out. */
const EDGE_SLACK = 1.02;
const EDGE_SAMPLES = 40;
const GRID = 7;

/** Where the ray from inside the room leaves its box: true when that is the open front. */
function seesOut(room: RoomDimensions, origin: Vector3, direction: Vector3) {
  const half = room.widthMm / 2;
  const exits = [
    direction.x > 0
      ? (half - origin.x) / direction.x
      : direction.x < 0
        ? (-half - origin.x) / direction.x
        : Infinity,
    direction.y > 0
      ? (room.heightMm - origin.y) / direction.y
      : direction.y < 0
        ? -origin.y / direction.y
        : Infinity,
    direction.z < 0 ? -origin.z / direction.z : Infinity,
  ];
  const front = direction.z > 0 ? (room.depthMm - origin.z) / direction.z : Infinity;
  const wall = Math.min(...exits);
  if (front <= wall) return true;
  // Meeting a closed face right at the front edge still shows the edge (and past it when blurred).
  return origin.z + direction.z * wall > room.depthMm - FRONT_CLEARANCE_MM;
}

/**
 * How many sample rays of the frame (its border, a little beyond the edge, and a 7 × 7 grid)
 * would see past the open front for this direction; 0 means the whole picture stays in the room.
 * `aspect` is the input's width ÷ height.
 */
export function fluxDirectionOutside(room: RoomDimensions, aspect: number, direction: FluxDirection): number {
  const camera = createRoomViewCamera(room, aspect, fluxEyeView(room, direction));
  const origin = camera.position.clone();
  const points: [number, number][] = [];
  for (let i = 0; i <= EDGE_SAMPLES; i++) {
    const t = (2 * i) / EDGE_SAMPLES - 1;
    points.push([t * EDGE_SLACK, EDGE_SLACK], [t * EDGE_SLACK, -EDGE_SLACK]);
    points.push([EDGE_SLACK, t * EDGE_SLACK], [-EDGE_SLACK, t * EDGE_SLACK]);
  }
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) points.push([(2 * i) / (GRID - 1) - 1, (2 * j) / (GRID - 1) - 1]);
  let outside = 0;
  const point = new Vector3();
  for (const [x, y] of points) {
    point.set(x, y, 0.5).unproject(camera);
    if (seesOut(room, origin, point.sub(origin).normalize())) outside++;
  }
  return outside;
}

const round = (value: number) => Math.round(value * 100) / 100;
/**
 * Turning from `from` (a direction that stays in the room) towards `to`: `to` itself when it
 * stays in the room, otherwise as far as it goes, left–right first and then up–down (so a slanted
 * drag slides along the limit). Deterministic, so pushing past a limit always stops at the same
 * place instead of jittering. `blocked` says a limit was met.
 */
export function clampFluxDirection(
  room: RoomDimensions,
  aspect: number,
  from: FluxDirection,
  to: FluxDirection,
): { direction: FluxDirection; blocked: boolean } {
  const target = {
    yaw: round(Math.max(-90, Math.min(90, to.yaw))),
    pitch: round(Math.max(-ROOM_EYE_MAX_PITCH, Math.min(ROOM_EYE_MAX_PITCH, to.pitch))),
  };
  const inside = (d: FluxDirection) => fluxDirectionOutside(room, aspect, d) === 0;
  if (inside(target))
    return { direction: target, blocked: target.yaw !== to.yaw || target.pitch !== to.pitch };
  const start = inside(from) ? from : FLUX_FRONT;
  const furthest = (a: FluxDirection, b: FluxDirection): FluxDirection => {
    if (inside(b)) return b;
    let low = 0,
      high = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2;
      if (inside({ yaw: a.yaw + (b.yaw - a.yaw) * mid, pitch: a.pitch + (b.pitch - a.pitch) * mid }))
        low = mid;
      else high = mid;
    }
    // Rounded towards the start, so the stop itself stays inside.
    const stop = { yaw: a.yaw + (b.yaw - a.yaw) * low, pitch: a.pitch + (b.pitch - a.pitch) * low };
    const toward = (value: number, origin: number) =>
      value > origin ? Math.floor(value * 100) / 100 : Math.ceil(value * 100) / 100;
    return { yaw: toward(stop.yaw, a.yaw), pitch: toward(stop.pitch, a.pitch) };
  };
  const sideways = furthest(start, { yaw: target.yaw, pitch: start.pitch });
  const direction = furthest(sideways, { yaw: sideways.yaw, pitch: target.pitch });
  return { direction, blocked: true };
}

/** The turn limits for display and tests: how far each way the camera goes from the front. */
export function fluxDirectionLimits(room: RoomDimensions, aspect: number) {
  const reach = (to: FluxDirection) => clampFluxDirection(room, aspect, FLUX_FRONT, to).direction;
  return {
    left: reach({ yaw: -90, pitch: 0 }).yaw,
    right: reach({ yaw: 90, pitch: 0 }).yaw,
    up: reach({ yaw: 0, pitch: ROOM_EYE_MAX_PITCH }).pitch,
    down: reach({ yaw: 0, pitch: -ROOM_EYE_MAX_PITCH }).pitch,
  };
}
