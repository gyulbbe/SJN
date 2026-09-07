import { describe, expect, it } from 'vitest';
import { BASE_ROOM_IMAGE, createBaseRoomSurfaces } from '../src/lib/base-room';
import { homography, inverseHomography, transformPoint, validateQuad } from '../src/lib/render/math';
import { maskContains } from '../src/lib/render/mask';
import { DEFAULT_COLOR, DEFAULT_TILE } from '../src/lib/types';

const photoPoint = (x: number, y: number) => ({ x: x / 1536, y: y / 1024 });

describe('user-editable base room', () => {
  it('starts with four valid independent planes and no applied material', () => {
    expect(BASE_ROOM_IMAGE).toBe('/backgrounds/empty-room.png');
    const surfaces = createBaseRoomSurfaces();
    expect(surfaces.filter((surface) => surface.kind === 'wall')).toHaveLength(3);
    expect(surfaces.filter((surface) => surface.kind === 'floor')).toHaveLength(1);
    expect(new Set(surfaces.map((surface) => surface.id)).size).toBe(4);
    for (const surface of surfaces) {
      expect(surface.materialVersionId).toBeUndefined();
      expect(surface.calibrated).toBe(false);
      expect(surface.widthMm).toBeGreaterThan(0);
      expect(surface.heightMm).toBeGreaterThan(0);
      expect(validateQuad(surface.quad)).toBe(true);
      for (const point of [...surface.mask.polygon, ...surface.quad]) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
      const transform = homography(surface.quad);
      const inverse = inverseHomography(transform);
      for (const point of surface.mask.polygon) {
        const restored = transformPoint(inverse, transformPoint(transform, point));
        expect(restored.x).toBeCloseTo(point.x, 8);
        expect(restored.y).toBeCloseTo(point.y, 8);
      }
    }
  });

  it('covers the floor to the photo edge and keeps walls, ceiling, and floor separate', () => {
    const surfaces = createBaseRoomSurfaces();
    const containing = (x: number, y: number) =>
      surfaces.filter((surface) => maskContains(surface.mask, photoPoint(x, y)));
    for (const [x, y, kind] of [
      [10, 500, 'wall'],
      [1530, 500, 'wall'],
      [700, 400, 'wall'],
      [700, 720, 'floor'],
      [10, 900, 'floor'],
      [1530, 900, 'floor'],
      [768, 1023, 'floor'],
    ] as const) {
      expect(containing(x, y).map((surface) => surface.kind)).toEqual([kind]);
    }
    for (const [x, y] of [
      [768, 30],
      [250, 20],
      [1280, 20],
    ])
      expect(containing(x, y)).toEqual([]);
    // A scan across the entire photo catches overlap seams and missing foreground coverage.
    for (let y = 4.5; y < 1024; y += 17)
      for (let x = 3.5; x < 1536; x += 17) {
        const count = containing(x, y).length;
        expect(count, `overlap at ${x}, ${y}`).toBeLessThanOrEqual(1);
        if (y > 878) expect(count, `floor gap at ${x}, ${y}`).toBe(1);
      }
  });

  it('keeps edits local to one surface and to one project', () => {
    const first = createBaseRoomSurfaces();
    const untouched = structuredClone(first);
    const second = createBaseRoomSurfaces();
    expect(first.map((surface) => surface.id).some((id) => second.some((surface) => surface.id === id))).toBe(
      false,
    );
    first[0].mask.polygon[0].x = 0.123;
    first[0].mask.strokes.push({ points: [{ x: 0.5, y: 0.8 }], radius: 0.02, erase: true });
    first[0].quad[0].y = 0.456;
    first[0].tile.groutWidth = 22;
    first[0].color.exposure = 2;
    expect(first.slice(1)).toEqual(untouched.slice(1));
    expect(first[0].quad[0].x).toBe(untouched[0].quad[0].x);
    expect(first[0].mask.polygon[0].y).toBe(untouched[0].mask.polygon[0].y);
    second.forEach((surface, index) =>
      expect({ ...surface, id: untouched[index].id }).toEqual(untouched[index]),
    );
    expect(DEFAULT_COLOR.exposure).toBe(0);
    expect(DEFAULT_TILE.groutWidth).toBe(2);
  });
});
