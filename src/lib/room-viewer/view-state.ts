import { Box3, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { validateRoomDimensions } from '../room-geometry';
import { WALL_FEATURE_MAX_DEPTH_MM } from '../wall-features';
import type { RoomDimensions } from '../room-types';
import { createSourceCamera, type SourceCamera } from '../reconstruction/source-camera';

/** A preserved estimated/user photo camera in the same millimetre world coordinates as the room. */
export type RoomSourceCamera = SourceCamera & { referenceRoom: RoomDimensions; source: 'estimated' | 'user' };
/**
 * An eye-level camera standing inside the room, like an architectural photograph. Millimetres in
 * room coordinates (x across, y up, z from the back wall towards the open front). The pitch is
 * always 0 so vertical edges stay vertical; framing up or down is a lens shift instead.
 */
export type RoomEye = {
  position: [number, number, number];
  /** Degrees. 0 faces the back wall (−z); positive turns towards the right wall (+x). */
  yaw: number;
  /** Vertical lens shift in frame heights, positive shows more ceiling. */
  shift: number;
  /** Horizontal field of view in degrees. */
  fov: number;
};
/** A shared camera rig, not an edit to any wall, product or design. Pan uses viewport fractions. */
export type RoomViewState = {
  version: 1;
  sourceCamera?: RoomSourceCamera;
  projection?: 'source-photo' | 'room-fit' | 'room-eye';
  /** Present exactly when projection is 'room-eye'; quaternion/zoom/pan are then unused. */
  eye?: RoomEye;
  quaternion: [number, number, number, number];
  zoom: number;
  pan: { x: number; y: number };
};
export type RoomViewDirection = 'left' | 'right' | 'up' | 'down';
export const ROOM_VIEW_MIN_ZOOM = 0.25;
export const ROOM_VIEW_MAX_ZOOM = 8;
export const ROOM_VIEW_MAX_PAN = 4;
const FOV = 50;
const FIT_AVAILABLE = 0.88;

/** Eye height of a standing photographer. */
export const ROOM_EYE_HEIGHT_MM = 1500;
/** Horizontal angle of a full-frame 24 mm lens. */
export const ROOM_EYE_FOV = 74;
export const ROOM_EYE_MIN_FOV = 60;
export const ROOM_EYE_MAX_FOV = 90;
/** Architectural framing: a slight downward lens shift shows the floor and fixtures, not ceiling. */
export const ROOM_EYE_DEFAULT_SHIFT = -0.2;
/** Keeps the lens off the wall surfaces, and away from the ceiling and the floor. */
export const ROOM_EYE_WALL_MARGIN_MM = 150;
export const ROOM_EYE_MIN_HEIGHT_MM = 300;
export const ROOM_EYE_MAX_SHIFT = 0.3;
/** Extra angle so the frustum edge never grazes the open front, which has no material. */
const FRONT_MARGIN_DEGREES = 3;
const YAW_STEP = 15;
const SHIFT_STEP = 0.1;
export const ROOM_EYE_STEP_MM = 150;

export function validRoomEye(value: unknown): value is RoomEye {
  if (!value || typeof value !== 'object') return false;
  const eye = value as RoomEye;
  return (
    Array.isArray(eye.position) &&
    eye.position.length === 3 &&
    eye.position.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000) &&
    typeof eye.yaw === 'number' &&
    Number.isFinite(eye.yaw) &&
    Math.abs(eye.yaw) <= 180 &&
    typeof eye.shift === 'number' &&
    Number.isFinite(eye.shift) &&
    Math.abs(eye.shift) <= 0.5 &&
    typeof eye.fov === 'number' &&
    Number.isFinite(eye.fov) &&
    eye.fov >= 40 &&
    eye.fov <= 100
  );
}

