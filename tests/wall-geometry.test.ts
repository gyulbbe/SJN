import { describe, expect, it } from 'vitest';
import { inferWallGeometry, applyWallGeometry } from '../src/lib/render/wall-geometry';
import { detectSurfaces } from '../src/lib/render/auto-surfaces';
import { homography, transformPoint } from '../src/lib/render/math';
import { maskContains, pointInPolygon } from '../src/lib/render/mask';
import type { Quad } from '../src/lib/types';

function room(flat = false, ceilingVisible = true) {
  const width = 160,
    height = 120;
  const floorQuad: Quad = [
    { x: 0.3, y: 0.7 },
    { x: 0.7, y: 0.7 },
    { x: 0.92, y: 1 },
    { x: 0.08, y: 1 },
  ];
  const wall = new Uint8Array(width * height),
    floor = wall.slice(),
    rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x,
        p = { x: (x + 0.5) / width, y: (y + 0.5) / height };
      const inFloor = pointInPolygon(p, floorQuad),
        ceiling = ceilingVisible && p.y < 0.08;
      const hole = p.x > 0.42 && p.x < 0.56 && p.y > 0.28 && p.y < 0.42;
      floor[i] = inFloor ? 255 : 0;
      wall[i] = !inFloor && !ceiling && !hole ? 255 : 0;
      const value = flat
        ? 180
        : inFloor
          ? 90
          : ceiling
            ? 230
            : hole
              ? 30
              : p.x < 0.3
                ? 125
                : p.x > 0.7
                  ? 155
                  : 205;
      rgba.set([value, value, value, 255], i * 4);
    }
  return { width, height, wall, floor, rgba, floorQuad };
}

describe('wall corner evidence and separate texture planes', () => {
  it('separates three walls with two RGB corners anchored by observed floor junctions', () => {
    const input = room(),
      original = input.wall.slice(),
      result = inferWallGeometry(input);
    expect(result.wallSeams).toHaveLength(2);
    expect(result.planes).toHaveLength(3);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.wallSeams[0].bottom.x).toBeCloseTo(0.3, 2);
    expect(result.wallSeams[1].bottom.x).toBeCloseTo(0.7, 2);
    expect(input.wall).toEqual(original);
    const surfaces = detectSurfaces({
      width: input.width,
      height: input.height,
      wallMask: input.wall,
      floorMask: input.floor,
      wallSeams: result.wallSeams,
    }).surfaces;
    const mapped = applyWallGeometry(surfaces, result),
      walls = mapped.filter((surface) => surface.kind === 'wall');
    expect(walls).toHaveLength(3);
    expect(new Set(walls.map((wall) => wall.name)).size).toBe(3);
    expect(walls.every((surface) => !surface.calibrated)).toBe(true);
    for (let i = 0; i < input.wall.length; i++) {
      const p = {
        x: ((i % input.width) + 0.5) / input.width,
        y: (Math.floor(i / input.width) + 0.5) / input.height,
      };
      expect(walls.some((surface) => maskContains(surface.mask, p))).toBe(Boolean(input.wall[i]));
    }
    for (const surface of surfaces)
      expect(mapped.find((value) => value.id === surface.id)!.mask).toBe(surface.mask);
  });

  it('uses an on-screen partial-height side reference and preserves grout phase across seams', () => {
    const result = inferWallGeometry(room()),
      back = result.planes.find((plane) => plane.side === 'back')!;
    const unit: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    for (const side of result.planes.filter((plane) => plane.side !== 'back')) {
      expect(side.heightFraction).toBeLessThan(1);
      expect(side.offsetFraction).toBeLessThan(0);
      expect(side.quad.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
      const physicalY = 1 - side.heightFraction * 0.45;
      const imagePoint = transformPoint(homography(unit, back.quad), {
        x: side.side === 'left' ? 0 : 1,
        y: physicalY,
      });
      const local = transformPoint(homography(side.quad), imagePoint);
      const sideMm = local.y * 2400 * side.heightFraction - 2400 * side.offsetFraction;
      expect(sideMm).toBeCloseTo(physicalY * 2400, 5);
    }
  });

  it('does not invent corners in a flat RGB image despite the same semantic mask', () => {
    const result = inferWallGeometry(room(true));
    expect(result.planes).toEqual([]);
    expect(result.wallSeams).toEqual([]);
    expect(result.warnings).not.toEqual([]);
  });

  it('falls back when a ceiling junction or floor evidence is unavailable', () => {
    expect(inferWallGeometry(room(false, false)).planes).toEqual([]);
    const input = room();
    input.floor.fill(0);
    expect(inferWallGeometry(input).planes).toEqual([]);
  });

  it('rejects unrelated vertical stripes away from floor-anchored corners', () => {
    const input = room(true);
    for (let y = 0; y < input.height; y++)
      for (const x of [24, 136]) input.rgba.set([5, 5, 5, 255], (y * input.width + x) * 4);
    expect(inferWallGeometry(input).wallSeams).toEqual([]);
  });

  it('does not apply one wall plane to a mask that has not been split at the seams', () => {
    const input = room(),
      result = inferWallGeometry(input);
    const surfaces = detectSurfaces({
      width: input.width,
      height: input.height,
      wallMask: input.wall,
      floorMask: input.floor,
    }).surfaces;
    const original = surfaces.find((surface) => surface.kind === 'wall')!;
    expect(applyWallGeometry(surfaces, result).find((surface) => surface.id === original.id)).toBe(original);
  });

  it('preserves width on repeated refits and uses the unchanged back-wall height and phase', () => {
    const input = room(),
      result = inferWallGeometry(input);
    result.planes.forEach((plane) => {
      if (plane.side !== 'back') plane.widthFraction = 0.95;
    });
    const surfaces = detectSurfaces({
      width: input.width,
      height: input.height,
      wallMask: input.wall,
      floorMask: input.floor,
      wallSeams: result.wallSeams,
    }).surfaces;
    const first = applyWallGeometry(surfaces, result),
      second = applyWallGeometry(first, result, { preserveWidths: true });
    for (const surface of first) {
      const again = second.find((item) => item.id === surface.id)!;
      expect(again.widthMm).toBe(surface.widthMm);
      expect(again.heightMm).toBe(surface.heightMm);
      expect(again.tile.offsetY).toBe(surface.tile.offsetY);
    }
  });
});
