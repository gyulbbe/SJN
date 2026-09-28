import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  clampFluxDirection,
  FLUX_EYE_FOV,
  FLUX_EYE_HEIGHT_MM,
  FLUX_FRONT,
  fluxDirectionLimits,
  fluxDirectionOutside,
  fluxEyeView,
  fluxRoom,
  type FluxDirection,
} from '../src/lib/ai-export/view';
import { visibleCeiling, visibleWalls } from '../src/lib/ai-export/scene';
import type { RegionMask } from '../src/lib/ai-export/color';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  createRoomViewCamera,
  defaultRoomView,
  normalizeRoomView,
  roomEyeView,
  validRoomEye,
  type RoomViewState,
} from '../src/lib/room-viewer/view-state';
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

/**
 * An independent look at every pixel (not the sampled border the limit uses): does any pixel ray of
 * a 150 × 100 frame leave the room box through its open front?
 */
function anyPixelSeesOut(dims: RoomDimensions, direction: FluxDirection) {
  const camera = createRoomViewCamera(dims, ASPECT, fluxEyeView(dims, direction));
  const origin = camera.position.clone();
  const point = new Vector3();
  for (let py = 0; py < 100; py++)
    for (let px = 0; px < 150; px++) {
      point.set(((px + 0.5) / 150) * 2 - 1, 1 - ((py + 0.5) / 100) * 2, 0.5).unproject(camera);
      const d = point.sub(origin).normalize();
      const t = (limit: number, from: number, speed: number) =>
        speed === 0 ? Infinity : (limit - from) / speed;
      const walls = Math.min(
        ...[d.x > 0 ? t(dims.widthMm / 2, origin.x, d.x) : t(-dims.widthMm / 2, origin.x, d.x)],
        d.y > 0 ? t(dims.heightMm, origin.y, d.y) : t(0, origin.y, d.y),
        d.z < 0 ? t(0, origin.z, d.z) : Infinity,
      );
      const front = d.z > 0 ? t(dims.depthMm, origin.z, d.z) : Infinity;
      if (front < walls) return true;
    }
  return false;
}
/** A seeded sequence, so the "random" directions are the same every run. */
function sequence(seed: number) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
}
const rooms: [string, RoomDimensions][] = [
  ['the default 2.4 m room', { widthMm: 2400, depthMm: 2400, heightMm: 2400 }],
  ['a narrow, long room', { widthMm: 1200, depthMm: 3200, heightMm: 2400 }],
  ['a wide, shallow room', { widthMm: 3600, depthMm: 1700, heightMm: 2600 }],
];

describe('AI input camera', () => {
  it('stands at the middle of the open front at 1.2 m with a fixed 90° lens, turned and tilted', () => {
    const view = fluxEyeView(room, { yaw: 12, pitch: -7 });
    expect(view.projection).toBe('room-eye');
    expect(view.eye).toEqual({
      position: [0, FLUX_EYE_HEIGHT_MM, room.depthMm - 150],
      yaw: 12,
      shift: 0,
      fov: FLUX_EYE_FOV,
      pitch: -7,
    });
    // Below a low ceiling.
    expect(fluxEyeView({ ...room, heightMm: 1000 }, FLUX_FRONT).eye!.position[1]).toBe(850);
  });

  it('tilts for real: looking up raises the frame, the vertical of the room still projects from the camera', () => {
    const level = createRoomViewCamera(room, ASPECT, fluxEyeView(room, FLUX_FRONT));
    const up = createRoomViewCamera(room, ASPECT, fluxEyeView(room, { yaw: 0, pitch: 20 }));
    const target = new Vector3(0, FLUX_EYE_HEIGHT_MM, 0);
    // The back wall at eye height is centred when level and lower in the frame when looking up.
    expect(target.clone().project(level).y).toBeCloseTo(0, 6);
    expect(target.clone().project(up).y).toBeLessThan(-0.3);
    // Looking up 20° is the same as the point sitting 20° below the view axis.
    const axis = new Vector3(0, 0, -1).applyQuaternion(up.quaternion);
    expect((Math.asin(axis.y) * 180) / Math.PI).toBeCloseTo(20, 6);
  });

  it('draws every scene with room dimensions in the room; legacy photo-only scenes keep the 2D path', () => {
    expect(fluxRoom(scene(), scene())).toEqual(room);
    expect(fluxRoom(scene({ room: undefined }), scene())).toBeUndefined();
    expect(fluxRoom(scene(), scene({ room: { ...room, widthMm: room.widthMm + 100 } }))).toBeUndefined();
  });
});