/**
 * Largest |yaw| whose frustum stays away from the open front. A frustum edge ray has heading
 * yaw ± fov/2 at every image row (pitch 0), and it points towards the front (+z) once
 * |heading| > 90°, so |yaw| ≤ 90° − fov/2 − margin keeps every ray on the back/side/floor/ceiling.
 */
export function roomEyeYawLimit(fov: number) {
  return Math.max(0, 90 - fov / 2 - FRONT_MARGIN_DEGREES);
}

/** The eye as rendered: inside the room, a supported lens, and a yaw that never sees the front. */
export function clampRoomEye(room: RoomDimensions, eye: RoomEye): RoomEye {
  const fov = Math.max(ROOM_EYE_MIN_FOV, Math.min(ROOM_EYE_MAX_FOV, eye.fov));
  const limit = roomEyeYawLimit(fov);
  const within = (value: number, low: number, high: number) =>
    low > high ? (low + high) / 2 : Math.max(low, Math.min(high, value));
  const margin = ROOM_EYE_WALL_MARGIN_MM;
  return {
    position: [
      within(eye.position[0], -room.widthMm / 2 + margin, room.widthMm / 2 - margin),
      within(eye.position[1], ROOM_EYE_MIN_HEIGHT_MM, room.heightMm - margin),
      within(eye.position[2], margin, room.depthMm - margin),
    ],
    yaw: Math.max(-limit, Math.min(limit, eye.yaw)),
    shift: Math.max(-ROOM_EYE_MAX_SHIFT, Math.min(ROOM_EYE_MAX_SHIFT, eye.shift)),
    fov,
  };
}

export type RoomEyePreset = 'center' | 'left-corner' | 'right-corner';
/**
 * Standing at the open front: facing the back wall from the middle, or from either front corner
 * looking across to the opposite back corner (clamped so the front stays out of frame).
 */
export function roomEyeView(
  room: RoomDimensions,
  preset: RoomEyePreset,
  base?: RoomViewState,
): RoomViewState {
  const margin = ROOM_EYE_WALL_MARGIN_MM;
  const height = Math.min(ROOM_EYE_HEIGHT_MM, room.heightMm - margin);
  const z = room.depthMm - margin;
  const side = preset === 'left-corner' ? -1 : preset === 'right-corner' ? 1 : 0;
  const x = side * (room.widthMm / 2 - margin);
  // Towards the opposite back corner: from the left corner that is +x (turning right).
  const yaw = side ? (-side * Math.atan2(room.widthMm - 2 * margin, z) * 180) / Math.PI : 0;
  const eye = clampRoomEye(room, {
    position: [x, height, z],
    yaw,
    shift: ROOM_EYE_DEFAULT_SHIFT,
    fov: ROOM_EYE_FOV,
  });
  const view = normalizeRoomView(base ?? defaultRoomView());
  return {
    ...view,
    quaternion: [0, 0, 0, 1],
    zoom: 1,
    pan: { x: 0, y: 0 },
    projection: 'room-eye',
    eye,
  };
}

/** Walks the eye on the floor plane relative to where it looks, staying inside the room. */
export function moveRoomEye(
  room: RoomDimensions,
  input: RoomViewState,
  direction: 'forward' | 'back' | 'left' | 'right',
): RoomViewState {
  const view = normalizeRoomView(input);
  if (view.projection !== 'room-eye' || !view.eye) return view;
  const eye = clampRoomEye(room, view.eye);
  const yaw = (eye.yaw * Math.PI) / 180;
  const ahead: [number, number] = [Math.sin(yaw), -Math.cos(yaw)];
  const [dx, dz] =
    direction === 'forward'
      ? ahead
      : direction === 'back'
        ? [-ahead[0], -ahead[1]]
        : direction === 'right'
          ? [-ahead[1], ahead[0]]
          : [ahead[1], -ahead[0]];
  return {
    ...view,
    eye: clampRoomEye(room, {
      ...eye,
      position: [
        eye.position[0] + dx * ROOM_EYE_STEP_MM,
        eye.position[1],
        eye.position[2] + dz * ROOM_EYE_STEP_MM,
      ],
    }),
  };
}

