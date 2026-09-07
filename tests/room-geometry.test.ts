import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  createRoomCamera,
  createRoomSurfaces,
  DEFAULT_ROOM,
  projectRoomPoint,
  roomFaceAreaM2,
  roomFacePoint,
  validateRoomDimensions,
} from '../src/lib/room-geometry';
import {
  homography,
  inverseHomography,
  tileAtPoint,
  transformPoint,
  validateQuad,
} from '../src/lib/render/math';
import { maskContains } from '../src/lib/render/mask';
import type { RoomDimensions, RoomFace } from '../src/lib/room-types';

const faces: RoomFace[] = ['floor', 'left', 'back', 'right'];
const extremes: RoomDimensions[] = [DEFAULT_ROOM];
for (const widthMm of [500, 20000])
  for (const depthMm of [500, 20000])
    for (const heightMm of [1000, 6000]) extremes.push({ widthMm, depthMm, heightMm });

function expectSamePoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  expect(a.x).toBeCloseTo(b.x, 12);
  expect(a.y).toBeCloseTo(b.y, 12);
}

describe('parametric room geometry', () => {
  it('defaults to an editable 2.4 m cube and validates each independent dimension', () => {
    expect(DEFAULT_ROOM).toEqual({
      kind: 'parametric',
      version: 1,
      widthMm: 2400,
      depthMm: 2400,
      heightMm: 2400,
    });
    for (const room of extremes) expect(validateRoomDimensions(room)).toBe(true);
    for (const field of ['widthMm', 'depthMm', 'heightMm'] as const) {
      for (const value of [NaN, Infinity, -1, 0, 20001])
        expect(validateRoomDimensions({ ...DEFAULT_ROOM, [field]: value })).toBe(false);
    }
    expect(validateRoomDimensions({ ...DEFAULT_ROOM, widthMm: 499 })).toBe(false);
    expect(validateRoomDimensions({ ...DEFAULT_ROOM, depthMm: 499 })).toBe(false);
    expect(validateRoomDimensions({ ...DEFAULT_ROOM, heightMm: 999 })).toBe(false);
    expect(validateRoomDimensions({ ...DEFAULT_ROOM, heightMm: 6001 })).toBe(false);
    expect(() => createRoomSurfaces({ ...DEFAULT_ROOM, widthMm: 0 })).toThrow('공간');
    expect(() => createRoomCamera(DEFAULT_ROOM, 0)).toThrow('비율');
  });

  it('keeps verticals upright and frames the front opening with a six percent margin', () => {
    for (const room of extremes)
      for (const aspect of [1, 1.5, 2]) {
        const camera = createRoomCamera(room, aspect);
        expect(camera.position.y).toBe(room.heightMm * 0.55);
        expect(camera.position.z).toBeGreaterThan(room.depthMm);
        const direction = camera.getWorldDirection(new Vector3());
        expect(direction.x).toBeCloseTo(0, 12);
        expect(direction.y).toBeCloseTo(0, 12);
        expect(direction.z).toBeCloseTo(-1, 12);
        const surfaces = createRoomSurfaces(room, aspect);
        for (const surface of surfaces) {
          expect(validateQuad(surface.quad), JSON.stringify({ room, face: surface.roomFace })).toBe(true);
          for (const point of surface.quad) {
            expect(point.x).toBeGreaterThanOrEqual(0.06 - 1e-12);
            expect(point.x).toBeLessThanOrEqual(0.94 + 1e-12);
            expect(point.y).toBeGreaterThanOrEqual(0.06 - 1e-12);
            expect(point.y).toBeLessThanOrEqual(0.94 + 1e-12);
          }
          if (surface.kind === 'wall') {
            expect(surface.quad[0].x).toBeCloseTo(surface.quad[3].x, 12);
            expect(surface.quad[1].x).toBeCloseTo(surface.quad[2].x, 12);
          }
        }
      }
  });

  it('shares exact plane edges without overlapping masks or uncovered floor strips at all bounds', () => {
    for (const room of extremes) {
      const [floor, left, back, right] = createRoomSurfaces(room);
      expectSamePoint(floor.quad[0], left.quad[2]);
      expectSamePoint(floor.quad[0], back.quad[3]);
      expectSamePoint(floor.quad[1], back.quad[2]);
      expectSamePoint(floor.quad[1], right.quad[3]);
      expectSamePoint(floor.quad[2], right.quad[2]);
      expectSamePoint(floor.quad[3], left.quad[3]);
      expectSamePoint(back.quad[0], left.quad[1]);
      expectSamePoint(back.quad[1], right.quad[0]);
      const surfaces = [floor, left, back, right];
      for (const surface of surfaces) {
        expect(surface.mask.polygon).toEqual(surface.quad);
        expect(surface.mask.polygon).not.toBe(surface.quad);
        for (const u of [0.0001, 0.05, 0.5, 0.95, 0.9999])
          for (const v of [0.0001, 0.05, 0.5, 0.95, 0.9999]) {
            const point = projectRoomPoint(room, roomFacePoint(room, surface.roomFace!, u, v));
            const containing = surfaces.filter((candidate) => maskContains(candidate.mask, point));
            expect(containing.map((candidate) => candidate.roomFace)).toEqual([surface.roomFace]);
          }
      }
    }
  });

  it('maps projected texture coordinates to complete measured planes, including extreme narrow rooms', () => {
    for (const room of extremes)
      for (const surface of createRoomSurfaces(room)) {
        const forward = homography(surface.quad);
        const inverse = inverseHomography(forward);
        for (const [u, v] of [
          [0, 0],
          [1, 1],
          [0.17, 0.69],
          [0.88, 0.31],
        ]) {
          const projected = projectRoomPoint(room, roomFacePoint(room, surface.roomFace!, u, v));
          const plane = transformPoint(forward, projected);
          expect(plane.x).toBeCloseTo(u, 8);
          expect(plane.y).toBeCloseTo(v, 8);
          const restored = transformPoint(inverse, plane);
          expect(restored.x).toBeCloseTo(projected.x, 8);
          expect(restored.y).toBeCloseTo(projected.y, 8);
        }
        expect((surface.widthMm * surface.heightMm) / 1e6).toBe(roomFaceAreaM2(room, surface.roomFace!));
        expect(surface.geometryMode).toBe('room');
        expect(surface.calibrated).toBe(false);
        expect(surface.materialVersionId).toBeUndefined();
      }
  });

  it('uses physical tile dimensions so changing room width changes repeat counts and visible size', () => {
    const regular = createRoomSurfaces(DEFAULT_ROOM)[0];
    const widerRoom = { ...DEFAULT_ROOM, widthMm: 3600 };
    const wide = createRoomSurfaces(widerRoom)[0];
    expect(roomFaceAreaM2(DEFAULT_ROOM, 'floor')).toBe(5.76);
    expect(roomFaceAreaM2(widerRoom, 'floor')).toBe(8.64);
    const lastTile = (surface: typeof regular) =>
      tileAtPoint(
        { x: 0.99999, y: 0.99999 },
        { width: surface.widthMm, height: surface.heightMm },
        { width: 600, height: 600 },
        { ...surface.tile, groutWidth: 0 },
      );
    expect(lastTile(regular)).toMatchObject({ column: 3, row: 3 });
    expect(lastTile(wide)).toMatchObject({ column: 5, row: 3 });
    const bigger = tileAtPoint(
      { x: 0.99999, y: 0.99999 },
      { width: regular.widthMm, height: regular.heightMm },
      { width: 1200, height: 1200 },
      { ...regular.tile, groutWidth: 0 },
    );
    expect(bigger).toMatchObject({ column: 1, row: 1 });
    const displayedWidth = (z: number) =>
      projectRoomPoint(DEFAULT_ROOM, new Vector3(300, 0, z)).x -
      projectRoomPoint(DEFAULT_ROOM, new Vector3(-300, 0, z)).x;
    expect(displayedWidth(DEFAULT_ROOM.depthMm)).toBeGreaterThan(displayedWidth(0));
  });

  it('keeps independently generated surfaces and controls isolated', () => {
    const first = createRoomSurfaces(DEFAULT_ROOM),
      second = createRoomSurfaces(DEFAULT_ROOM);
    expect(new Set([...first, ...second].map((surface) => surface.id)).size).toBe(8);
    expect(first.map((surface) => surface.roomFace)).toEqual(faces);
    const originalPoint = first[0].quad[0].x;
    first[0].mask.polygon[0].x = 0;
    first[0].tile.rotation = 77;
    expect(first[0].quad[0].x).toBe(originalPoint);
    expect(first[1].tile.rotation).toBe(0);
    expect(second[0].tile.rotation).toBe(0);
  });
});
