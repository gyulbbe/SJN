import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  clampRoomEye,
  createRoomViewCamera,
  defaultRoomView,
  moveRoomEye,
  normalizeRoomView,
  resetRoomView,
  ROOM_EYE_FOV,
  ROOM_EYE_WALL_MARGIN_MM,
  roomEyeView,
  roomEyeYawLimit,
  roomViewLabel,
  rotateRoomView,
  zoomRoomEye,
  type RoomEyePreset,
  type RoomViewState,
} from '../src/lib/room-viewer/view-state';
import { roomViewSchema } from '../src/lib/storage/validation';
import { buildViewerCeiling } from '../src/lib/room-viewer/ceiling';

const room = { widthMm: 2400, depthMm: 3000, heightMm: 2400 };
const presets: RoomEyePreset[] = ['center', 'left-corner', 'right-corner'];
const eyeView = (patch: Partial<NonNullable<RoomViewState['eye']>> = {}): RoomViewState => ({
  ...defaultRoomView(),
  projection: 'room-eye',
  eye: { position: [0, 1500, 2850], yaw: 0, shift: 0, fov: ROOM_EYE_FOV, ...patch },
});
/** Screen position of a world point, or undefined when it is behind the camera. */
function project(view: RoomViewState, point: Vector3, aspect = 1.5) {
  const camera = createRoomViewCamera(room, aspect, view);
  const local = point.clone().applyMatrix4(camera.matrixWorldInverse);
  if (local.z >= 0) return undefined;
  return point.clone().project(camera);
}

describe('stored in-room eye views', () => {
  it('accepts the new view and every older view shape', () => {
    expect(roomViewSchema.safeParse(defaultRoomView()).success).toBe(true);
    expect(roomViewSchema.safeParse({ ...defaultRoomView(), projection: 'room-fit' }).success).toBe(true);
    expect(roomViewSchema.safeParse(eyeView()).success).toBe(true);
    expect(roomViewSchema.safeParse({ ...defaultRoomView(), projection: 'room-eye' }).success).toBe(false);
    expect(roomViewSchema.safeParse({ ...defaultRoomView(), eye: eyeView().eye }).success).toBe(false);
    expect(roomViewSchema.safeParse(eyeView({ fov: 150 })).success).toBe(false);
    expect(roomViewSchema.safeParse({ ...eyeView(), eye: { ...eyeView().eye, extra: 1 } }).success).toBe(
      false,
    );
  });

  it('keeps a valid eye through normalisation and drops a broken one', () => {
    const view = eyeView({ yaw: 20, shift: 0.1 });
    expect(normalizeRoomView(view)).toEqual(view);
    expect(normalizeRoomView(normalizeRoomView(view))).toEqual(normalizeRoomView(view));
    const broken = normalizeRoomView({ ...view, eye: { ...view.eye!, position: [0, Number.NaN, 0] } });
    expect(broken.projection).toBeUndefined();
    expect(broken.eye).toBeUndefined();
    // An orbit view never carries an eye.
    expect(
      normalizeRoomView({ ...defaultRoomView(), projection: 'room-fit', eye: view.eye }).eye,
    ).toBeUndefined();
    expect(normalizeRoomView(undefined)).toEqual(defaultRoomView());
  });
});