/** A narrower or wider lens for the in-room camera (zoom in = narrower). */
export function zoomRoomEye(input: RoomViewState, factor: number): RoomViewState {
  const view = normalizeRoomView(input);
  if (view.projection !== 'room-eye' || !view.eye || !Number.isFinite(factor) || factor <= 0) return view;
  const fov = Math.max(ROOM_EYE_MIN_FOV, Math.min(ROOM_EYE_MAX_FOV, view.eye.fov / factor));
  const limit = roomEyeYawLimit(fov);
  return { ...view, eye: { ...view.eye, fov, yaw: Math.max(-limit, Math.min(limit, view.eye.yaw)) } };
}

export function validRoomSourceCamera(value: unknown): value is RoomSourceCamera {
  if (!value || typeof value !== 'object') return false;
  const c = value as RoomSourceCamera;
  if (
    c.version !== 1 ||
    !Array.isArray(c.positionMm) ||
    c.positionMm.length !== 3 ||
    !Array.isArray(c.quaternion) ||
    c.quaternion.length !== 4 ||
    !c.image ||
    !c.referenceRoom ||
    !validateRoomDimensions(c.referenceRoom) ||
    !['estimated', 'user'].includes(c.source) ||
    c.positionMm.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e7) ||
    !Number.isSafeInteger(c.image.width) ||
    !Number.isSafeInteger(c.image.height) ||
    c.image.width > 100000 ||
    c.image.height > 100000 ||
    c.image.width / c.image.height < 0.01 ||
    c.image.width / c.image.height > 100
  )
    return false;
  try {
    createSourceCamera(c);
    return true;
  } catch {
    return false;
  }
}
export function sourceRoomView(
  camera: SourceCamera,
  room: RoomDimensions,
  source: RoomSourceCamera['source'] = 'estimated',
): RoomViewState {
  const sourceCamera: RoomSourceCamera = {
    ...structuredClone(camera),
    referenceRoom: { widthMm: room.widthMm, depthMm: room.depthMm, heightMm: room.heightMm },
    source,
  };
  if (!validRoomSourceCamera(sourceCamera))
    throw new Error('사진 시점의 위치·회전·화각·공간 기준을 확인해 주세요.');
  return { ...defaultRoomView(), sourceCamera, projection: 'source-photo' };
}
export function sourceRoomViewAvailable(room: RoomDimensions, view: RoomViewState): boolean {
  const c = view.sourceCamera;
  return (
    validRoomSourceCamera(c) &&
    c.referenceRoom.widthMm === room.widthMm &&
    c.referenceRoom.heightMm === room.heightMm &&
    c.referenceRoom.depthMm === room.depthMm
  );
}
/** Explicit mode changes preserve the reference camera; ordinary legacy views gain no new fields. */
export function resetRoomView(input: RoomViewState, mode?: 'source-photo' | 'room-fit'): RoomViewState {
  // Resetting always leaves the in-room eye: back to the photo camera or the default orbit.
  const { eye: _eye, ...view } = normalizeRoomView(input);
  void _eye;
  if (!view.sourceCamera) return defaultRoomView();
  return {
    ...view,
    quaternion: [0, 0, 0, 1],
    zoom: 1,
    pan: { x: 0, y: 0 },
    projection: mode ?? (view.projection === 'room-fit' ? 'room-fit' : 'source-photo'),
  };
}
export function defaultRoomView(): RoomViewState {
  return { version: 1, quaternion: [0, 0, 0, 1], zoom: 1, pan: { x: 0, y: 0 } };
}

function canonicalQuaternion(value: Quaternion): RoomViewState['quaternion'] {
  value.normalize();
  // q and -q describe the same camera. A canonical sign and rounded zero give stable cache keys.
  const tuple = value.toArray();
  const pivot = [...tuple].reverse().find((part) => Math.abs(part) > 1e-12) ?? 1;
  const sign = pivot < 0 ? -1 : 1;
  return tuple.map((part) => {
    const rounded = Math.round(part * sign * 1e12) / 1e12;
    return Object.is(rounded, -0) ? 0 : rounded;
  }) as RoomViewState['quaternion'];
}

