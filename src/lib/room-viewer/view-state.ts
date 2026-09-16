import { Box3, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { validateRoomDimensions } from '../room-geometry';
import { WALL_FEATURE_MAX_DEPTH_MM } from '../wall-features';
import type { RoomDimensions } from '../room-types';
import { createSourceCamera, type SourceCamera } from '../reconstruction/source-camera';

/** A preserved estimated/user photo camera in the same millimetre world coordinates as the room. */
export type RoomSourceCamera = SourceCamera & { referenceRoom: RoomDimensions; source: 'estimated' | 'user' };
/** A shared camera rig, not an edit to any wall, product or design. Pan uses viewport fractions. */
export type RoomViewState = {
  version: 1;
  sourceCamera?: RoomSourceCamera;
  projection?: 'source-photo' | 'room-fit';
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
  const view = normalizeRoomView(input);
  if (!view.sourceCamera) return defaultRoomView();
  return {
    ...view,
    quaternion: [0, 0, 0, 1],
    zoom: 1,
    pan: { x: 0, y: 0 },
    projection: mode ?? view.projection ?? 'source-photo',
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
  };
}

/** At the initial front (+Z), up goes to +Y, right to +X. Axes remain screen-local thereafter. */
export function rotateRoomView(input: RoomViewState, direction: RoomViewDirection): RoomViewState {
  const view = normalizeRoomView(input);
  const axis = direction === 'left' || direction === 'right' ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const rotation = new Quaternion().setFromAxisAngle(axis, (sign * Math.PI) / 2);
  // Post multiplication rotates about the current screen axes, including when the camera is upside down.
  view.quaternion = canonicalQuaternion(new Quaternion(...view.quaternion).multiply(rotation));
  return view;
}

export function roomViewLabel(input: RoomViewState): string {
  const view = normalizeRoomView(input);
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
