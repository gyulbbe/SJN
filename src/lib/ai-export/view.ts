import type { RoomDimensions } from '../room-types';
import { validateRoomDimensions } from '../room-geometry';
import type { Scene } from '../types';
import { defaultRoomView, type RoomOrbit, type RoomViewState } from '../room-viewer/view-state';

/**
 * Where the AI conversion looks from: a camera outside the room circling its centre (the room
 * viewer's 'room-orbit' projection), turned in the dialog's live 3D view. The walls facing the
 * camera are cut away like the space viewer's, so the inside shows. Around the room there is a
 * plain white backdrop, which the result gets back after conversion: an older outside view
 * (the 2D front composite, a grey margin) came back with walls, glass partitions and windows in
 * the margin (2026-09-27), so the margin is never left to the model.
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

/** The plain colour around the room in the AI input, the same as the model input's padding. */
export const FLUX_BACKDROP = '#ffffff';
/** One button or arrow-key press turns a quarter. */
export const FLUX_TURN = 90;
export const FLUX_FRONT: RoomOrbit = { azimuth: 0, elevation: 0 };
export type FluxTurn = 'left' | 'right' | 'top' | 'side' | 'front';

const round = (value: number) => Math.round(value * 100) / 100;
/**
 * A direction as the camera takes it: azimuth in (−180, 180] (negative is the left side),
 * elevation 0–90 (never from below the floor), both rounded to 0.01°.
 */
export function clampFluxOrbit(orbit: RoomOrbit): RoomOrbit {
  const azimuth = Number.isFinite(orbit.azimuth) ? orbit.azimuth : 0;
  let wrapped = ((azimuth % 360) + 360) % 360;
  if (wrapped > 180) wrapped -= 360;
  const elevation = Number.isFinite(orbit.elevation) ? Math.max(0, Math.min(90, orbit.elevation)) : 0;
  const result = { azimuth: round(wrapped), elevation: round(elevation) };
  // −180 and 180 are the same place: keep one.
  if (result.azimuth === -180) result.azimuth = 180;
  return result;
}

/**
 * The buttons and arrow keys: left and right go to the next quarter that way (0 → 90 → 180 → 270;
 * from an in-between angle, to the nearest quarter past it), "top" straight down and "side" level
 * (keeping the heading), "front" back to the start.
 */
export function turnFluxOrbit(orbit: RoomOrbit, turn: FluxTurn): RoomOrbit {
  const current = clampFluxOrbit(orbit);
  if (turn === 'front') return { ...FLUX_FRONT };
  if (turn === 'top') return { azimuth: current.azimuth, elevation: 90 };
  if (turn === 'side') return { azimuth: current.azimuth, elevation: 0 };
  const quarter = current.azimuth / FLUX_TURN;
  // A hair's tolerance, so 89.999° is treated as the quarter it shows as.
  const next = turn === 'right' ? Math.floor(quarter + 1e-6) + 1 : Math.ceil(quarter - 1e-6) - 1;
  return clampFluxOrbit({ azimuth: next * FLUX_TURN, elevation: current.elevation });
}

/** The camera for a direction: the room viewer's AI orbit, fitted tightly around the room. */
export function fluxOrbitView(orbit: RoomOrbit): RoomViewState {
  return { ...defaultRoomView(), projection: 'room-orbit', orbit: clampFluxOrbit(orbit) };
}

/**
 * The direction's name: 정면 · 오른쪽 · 뒤 · 왼쪽 · 위에서 on a quarter, otherwise the side and
 * angle ("오른쪽 45° · 위 30°"). Rounded to whole degrees, as shown.
 */
export function fluxOrbitLabel(orbit: RoomOrbit): string {
  const { azimuth, elevation } = clampFluxOrbit(orbit);
  const turn = Math.round(azimuth),
    rise = Math.round(elevation);
  const side =
    turn === 0
      ? '정면'
      : Math.abs(turn) === 180
        ? '뒤'
        : turn === 90
          ? '오른쪽'
          : turn === -90
            ? '왼쪽'
            : turn > 0
              ? `오른쪽 ${turn}°`
              : `왼쪽 ${-turn}°`;
  if (rise >= 90) return turn === 0 ? '위에서' : `위에서 · ${side}`;
  return rise === 0 ? side : `${side} · 위 ${rise}°`;
}