/** Bad historical view data is replaced in memory only; this function never writes a document. */
export function normalizeRoomView(input: unknown): RoomViewState {
  if (!input || typeof input !== 'object') return defaultRoomView();
  const value = input as Partial<RoomViewState>;
  const q = value.quaternion;
  if (
    value.version !== 1 ||
    !Array.isArray(q) ||
    q.length !== 4 ||
    !q.every((part) => typeof part === 'number' && Number.isFinite(part)) ||
    Math.hypot(...q) < 1e-8 ||
    Math.hypot(...q) > 1e8 ||
    typeof value.zoom !== 'number' ||
    !Number.isFinite(value.zoom) ||
    value.zoom < ROOM_VIEW_MIN_ZOOM ||
    value.zoom > ROOM_VIEW_MAX_ZOOM ||
    !value.pan ||
    ![value.pan.x, value.pan.y].every(
      (part) => typeof part === 'number' && Number.isFinite(part) && Math.abs(part) <= ROOM_VIEW_MAX_PAN,
    )
  )
    return defaultRoomView();
  // An in-room eye needs its own valid parameters; otherwise the view falls back as before.
  const eye = value.projection === 'room-eye' && validRoomEye(value.eye) ? value.eye : undefined;
  return {
    version: 1,
    quaternion: canonicalQuaternion(new Quaternion(...q)),
    zoom: value.zoom,
    pan: { ...value.pan },
    ...(validRoomSourceCamera(value.sourceCamera)
      ? {
          sourceCamera: structuredClone(value.sourceCamera),
          projection: value.projection === 'room-fit' ? ('room-fit' as const) : ('source-photo' as const),
        }
      : {}),
    ...(eye
      ? {
          projection: 'room-eye' as const,
          eye: {
            position: [eye.position[0], eye.position[1], eye.position[2]] as [number, number, number],
            yaw: eye.yaw,
            shift: eye.shift,
            fov: eye.fov,
          },
        }
      : {}),
  };
}

/** At the initial front (+Z), up goes to +Y, right to +X. Axes remain screen-local thereafter. */
export function rotateRoomView(input: RoomViewState, direction: RoomViewDirection): RoomViewState {
  const view = normalizeRoomView(input);
  if (view.projection === 'room-eye' && view.eye) {
    // In the room: turn the head in small steps and frame up/down with a lens shift (no pitch).
    const eye = view.eye;
    const limit = roomEyeYawLimit(Math.max(ROOM_EYE_MIN_FOV, Math.min(ROOM_EYE_MAX_FOV, eye.fov)));
    const yaw = eye.yaw + (direction === 'right' ? YAW_STEP : direction === 'left' ? -YAW_STEP : 0);
    const shift = eye.shift + (direction === 'up' ? SHIFT_STEP : direction === 'down' ? -SHIFT_STEP : 0);
    return {
      ...view,
      eye: {
        ...eye,
        yaw: Math.max(-limit, Math.min(limit, yaw)),
        shift: Math.round(Math.max(-ROOM_EYE_MAX_SHIFT, Math.min(ROOM_EYE_MAX_SHIFT, shift)) * 1000) / 1000,
      },
    };
  }
  const axis = direction === 'left' || direction === 'right' ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const rotation = new Quaternion().setFromAxisAngle(axis, (sign * Math.PI) / 2);
  // Post multiplication rotates about the current screen axes, including when the camera is upside down.
  view.quaternion = canonicalQuaternion(new Quaternion(...view.quaternion).multiply(rotation));
  return view;
}

