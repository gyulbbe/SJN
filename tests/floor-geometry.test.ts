import { describe, expect, it } from 'vitest';
import { binaryMaskToMask, detectSurfaces } from '../src/lib/render/auto-surfaces';
import { maskContains, pointInPolygon } from '../src/lib/render/mask';
import { validateQuad } from '../src/lib/render/math';
import type { Point, Quad } from '../src/lib/types';

function floor(width: number, height: number, quad: Quad, keep: (point: Point) => boolean = () => true) {
  const mask = Uint8Array.from({ length: width * height }, (_, index) => {
    const point = { x: ((index % width) + 0.5) / width, y: (Math.floor(index / width) + 0.5) / height };
    return pointInPolygon(point, quad) && keep(point) ? 255 : 0;
  });
  const result = detectSurfaces({
    width,
    height,
    wallMask: new Uint8Array(mask.length),
    floorMask: mask,
    minAreaRatio: 0,
    minComponentPixels: 1,
  });
  return { mask, result };
}
function sideSlope(quad: Quad, side: 'left' | 'right') {
  const a = quad[side === 'left' ? 0 : 1],
    b = quad[side === 'left' ? 3 : 2];
  return (b.x - a.x) / (b.y - a.y);
}
function expectExact(width: number, height: number, bitmap: Uint8Array, contains: (point: Point) => boolean) {
  for (let index = 0; index < bitmap.length; index++) {
    const point = { x: ((index % width) + 0.5) / width, y: (Math.floor(index / width) + 0.5) / height };
    expect(contains(point), `pixel ${index % width},${Math.floor(index / width)}`).toBe(
      Boolean(bitmap[index]),
    );
  }
}

describe('floor plane direction from observed boundaries', () => {
  it('continues a side behind a foreground doorway without growing the exact clip mask', () => {
    const expected: Quad = [
      { x: 0.3, y: 0.45 },
      { x: 0.7, y: 0.45 },
      { x: 0.94, y: 1 },
      { x: 0.02, y: 1 },
    ];
    const { mask, result } = floor(
      160,
      120,
      expected,
      (p) => p.x > 0.19 && !(p.x > 0.58 && p.x < 0.68 && p.y > 0.56 && p.y < 0.8),
    );
    expect(result.surfaces).toHaveLength(1);
    const surface = result.surfaces[0];
    expect(validateQuad(surface.quad)).toBe(true);
    expect(sideSlope(surface.quad, 'left')).toBeCloseTo(sideSlope(expected, 'left'), 1);
    expect(sideSlope(surface.quad, 'right')).toBeCloseTo(sideSlope(expected, 'right'), 1);
    expect(surface.quad[3].x).toBeLessThan(0.06);
    expect(surface.calibrated).toBe(false);
    expectExact(160, 120, mask, (p) => maskContains(surface.mask, p));
    expect(maskContains(surface.mask, { x: 0.12, y: 0.95 })).toBe(false);
    expect(maskContains(surface.mask, { x: 0.63, y: 0.7 })).toBe(false);
  });

  it('keeps a clipped foreground reference inside the image without clamping away perspective', () => {
    const expected: Quad = [
      { x: 0.3, y: 0.35 },
      { x: 0.7, y: 0.35 },
      { x: 1.2, y: 1 },
      { x: -0.2, y: 1 },
    ];
    const { mask, result } = floor(180, 120, expected);
    const surface = result.surfaces[0];
    expect(sideSlope(surface.quad, 'left')).toBeCloseTo(sideSlope(expected, 'left'), 1);
    expect(sideSlope(surface.quad, 'right')).toBeCloseTo(sideSlope(expected, 'right'), 1);
    expect(surface.quad[2].y).toBeLessThan(0.9);
    expect(surface.quad.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)).toBe(true);
    expectExact(180, 120, mask, (p) => maskContains(surface.mask, p));
  });

  it('retains the observed transverse tilt for a rolled view', () => {
    const expected: Quad = [
      { x: 0.3, y: 0.4 },
      { x: 0.7, y: 0.46 },
      { x: 1, y: 1.06 },
      { x: 0, y: 0.91 },
    ];
    const { result } = floor(160, 120, expected, (p) => p.x > 0.12 && p.x < 0.94);
    const quad = result.surfaces[0].quad;
    expect(sideSlope(quad, 'left')).toBeCloseTo(sideSlope(expected, 'left'), 1);
    expect(sideSlope(quad, 'right')).toBeCloseTo(sideSlope(expected, 'right'), 1);
    const rearTilt = (quad[1].y - quad[0].y) / (quad[1].x - quad[0].x);
    const frontTilt = (quad[2].y - quad[3].y) / (quad[2].x - quad[3].x);
    expect(rearTilt).toBeCloseTo(0.15, 1);
    expect(frontTilt).toBeCloseTo(rearTilt, 6);
  });

  it('falls back to an editable valid plane when diagonal boundary evidence is absent', () => {
    const { mask, result } = floor(40, 30, [
      { x: 0.1, y: 0.4 },
      { x: 0.9, y: 0.4 },
      { x: 0.9, y: 1 },
      { x: 0.1, y: 1 },
    ]);
    expect(validateQuad(result.surfaces[0].quad)).toBe(true);
    expect(result.surfaces[0].calibrated).toBe(false);
    expectExact(40, 30, mask, (p) => maskContains(result.surfaces[0].mask, p));
  });
});

describe('exact bitmap to generic protection mask', () => {
  it('preserves tiny islands, nested holes and foreground inside those holes', () => {
    const width = 24,
      height = 20;
    const data = Uint8Array.from({ length: width * height }, (_, i) => {
      const x = i % width,
        y = Math.floor(i / width);
      return (x < 18 && y < 18 && !(x > 3 && x < 14 && y > 3 && y < 14)) ||
        (x > 7 && x < 10 && y > 7 && y < 10) ||
        (x === 22 && y === 19)
        ? 255
        : 0;
    });
    const original = data.slice();
    const mask = binaryMaskToMask({ width, height, data });
    expectExact(width, height, data, (p) => maskContains(mask, p));
    expect(data).toEqual(original);
  });

  it('rejects excessive contour counts rather than losing tiny protected components', () => {
    const data = Uint8Array.from({ length: 128 * 128 }, (_, i) =>
      (i % 128) % 3 === 1 && Math.floor(i / 128) % 3 === 1 ? 1 : 0,
    );
    expect(() => binaryMaskToMask({ width: 128, height: 128, data })).toThrow('복잡');
    expect(binaryMaskToMask({ width: 3, height: 3, data: new Uint8Array(9) })).toEqual({
      polygon: [],
      strokes: [],
    });
  });
});
