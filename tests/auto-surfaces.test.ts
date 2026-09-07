import { describe, expect, it } from 'vitest';
import { detectSurfaces, estimatePlaneQuad } from '../src/lib/render/auto-surfaces';
import { maskContains } from '../src/lib/render/mask';
import { validateQuad } from '../src/lib/render/math';
import type { Surface } from '../src/lib/types';

const binary = (width: number, height: number, predicate: (x: number, y: number) => boolean) =>
  Uint8Array.from({ length: width * height }, (_, index) =>
    predicate(index % width, Math.floor(index / width)) ? 1 : 0,
  );
function detect(
  width: number,
  height: number,
  wallMask: Uint8Array,
  floorMask = new Uint8Array(width * height),
) {
  return detectSurfaces({ width, height, wallMask, floorMask, minComponentPixels: 1, minAreaRatio: 0 });
}
function exactMembership(surfaces: Surface[], mask: Uint8Array, width: number, height: number) {
  for (let index = 0; index < mask.length; index++) {
    const point = { x: ((index % width) + 0.5) / width, y: (Math.floor(index / width) + 0.5) / height };
    const count = surfaces.filter((surface) => maskContains(surface.mask, point)).length;
    expect(count, `pixel (${index % width}, ${Math.floor(index / width)})`).toBe(mask[index] ? 1 : 0);
  }
}