export function roomViewLabel(input: RoomViewState): string {
  const view = normalizeRoomView(input);
  if (view.projection === 'room-eye' && view.eye) {
    const yaw = Math.round(view.eye.yaw);
    return `방 안 시점 · ${yaw === 0 ? '정면' : yaw > 0 ? `오른쪽 ${yaw}°` : `왼쪽 ${-yaw}°`}`;
  }
  const rotation = new Quaternion(...view.quaternion);
  const side = new Vector3(0, 0, 1).applyQuaternion(rotation);
  const labels = [
    { value: side.x, positive: '오른쪽', negative: '왼쪽' },
    { value: side.y, positive: '위쪽', negative: '아래쪽' },
    { value: side.z, positive: '정면', negative: '뒤쪽' },
  ].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const direction = labels[0].value >= 0 ? labels[0].positive : labels[0].negative;
  if (Math.abs(labels[0].value) < 0.999999) return '사용자 시점';
  const up = new Vector3(0, 1, 0).applyQuaternion(rotation);
  const roll = up.y < -0.999999 ? ' · 뒤집힌 방향' : '';
  return (view.sourceCamera && view.projection === 'source-photo' ? '사진 기준 · ' : '') + direction + roll;
}

/** Only nearby, finite contents may enlarge the common fit. Corrupt far-away objects cannot shrink it. */
export function roomViewBounds(room: RoomDimensions, content?: Box3, structureBounds?: Box3): Box3 {
  if (!validateRoomDimensions(room)) throw new Error('공간 크기가 올바르지 않아요.');
  const result = new Box3(
    new Vector3(-room.widthMm / 2, 0, 0),
    new Vector3(room.widthMm / 2, room.heightMm, room.depthMm),
  );
  const margin = Math.max(room.widthMm, room.heightMm, room.depthMm) * 0.25;
  const envelope = result.clone().expandByScalar(margin);
  if (
    content &&
    !content.isEmpty() &&
    [...content.min.toArray(), ...content.max.toArray()].every(Number.isFinite) &&
    envelope.containsBox(content)
  )
    result.union(content);
  // Validated wall voids may exceed the fixture margin without weakening corrupt-fixture protection.
  if (
    structureBounds &&
    !structureBounds.isEmpty() &&
    [...structureBounds.min.toArray(), ...structureBounds.max.toArray()].every(Number.isFinite) &&
    new Box3(new Vector3(-room.widthMm / 2, 0, 0), new Vector3(room.widthMm / 2, room.heightMm, room.depthMm))
      .expandByScalar(WALL_FEATURE_MAX_DEPTH_MM)
      .containsBox(structureBounds)
  )
    result.union(structureBounds);
  return result;
}

