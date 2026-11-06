import { describe, expect, it } from 'vitest';
import { roundedRectPoints, shapeExtent } from './direction-photo-methods/shapes';
import { CLASSES, directionsOf } from './sanitary-guides/classes';
import { createSanitaryShape, SANITARY_SHAPES } from './sanitary-guides/shapes';

describe('sanitary-ware guide classes', () => {
  it('puts each of the 200 collected products in exactly one class', () => {
    const members = CLASSES.flatMap((c) => c.members);
    expect(members).toHaveLength(200);
    expect(new Set(members).size).toBe(200);
    for (const c of CLASSES) expect(c.members).toContain(c.rep);
  });

  it('gives a floor product a back view and a wall product none', () => {
    for (const c of CLASSES)
      expect((directionsOf(c) as readonly string[]).includes('뒤')).toBe(c.installation !== 'wall');
  });

  it.each(SANITARY_SHAPES)('%s fills its box exactly', (shape) => {
    const size: [number, number, number] = [500, 400, 450];
    const { min, max } = shapeExtent(createSanitaryShape(shape, size));
    for (let k = 0; k < 3; k++) expect(max[k] - min[k]).toBeCloseTo(size[k], 3);
    expect(min[1]).toBeCloseTo(0, 3);
    expect(min[0] + max[0]).toBeCloseTo(0, 3);
    expect(min[2] + max[2]).toBeCloseTo(0, 3);
  });
});

describe('roundedRectPoints', () => {
  it('turns one way all round (its corners bulge out; until 2026-11-06 they turned inward)', () => {
    const points = roundedRectPoints(400, 300, 60, 20, 6);
    const xs = points.map((p) => p[0]),
      zs = points.map((p) => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(200, 6);
    expect(Math.min(...xs)).toBeCloseTo(-200, 6);
    expect(Math.max(...zs)).toBeCloseTo(170, 6);
    expect(Math.min(...zs)).toBeCloseTo(-130, 6);
    const signs = new Set<number>();
    for (let i = 0; i < points.length; i++) {
      const [a, b, c] = [points[i], points[(i + 1) % points.length], points[(i + 2) % points.length]];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) > 1e-6) signs.add(Math.sign(cross));
    }
    expect([...signs]).toHaveLength(1);
  });
});
