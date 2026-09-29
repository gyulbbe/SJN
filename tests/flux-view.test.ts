import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  clampFluxOrbit,
  FLUX_FRONT,
  fluxOrbitLabel,
  fluxOrbitView,
  fluxRoom,
  turnFluxOrbit,
} from '../src/lib/ai-export/view';
import { visibleCeiling, visibleWalls } from '../src/lib/ai-export/scene';
import type { RegionMask } from '../src/lib/ai-export/color';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { viewerFaceIsVisible } from '../src/lib/room-viewer/surfaces';
import {
  createRoomViewCamera,
  defaultRoomView,
  normalizeRoomView,
  roomEyeView,
  validRoomOrbit,
  type RoomOrbit,
  type RoomViewState,
} from '../src/lib/room-viewer/view-state';
import { roomViewSchema } from '../src/lib/storage/validation';
import type { RoomDimensions } from '../src/lib/room-types';
import type { Scene } from '../src/lib/types';

const room = structuredClone(DEFAULT_ROOM);
const ASPECT = 4096 / 2731;
const scene = (patch: Partial<Scene> = {}): Scene => ({
  room: structuredClone(room),
  originalAssetId: 'bg',
  previewAssetId: 'bg',
  imageWidth: 4096,
  imageHeight: 2731,
  surfaces: [],
  protection: { polygon: [], strokes: [] },
  fixtures: [],
  color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
  ...patch,
});
const camera = (orbit: RoomOrbit, dims: RoomDimensions = room) =>
  createRoomViewCamera(dims, ASPECT, fluxOrbitView(orbit));
const corners = (dims: RoomDimensions) =>
  [-dims.widthMm / 2, dims.widthMm / 2].flatMap((x) =>
    [0, dims.heightMm].flatMap((y) => [0, dims.depthMm].map((z) => new Vector3(x, y, z))),
  );
const rooms: [string, RoomDimensions][] = [
  ['the default 2.4 m room', { widthMm: 2400, depthMm: 2400, heightMm: 2400 }],
  ['a narrow, long room', { widthMm: 1200, depthMm: 3200, heightMm: 2400 }],
  ['a wide, shallow room', { widthMm: 3600, depthMm: 1700, heightMm: 2600 }],
];
const directions: RoomOrbit[] = [
  { azimuth: 0, elevation: 0 },
  { azimuth: 90, elevation: 0 },
  { azimuth: 180, elevation: 0 },
  { azimuth: -90, elevation: 0 },
  { azimuth: 0, elevation: 90 },
  { azimuth: 90, elevation: 90 },
  { azimuth: 45, elevation: 30 },
  { azimuth: -135, elevation: 60 },
];