describe('in-room eye camera', () => {
  it('keeps vertical edges vertical, with and without a lens shift', () => {
    for (const view of [eyeView({ yaw: 25 }), eyeView({ yaw: -30, shift: 0.2 })])
      for (const x of [-1200, 0, 900]) {
        const top = project(view, new Vector3(x, 2400, 0))!;
        const bottom = project(view, new Vector3(x, 0, 0))!;
        expect(Math.abs(top.x - bottom.x)).toBeLessThan(1e-9);
      }
  });

  it('never frames the open front from any preset or turned to its limit', () => {
    for (const fov of [60, ROOM_EYE_FOV, 90])
      for (const preset of presets) {
        const base = roomEyeView(room, preset);
        const limit = roomEyeYawLimit(fov);
        for (const yaw of [-limit, 0, limit, 179]) {
          const view = { ...base, eye: { ...base.eye!, fov, yaw } };
          for (let i = 0; i <= 12; i++)
            for (let j = 0; j <= 12; j++) {
              const point = new Vector3(-1200 + (2400 * i) / 12, (2400 * j) / 12, room.depthMm);
              const screen = project(view, point, 1.5);
              const inFrame = !!screen && Math.abs(screen.x) <= 1 && Math.abs(screen.y) <= 1;
              expect(inFrame, `${preset} fov ${fov} yaw ${yaw} sees the front at ${point.toArray()}`).toBe(
                false,
              );
            }
        }
      }
  });

  it('stays inside the room away from the walls', () => {
    const eye = clampRoomEye(room, { position: [9000, -50, -400], yaw: 170, shift: 2, fov: 10 });
    expect(eye.position).toEqual([1200 - ROOM_EYE_WALL_MARGIN_MM, 300, ROOM_EYE_WALL_MARGIN_MM]);
    expect(eye.fov).toBe(60);
    expect(eye.yaw).toBe(roomEyeYawLimit(60));
    expect(eye.shift).toBe(0.3);
    const camera = createRoomViewCamera(room, 1.5, eyeView({ position: [5000, 5000, 5000] }));
    expect(camera.position.x).toBeLessThanOrEqual(1200 - ROOM_EYE_WALL_MARGIN_MM);
    expect(camera.position.y).toBeLessThanOrEqual(2400 - ROOM_EYE_WALL_MARGIN_MM);
    expect(camera.position.z).toBeLessThanOrEqual(room.depthMm - ROOM_EYE_WALL_MARGIN_MM);
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
  });

  it('offers entrance presets at eye height looking into the room', () => {
    const center = roomEyeView(room, 'center').eye!;
    expect(center.position).toEqual([0, 1500, room.depthMm - ROOM_EYE_WALL_MARGIN_MM]);
    expect(center.yaw).toBe(0);
    const left = roomEyeView(room, 'left-corner').eye!;
    const right = roomEyeView(room, 'right-corner').eye!;
    expect(left.yaw).toBeGreaterThan(0);
    expect(right.yaw).toBeCloseTo(-left.yaw);
    expect(left.position[0]).toBeLessThan(0);
  });
});

describe('in-room controls', () => {
  it('turns in 15° steps, shifts the frame and zooms the lens within limits', () => {
    const view = eyeView();
    expect(rotateRoomView(view, 'right').eye!.yaw).toBe(15);
    expect(rotateRoomView(view, 'left').eye!.yaw).toBe(-15);
    let turned = view;
    for (let i = 0; i < 10; i++) turned = rotateRoomView(turned, 'right');
    expect(turned.eye!.yaw).toBe(roomEyeYawLimit(ROOM_EYE_FOV));
    expect(rotateRoomView(view, 'up').eye!.shift).toBe(0.1);
    expect(zoomRoomEye(view, 10).eye!.fov).toBe(60);
    expect(zoomRoomEye(view, 0.1).eye!.fov).toBe(90);
    expect(roomViewLabel(rotateRoomView(view, 'right'))).toBe('방 안 시점 · 오른쪽 15°');
  });

  it('walks relative to the view and resets to the outside view', () => {
    const view = eyeView({ position: [0, 1500, 1500] });
    expect(moveRoomEye(room, view, 'forward').eye!.position[2]).toBe(1350);
    expect(moveRoomEye(room, view, 'right').eye!.position[0]).toBe(150);
    let walked = view;
    for (let i = 0; i < 30; i++) walked = moveRoomEye(room, walked, 'forward');
    expect(walked.eye!.position[2]).toBe(ROOM_EYE_WALL_MARGIN_MM);
    expect(resetRoomView(view)).toEqual(defaultRoomView());
    expect(moveRoomEye(room, defaultRoomView(), 'forward')).toEqual(defaultRoomView());
  });
});

describe('viewer ceiling', () => {
  it('is hidden until an in-room view shows it and disposes once', () => {
    const ceiling = buildViewerCeiling(room);
    expect(ceiling.group.visible).toBe(false);
    expect(ceiling.group.children.map((child) => child.name)).toEqual([
      'viewer-ceiling:plane',
      'viewer-ceiling:lamp',
    ]);
    // No ids: picking, quotes and fixture boxes ignore it.
    ceiling.group.traverse((node) => expect(node.userData).toEqual({}));
    ceiling.setVisible(true);
    expect(ceiling.group.visible).toBe(true);
    ceiling.dispose();
    ceiling.dispose();
    expect(ceiling.group.children).toHaveLength(0);
  });
});
