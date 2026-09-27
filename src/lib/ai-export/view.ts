import type { RoomDimensions } from '../room-types';
import { validateRoomDimensions } from '../room-geometry';
import type { ProjectDocument, Scene } from '../types';
import {
  clampRoomEye,
  normalizeRoomView,
  roomEyeView,
  type RoomEyePreset,
  type RoomViewState,
} from '../room-viewer/view-state';

/**
 * Where the AI conversion looks from. Always an in-room eye: the room is closed by its ceiling and
 * walls on every side of the frame, so the model has no empty margin or open top to fill in. The
 * orbit view (looking in from outside) and the 2D front composite showed a grey margin, which FLUX
 * turned into extra walls, glass partitions and windows (2026-09-27 user example).
 */
export type FluxViewChoice = RoomEyePreset | 'saved';
export const FLUX_VIEW_LABELS: Record<FluxViewChoice, string> = {
  center: '방 안 · 가운데',
  'left-corner': '방 안 · 왼쪽 모서리',
  'right-corner': '방 안 · 오른쪽 모서리',
  saved: '저장한 방 안 시점',
};

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

/** The saved space-viewer camera, when it is an in-room eye. */
function savedEye(project: Pick<ProjectDocument, 'roomView'>): RoomViewState | undefined {
  const view = normalizeRoomView(project.roomView);
  return view.projection === 'room-eye' && view.eye ? view : undefined;
}

/**
 * The views offered for the AI input, the default first-selected: a saved in-room view when the
 * user made one in the space viewer (their own framing), otherwise the centre of the open front.
 */
export function fluxViewChoices(project: Pick<ProjectDocument, 'roomView'>): {
  choices: FluxViewChoice[];
  initial: FluxViewChoice;
} {
  const saved = !!savedEye(project);
  return {
    choices: ['center', 'left-corner', 'right-corner', ...(saved ? (['saved'] as const) : [])],
    initial: saved ? 'saved' : 'center',
  };
}

/**
 * The presets' lens for the AI input: an architectural photographer's framing of a small bathroom,
 * lower and wider than the space viewer's standing eye (1500 mm, 74°, framed down). In the default
 * 2.4 m room that eye left the front-left basin out of the centre view, showed no ceiling and
 * almost no floor (2026-09-27 measurement); from 1200 mm with a 90° lens and no shift every preset
 * shows all three fixtures, 6–8% ceiling with its light panel and the floor in front of the toilet.
 */
export const FLUX_EYE_HEIGHT_MM = 1200;
export const FLUX_EYE_FOV = 90;
export const FLUX_EYE_SHIFT = 0;

/**
 * The camera for one choice: a preset's standing place and heading with the AI lens, or the
 * saved view exactly as saved (the user's own framing). A saved view that is no longer an eye
 * falls back to the centre preset.
 */
export function fluxView(
  room: RoomDimensions,
  choice: FluxViewChoice,
  project: Pick<ProjectDocument, 'roomView'>,
): RoomViewState {
  if (choice === 'saved') {
    const saved = savedEye(project);
    if (saved) return saved;
  }
  const view = roomEyeView(room, choice === 'saved' ? 'center' : choice);
  const eye = view.eye!;
  return {
    ...view,
    eye: clampRoomEye(room, {
      position: [eye.position[0], FLUX_EYE_HEIGHT_MM, eye.position[2]],
      yaw: eye.yaw,
      shift: FLUX_EYE_SHIFT,
      fov: FLUX_EYE_FOV,
    }),
  };
}