describe('the AI orbit camera', () => {
  it.each(directions)('has no roll and screen-up is the room up: %o', (orbit) => {
    const c = camera(orbit);
    const right = new Vector3(1, 0, 0).applyQuaternion(c.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(c.quaternion);
    const forward = new Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    // The screen's horizontal stays level; its up never points down (not upside down).
    expect(right.y).toBeCloseTo(0, 9);
    expect(up.y).toBeGreaterThanOrEqual(-1e-9);
    // It looks down by exactly the elevation.
    expect((Math.asin(-forward.y) * 180) / Math.PI).toBeCloseTo(orbit.elevation, 6);
    // The room's vertical edge projects upright (top above bottom) whenever it is not end-on.
    if (orbit.elevation < 90) {
      const bottom = new Vector3(-room.widthMm / 2, 0, 0).project(c);
      const top = new Vector3(-room.widthMm / 2, room.heightMm, 0).project(c);
      expect(top.y).toBeGreaterThan(bottom.y);
    }
  });

  it('stands on the side the azimuth names, outside the room, and above it at 90°', () => {
    const at = (orbit: RoomOrbit) => camera(orbit).position;
    expect(at({ azimuth: 0, elevation: 0 }).z).toBeGreaterThan(room.depthMm);
    expect(at({ azimuth: 90, elevation: 0 }).x).toBeGreaterThan(room.widthMm / 2);
    expect(at({ azimuth: 180, elevation: 0 }).z).toBeLessThan(0);
    expect(at({ azimuth: -90, elevation: 0 }).x).toBeLessThan(-room.widthMm / 2);
    const top = at({ azimuth: 0, elevation: 90 });
    expect(top.y).toBeGreaterThan(room.heightMm);
    expect(top.x).toBeCloseTo(0, 6);
    expect(top.z).toBeCloseTo(room.depthMm / 2, 6);
  });

  it('from straight above, the room front is at the bottom of the frame (and the named side when turned)', () => {
    const front = new Vector3(0, 0, room.depthMm),
      back = new Vector3(0, 0, 0),
      rightWall = new Vector3(room.widthMm / 2, 0, room.depthMm / 2),
      leftWall = new Vector3(-room.widthMm / 2, 0, room.depthMm / 2);
    const top = camera({ azimuth: 0, elevation: 90 });
    expect(front.clone().project(top).y).toBeLessThan(back.clone().project(top).y);
    expect(rightWall.clone().project(top).x).toBeGreaterThan(leftWall.clone().project(top).x);
    const turned = camera({ azimuth: 90, elevation: 90 });
    expect(rightWall.clone().project(turned).y).toBeLessThan(leftWall.clone().project(turned).y);
  });

  it.each(rooms)('fits the room outline tightly and centred: %s', (_label, dims) => {
    for (const orbit of directions) {
      const c = camera(orbit, dims);
      const projected = corners(dims).map((point) => point.project(c));
      const xs = projected.map((p) => p.x),
        ys = projected.map((p) => p.y);
      // Every corner in frame (in front of the camera too), none past 97% of the half-size.
      for (const p of projected) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(0.97 + 1e-6);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(0.97 + 1e-6);
        expect(p.z).toBeLessThan(1);
        expect(p.z).toBeGreaterThan(-1);
      }
      // Centred, and one side of the frame is filled.
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 6);
      expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(0, 6);
      expect(Math.max(Math.max(...xs), Math.max(...ys))).toBeCloseTo(0.97, 6);
    }
  });

  it('cuts away the walls facing the camera and keeps the others, as the space viewer does', () => {
    const shown = (orbit: RoomOrbit) =>
      (['floor', 'back', 'left', 'right'] as const).filter((face) =>
        viewerFaceIsVisible(room, face, camera(orbit).position),
      );
    expect(shown({ azimuth: 0, elevation: 0 })).toEqual(['floor', 'back', 'left', 'right']);
    expect(shown({ azimuth: 90, elevation: 0 })).toEqual(['floor', 'back', 'left']);
    expect(shown({ azimuth: 180, elevation: 0 })).toEqual(['floor', 'left', 'right']);
    expect(shown({ azimuth: -90, elevation: 0 })).toEqual(['floor', 'back', 'right']);
    expect(shown({ azimuth: 45, elevation: 30 })).toEqual(['floor', 'back', 'left']);
    // From above every wall stands around the floor; the ceiling is never drawn for an orbit view.
    expect(shown({ azimuth: 0, elevation: 90 })).toEqual(['floor', 'back', 'left', 'right']);
    expect(fluxOrbitView({ azimuth: 0, elevation: 90 }).projection).toBe('room-orbit');
  });
});

describe('turning a quarter at a time', () => {
  it('goes front → right → back → left → front and back again; up is straight down, down is level', () => {
    let orbit = FLUX_FRONT;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      orbit = turnFluxOrbit(orbit, 'right');
      seen.push(`${orbit.azimuth}/${fluxOrbitLabel(orbit)}`);
    }
    expect(seen).toEqual(['90/오른쪽', '180/뒤', '-90/왼쪽', '0/정면']);
    expect(turnFluxOrbit(FLUX_FRONT, 'left')).toEqual({ azimuth: -90, elevation: 0 });
    expect(turnFluxOrbit({ azimuth: -90, elevation: 0 }, 'left')).toEqual({ azimuth: 180, elevation: 0 });
    // From between two quarters, to the next quarter that way.
    expect(turnFluxOrbit({ azimuth: 30, elevation: 20 }, 'right')).toEqual({ azimuth: 90, elevation: 20 });
    expect(turnFluxOrbit({ azimuth: 30, elevation: 20 }, 'left')).toEqual({ azimuth: 0, elevation: 20 });
    expect(turnFluxOrbit({ azimuth: 90, elevation: 0 }, 'top')).toEqual({ azimuth: 90, elevation: 90 });
    expect(turnFluxOrbit({ azimuth: 90, elevation: 90 }, 'side')).toEqual({ azimuth: 90, elevation: 0 });
    expect(turnFluxOrbit({ azimuth: 135, elevation: 45 }, 'front')).toEqual({ azimuth: 0, elevation: 0 });
  });

  it('never looks from below the floor and wraps the heading', () => {
    expect(clampFluxOrbit({ azimuth: 0, elevation: -30 })).toEqual({ azimuth: 0, elevation: 0 });
    expect(clampFluxOrbit({ azimuth: 0, elevation: 120 })).toEqual({ azimuth: 0, elevation: 90 });
    expect(clampFluxOrbit({ azimuth: 270, elevation: 0 })).toEqual({ azimuth: -90, elevation: 0 });
    expect(clampFluxOrbit({ azimuth: -180, elevation: 0 })).toEqual({ azimuth: 180, elevation: 0 });
    expect(clampFluxOrbit({ azimuth: 725.123, elevation: 12.345 })).toEqual({
      azimuth: 5.12,
      elevation: 12.35,
    });
    expect(fluxOrbitView({ azimuth: 10, elevation: -5 }).orbit).toEqual({ azimuth: 10, elevation: 0 });
    expect(validRoomOrbit({ azimuth: 0, elevation: -1 })).toBe(false);
    expect(validRoomOrbit({ azimuth: 0, elevation: 91 })).toBe(false);
    // A view from below cannot sneak in through normalisation either.
    const below = { ...fluxOrbitView(FLUX_FRONT), orbit: { azimuth: 0, elevation: -20 } };
    expect(normalizeRoomView(below).orbit).toBeUndefined();
  });

  it('names the view: quarters by side, in between by side and angle', () => {
    expect(fluxOrbitLabel({ azimuth: 0, elevation: 0 })).toBe('정면');
    expect(fluxOrbitLabel({ azimuth: 0, elevation: 90 })).toBe('위에서');
    expect(fluxOrbitLabel({ azimuth: 90, elevation: 90 })).toBe('위에서 · 오른쪽');
    expect(fluxOrbitLabel({ azimuth: 45, elevation: 30 })).toBe('오른쪽 45° · 위 30°');
    expect(fluxOrbitLabel({ azimuth: -30, elevation: 0 })).toBe('왼쪽 30°');
    expect(fluxOrbitLabel({ azimuth: 0, elevation: 30 })).toBe('정면 · 위 30°');
    expect(fluxOrbitLabel({ azimuth: 179.6, elevation: 0 })).toBe('뒤');
    expect(fluxOrbitLabel({ azimuth: 89.7, elevation: 0.2 })).toBe('오른쪽');
  });
});