describe('semantic masks to editable surfaces', () => {
  it('preserves a wall with a window hole instead of painting its bounding rectangle', () => {
    const width = 24,
      height = 20;
    const mask = binary(
      width,
      height,
      (x, y) => x >= 2 && x < 22 && y >= 1 && y < 18 && !(x >= 7 && x < 14 && y >= 5 && y < 12),
    );
    const result = detect(width, height, mask);
    expect(result.surfaces).toHaveLength(1);
    const wall = result.surfaces[0];
    expect(wall.mask.polygon).toHaveLength(4);
    expect(wall.mask.holes).toHaveLength(1);
    expect(wall.mask.holes![0]).toHaveLength(4);
    expect(wall.calibrated).toBe(false);
    expect(wall.widthMm).toBe(2000);
    expect(wall.heightMm).toBe(2000);
    expect(validateQuad(wall.quad)).toBe(true);
    exactMembership(result.surfaces, mask, width, height);
  });

  it('keeps concavities, thin notches, nested islands, and image-border holes exact', () => {
    const width = 16,
      height = 16;
    const mask = binary(
      width,
      height,
      (x, y) =>
        (x < 13 && y < 14 && !(x >= 4 && x < 10 && y >= 4 && y < 10) && !(x >= 10 && y === 3)) ||
        (x >= 6 && x < 8 && y >= 6 && y < 8),
    );
    const result = detect(width, height, mask);
    expect(result.surfaces).toHaveLength(2);
    exactMembership(result.surfaces, mask, width, height);
  });

  it('does not bridge diagonal pixel contacts', () => {
    const mask = binary(6, 6, (x, y) => (x < 3 && y < 3) || (x >= 3 && y >= 3));
    const result = detect(6, 6, mask);
    expect(result.surfaces).toHaveLength(2);
    exactMembership(result.surfaces, mask, 6, 6);
  });

  it('traces boundary pinches and jagged contours without growing into background', () => {
    let seed = 6123;
    for (let example = 0; example < 220; example++) {
      const mask = binary(7, 7, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296 > 0.32;
      });
      const result = detect(7, 7, mask);
      exactMembership(result.surfaces, mask, 7, 7);
      expect(result.surfaces.every((surface) => validateQuad(surface.quad))).toBe(true);
    }
  });

  it('creates distinct wall/floor surfaces and rejects ambiguous overlapping class pixels', () => {
    const width = 20,
      height = 20;
    const wall = binary(width, height, (_, y) => y < 12);
    const floor = binary(width, height, (_, y) => y >= 10);
    const result = detect(width, height, wall, floor);
    expect(result.surfaces.map((surface) => surface.kind).sort()).toEqual(['floor', 'wall']);
    expect(result.warnings.some((warning) => warning.includes('중복'))).toBe(true);
    const disjoint = binary(width, height, (_, y) => y < 10 || y >= 12);
    exactMembership(result.surfaces, disjoint, width, height);
  });

  it('only splits touching walls when an independently supplied image seam exists', () => {
    const width = 40,
      height = 30;
    const wallMask = binary(width, height, (x, y) => x >= 2 && x < 38 && y < 24);
    const floorMask = binary(width, height, (_, y) => y >= 24);
    expect(detect(width, height, wallMask, floorMask).surfaces).toHaveLength(2);
    const result = detectSurfaces({
      width,
      height,
      wallMask,
      floorMask,
      wallSeams: [{ top: { x: 0.4, y: 0 }, bottom: { x: 0.5, y: 1 } }],
      minComponentPixels: 1,
      minAreaRatio: 0,
    });
    const walls = result.surfaces.filter((surface) => surface.kind === 'wall');
    expect(walls).toHaveLength(2);
    expect(result.surfaces.filter((surface) => surface.kind === 'floor')).toHaveLength(1);
    expect(walls[0].quad).not.toEqual(walls[1].quad);
    exactMembership(walls, wallMask, width, height);
  });

  it('estimates a trapezoid from the observed contour while preserving the exact step boundary', () => {
    const width = 40,
      height = 30;
    const mask = binary(
      width,
      height,
      (x, y) => y >= 5 && x >= Math.floor(12 - (y - 5) * 0.4) && x <= Math.ceil(27 + (y - 5) * 0.4),
    );
    const result = detect(width, height, new Uint8Array(width * height), mask);
    expect(result.surfaces).toHaveLength(1);
    const quad = result.surfaces[0].quad;
    expect(validateQuad(quad)).toBe(true);
    expect(quad[0].x).toBeGreaterThan(quad[3].x);
    expect(quad[1].x).toBeLessThan(quad[2].x);
    exactMembership(result.surfaces, mask, width, height);
  });

  it('permits an explicit later brush stroke to restore a masked hole', () => {
    const mask = binary(12, 12, (x, y) => !(x >= 4 && x < 8 && y >= 4 && y < 8));
    const surface = detect(12, 12, mask).surfaces[0];
    expect(maskContains(surface.mask, { x: 0.5, y: 0.5 })).toBe(false);
    surface.mask.strokes.push({ points: [{ x: 0.5, y: 0.5 }], radius: 0.1, erase: false });
    expect(maskContains(surface.mask, { x: 0.5, y: 0.5 })).toBe(true);
    expect(maskContains(surface.mask, { x: 0.35, y: 0.35 })).toBe(false);
  });

  it('filters small noise and never invents a fallback surface for an empty prediction', () => {
    const result = detectSurfaces({
      width: 20,
      height: 20,
      wallMask: binary(20, 20, (x, y) => (x < 10 && y < 10) || (x === 18 && y === 18)),
      floorMask: new Uint8Array(400),
    });
    expect(result.surfaces).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes('작은'))).toBe(true);
    const empty = detect(10, 10, new Uint8Array(100));
    expect(empty.surfaces).toEqual([]);
    expect(empty.warnings.some((warning) => warning.includes('찾지 못'))).toBe(true);
  });

  it('rejects excessive contour complexity instead of dropping protected holes', () => {
    const mask = binary(
      128,
      128,
      (x, y) => !(x > 0 && y > 0 && x < 127 && y < 127 && x % 3 === 1 && y % 3 === 1),
    );
    const result = detect(128, 128, mask);
    expect(result.surfaces).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes('복잡'))).toBe(true);
  });

  it('accepts byte masks, keeps inputs immutable, and rejects invalid dimensions', () => {
    const wallMask = new Uint8Array(64).fill(255),
      original = wallMask.slice();
    const result = detect(8, 8, wallMask);
    expect(result.surfaces).toHaveLength(1);
    expect(wallMask).toEqual(original);
    expect(() => detect(0, 8, wallMask)).toThrow();
    expect(() => detect(8, 8, new Uint8Array(63))).toThrow();
    expect(() => estimatePlaneQuad([])).toThrow();
  });
});