describe('turning stops where the open front would come into view', () => {
  it.each(rooms)('keeps every pixel inside, at the limits and at random directions: %s', (_label, dims) => {
    const limits = fluxDirectionLimits(dims, ASPECT);
    for (const direction of [
      FLUX_FRONT,
      { yaw: limits.left, pitch: 0 },
      { yaw: limits.right, pitch: 0 },
      { yaw: 0, pitch: limits.up },
      { yaw: 0, pitch: limits.down },
    ]) {
      expect(fluxDirectionOutside(dims, ASPECT, direction)).toBe(0);
      expect(anyPixelSeesOut(dims, direction)).toBe(false);
    }
    // Just past each limit, the frame would see out: the limits are tight.
    expect(fluxDirectionOutside(dims, ASPECT, { yaw: limits.right + 0.5, pitch: 0 })).toBeGreaterThan(0);
    expect(fluxDirectionOutside(dims, ASPECT, { yaw: 0, pitch: limits.down - 0.5 })).toBeGreaterThan(0);
    const random = sequence(20260928);
    for (let i = 0; i < 40; i++) {
      const wish = { yaw: (random() - 0.5) * 180, pitch: (random() - 0.5) * 160 };
      const { direction } = clampFluxDirection(dims, ASPECT, FLUX_FRONT, wish);
      expect(fluxDirectionOutside(dims, ASPECT, direction)).toBe(0);
      expect(anyPixelSeesOut(dims, direction)).toBe(false);
    }
  });

  it('cuts a direction past the limit back to the limit, the same way every time', () => {
    const limits = fluxDirectionLimits(room, ASPECT);
    const once = clampFluxDirection(room, ASPECT, FLUX_FRONT, { yaw: 80, pitch: 0 });
    expect(once.blocked).toBe(true);
    expect(once.direction).toEqual({ yaw: limits.right, pitch: 0 });
    // Pushing again from the limit stays put: no jitter.
    expect(clampFluxDirection(room, ASPECT, once.direction, { yaw: 85, pitch: 0 }).direction).toEqual(
      once.direction,
    );
    // A slanted push past the up limit slides along it: the turn still follows, the tilt stops.
    const slide = clampFluxDirection(room, ASPECT, FLUX_FRONT, { yaw: 20, pitch: 80 });
    expect(slide.blocked).toBe(true);
    expect(slide.direction.yaw).toBe(20);
    expect(slide.direction.pitch).toBeGreaterThan(20);
    expect(fluxDirectionOutside(room, ASPECT, slide.direction)).toBe(0);
    // At the side limit, tilting would widen the frame's corners past the front: it stays put.
    expect(clampFluxDirection(room, ASPECT, once.direction, { yaw: 85, pitch: 10 }).direction).toEqual(
      once.direction,
    );
    // Inside the range nothing is cut.
    expect(clampFluxDirection(room, ASPECT, FLUX_FRONT, { yaw: 10, pitch: -5 })).toEqual({
      direction: { yaw: 10, pitch: -5 },
      blocked: false,
    });
  });

  it('reports the default room range (recorded in docs/flux-export.md)', () => {
    const limits = fluxDirectionLimits(room, ASPECT);
    expect(limits.left).toBeCloseTo(-limits.right, 1);
    expect(limits.right).toBeGreaterThan(30);
    expect(limits.up).toBeGreaterThan(20);
    expect(limits.down).toBeLessThan(-20);
    console.info('default room limits', limits);
  });
});

describe('saved views are read as before', () => {
  it('never adds a tilt to a saved view and rejects a bad one', () => {
    const orbit = defaultRoomView();
    expect(normalizeRoomView(orbit)).toEqual(orbit);
    const saved: RoomViewState = roomEyeView(room, 'left-corner');
    const normalised = normalizeRoomView(saved);
    expect(normalised).toEqual(saved);
    expect('pitch' in normalised.eye!).toBe(false);
    // The space viewer's yaw limit still applies to an untilted eye.
    expect(createRoomViewCamera(room, ASPECT, { ...saved, eye: { ...saved.eye!, yaw: 80 } })).toBeDefined();
    expect(validRoomEye({ ...saved.eye!, pitch: 10 })).toBe(true);
    expect(validRoomEye({ ...saved.eye!, pitch: 95 })).toBe(false);
    expect(validRoomEye({ ...saved.eye!, pitch: Number.NaN })).toBe(false);
    // A tilted AI view keeps its tilt through normalisation.
    expect(normalizeRoomView(fluxEyeView(room, { yaw: 5, pitch: 12 })).eye!.pitch).toBe(12);
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

  it('names the ceiling only when at least 1% of an in-room capture is left unlabelled', () => {
    const mask = (unlabelled: number): RegionMask => {
      const data = new Uint8Array(1000).fill(1);
      data.fill(0, 0, unlabelled);
      return { width: 100, height: 10, data, regions: [{ key: 'face:back', kind: 'wall' }] };
    };
    expect(visibleCeiling(mask(9))).toBe(false);
    expect(visibleCeiling(mask(10))).toBe(true);
  });
});