describe('scenes and saved views', () => {
  it('draws every scene with room dimensions in the room; legacy photo-only scenes keep the 2D path', () => {
    expect(fluxRoom(scene(), scene())).toEqual(room);
    expect(fluxRoom(scene({ room: undefined }), scene())).toBeUndefined();
    expect(fluxRoom(scene(), scene({ room: { ...room, widthMm: room.widthMm + 100 } }))).toBeUndefined();
  });

  it('reads saved views exactly as before; an AI orbit view can never be saved', () => {
    const orbit = defaultRoomView();
    expect(normalizeRoomView(orbit)).toEqual(orbit);
    const saved: RoomViewState = roomEyeView(room, 'left-corner');
    const normalised = normalizeRoomView(saved);
    expect(normalised).toEqual(saved);
    expect(Object.keys(normalised.eye!).sort()).toEqual(['fov', 'position', 'shift', 'yaw']);
    expect('orbit' in normalised).toBe(false);
    expect(roomViewSchema.safeParse(saved).success).toBe(true);
    expect(roomViewSchema.safeParse(orbit).success).toBe(true);
    // The AI view keeps its orbit through normalisation, and the storage schema refuses it.
    const ai = fluxOrbitView({ azimuth: 45, elevation: 30 });
    expect(normalizeRoomView(ai)).toEqual(ai);
    expect(roomViewSchema.safeParse(ai).success).toBe(false);
  });
});

describe('visible walls and ceiling from the capture mask', () => {
  it('lists the walls covering at least 2% of the mask, left to right, from surfaces and bare faces', () => {
    const width = 100,
      height = 50,
      data = new Uint8Array(width * height);
    data.fill(1, 0, 2000);
    data.fill(2, 2000, 3000);
    data.fill(3, 3000, 3150);
    data.fill(4, 3150, 3200);
    data.fill(255, 3200, 3400);
    const mask: RegionMask = {
      width,
      height,
      data,
      regions: [
        { key: 'surface:back', kind: 'wall' },
        { key: 'surface:floor', kind: 'floor' },
        { key: 'face:left', kind: 'wall' },
        { key: 'surface:right', kind: 'wall' },
      ],
    };
    const surfaces = [
      { id: 'back', roomFace: 'back' },
      { id: 'floor', roomFace: 'floor' },
      { id: 'right', roomFace: 'right' },
    ] as Scene['surfaces'];
    expect(visibleWalls(mask, { surfaces })).toEqual(['left', 'back']);
  });

  it('names the ceiling only when at least 1% of the room pixels are unlabelled; the backdrop is not ceiling', () => {
    const mask = (unlabelled: number, outside = 0): RegionMask => {
      const data = new Uint8Array(1000).fill(1);
      data.fill(0, 0, unlabelled + outside);
      return {
        width: 100,
        height: 10,
        data,
        regions: [{ key: 'face:back', kind: 'wall' }],
        outside: new Uint8Array(1000).fill(1, unlabelled, unlabelled + outside),
      };
    };
    expect(visibleCeiling(mask(9))).toBe(false);
    expect(visibleCeiling(mask(10))).toBe(true);
    // An orbit capture: a wide white backdrop, no ceiling.
    expect(visibleCeiling(mask(0, 400))).toBe(false);
    expect(visibleCeiling(mask(10, 400))).toBe(true);
  });
});