/** Pixel viewport inside each comparison panel. Photo optics keep their original aspect. */
export function roomViewViewport(width: number, height: number, input: RoomViewState) {
  if (![width, height].every((v) => Number.isFinite(v) && v > 0))
    throw new Error('보기 크기를 확인해 주세요.');
  const view = normalizeRoomView(input);
  if (!view.sourceCamera || view.projection !== 'source-photo') return { x: 0, y: 0, width, height };
  const aspect = view.sourceCamera.image.width / view.sourceCamera.image.height;
  const w = Math.min(width, height * aspect),
    h = w / aspect;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

function corners(box: Box3): Vector3[] {
  return [box.min.x, box.max.x].flatMap((x) =>
    [box.min.y, box.max.y].flatMap((y) => [box.min.z, box.max.z].map((z) => new Vector3(x, y, z))),
  );
}

/** Both comparison sides must pass the same union bounds and aspect; never fit each scene separately. */
export function createRoomViewCamera(
  room: RoomDimensions,
  aspect: number,
  input: RoomViewState,
  bounds?: Box3,
  structureBounds?: Box3,
): PerspectiveCamera {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect > 100)
    throw new Error('보기 화면 비율이 올바르지 않아요.');
  const view = normalizeRoomView(input);
  if (view.projection === 'room-eye' && view.eye) {
    if (!validateRoomDimensions(room)) throw new Error('공간 크기가 올바르지 않아요.');
    const eye = clampRoomEye(room, view.eye);
    const tanX = Math.tan((eye.fov * Math.PI) / 360);
    const verticalFov = (2 * Math.atan(tanX / aspect) * 180) / Math.PI;
    const camera = new PerspectiveCamera(
      verticalFov,
      aspect,
      10,
      Math.hypot(room.widthMm, room.heightMm, room.depthMm) * 1.2,
    );
    camera.position.set(...eye.position);
    // Pitch and roll stay 0: vertical edges project as vertical lines.
    camera.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (-eye.yaw * Math.PI) / 180);
    camera.up.set(0, 1, 0);
    // A shift lens: move the frame up/down without tilting the camera.
    if (eye.shift) camera.setViewOffset(aspect * 1000, 1000, 0, -eye.shift * 1000, aspect * 1000, 1000);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return camera;
  }
  if (view.sourceCamera && view.projection === 'source-photo') {
    if (!sourceRoomViewAvailable(room, view))
      throw new Error(
        '사진 시점이 이전 공간 크기를 기준으로 해요. 전체 공간 보기로 확인하거나 새 시점을 채택해 주세요.',
      );
    const source = view.sourceCamera,
      camera = createSourceCamera(source);
    // Keep the adopted camera byte-for-byte at the original view; orbit only after an actual turn.
    if (view.quaternion.some((value, index) => value !== (index === 3 ? 1 : 0))) {
      const q0 = camera.quaternion.clone(),
        q = q0
          .clone()
          .multiply(new Quaternion(...view.quaternion))
          .normalize();
      const orbit = q.clone().multiply(q0.clone().invert());
      const pivot = new Vector3(0, room.heightMm / 2, room.depthMm / 2);
      camera.position.sub(pivot).applyQuaternion(orbit).add(pivot);
      camera.quaternion.copy(q);
    }
    camera.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.zoom = view.zoom;
    // Principal-point pan is an image-space move. It does not introduce depth-dependent parallax.
    if (view.pan.x || view.pan.y)
      camera.setViewOffset(
        source.image.width,
        source.image.height,
        -view.pan.x * source.image.width,
        -view.pan.y * source.image.height,
        source.image.width,
        source.image.height,
      );
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return camera;
  }
  const box = roomViewBounds(room, bounds, structureBounds);
  const rotation = new Quaternion(...view.quaternion).normalize();
  const center = new Vector3(0, room.heightMm / 2, room.depthMm / 2);
  const right = new Vector3(1, 0, 0).applyQuaternion(rotation);
  const up = new Vector3(0, 1, 0).applyQuaternion(rotation);
  const backward = new Vector3(0, 0, 1).applyQuaternion(rotation);
  const tanY = Math.tan((FOV * Math.PI) / 360),
    tanX = tanY * aspect;
  const relative = corners(box).map((point) => point.sub(center));
  const distance = Math.max(
    ...relative.flatMap((point) => [
      point.dot(backward) + Math.abs(point.dot(right)) / (tanX * FIT_AVAILABLE),
      point.dot(backward) + Math.abs(point.dot(up)) / (tanY * FIT_AVAILABLE),
    ]),
  );
  const depths = relative.map((point) => distance - point.dot(backward));
  const camera = new PerspectiveCamera(
    FOV,
    aspect,
    Math.max(0.1, Math.min(...depths) * 0.1),
    Math.max(...depths) * 1.2,
  );
  const target = center
    .clone()
    .addScaledVector(right, (-view.pan.x * 2 * distance * tanX) / view.zoom)
    .addScaledVector(up, (view.pan.y * 2 * distance * tanY) / view.zoom);
  camera.position.copy(target).addScaledVector(backward, distance);
  camera.quaternion.copy(rotation);
  camera.up.copy(up);
  camera.zoom = view.zoom;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}
