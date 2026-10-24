/**
 * Room products are drawn at their registered height, the same in the 3D room and the 2D editor
 * (docs/product-scale-results-20261024.md): every local test product, with and without a depth,
 * with its 정면 or a side photo chosen, from the four sides, in the middle or a corner of the room.
 */
import { describe, expect, it } from 'vitest';
import {
  contactScene,
  measure2d,
  measure3d,
  SCALE_CASES,
  scaleFixture,
  scaleMaterial,
} from './helpers/product-scale';

const WITHIN = 0.05;
describe('room products at their registered size', () => {
  it.each(SCALE_CASES.map((c) => [c.name, c] as const))(
    '%s: the height is the registered one in 3D and 2D, which agree',
    async (_, c) => {
      for (const depth of [c.depthMm, 0])
        for (const chosen of [0, 1])
          for (const [u, v] of [
            [0.5, 0.55],
            [0.12, 0.85],
          ]) {
            const material = scaleMaterial(c, depth);
            const flat = measure2d(c, scaleFixture(c, chosen, u, v));
            const sides = await measure3d(c, contactScene([scaleFixture(c, chosen, u, v)]), material);
            const label = `${depth ? '깊이' : '깊이 없음'} · 사진 ${chosen} · (${u}, ${v})`;
            expect(sides, label).toHaveLength(4);
            for (const size of [flat, ...sides])
              expect(
                Math.abs(size.heightMm / size.registeredHeightMm - 1),
                `${label} · ${size.quarter ?? '2D'}`,
              ).toBeLessThanOrEqual(WITHIN);
            // The 2D editor draws the chosen photo as the 3D room's front camera shows it.
            const front = sides.find((size) => size.direction === flat.direction)!;
            expect(flat.heightMm).toBeCloseTo(front.heightMm, 3);
            expect(flat.acrossMm).toBeCloseTo(front.acrossMm, 3);
          }
    },
  );

  it('draws a side photo of a material without a depth at the same size as with one', async () => {
    const c = SCALE_CASES[1];
    const withDepth = await measure3d(c, contactScene([scaleFixture(c, 1)]), scaleMaterial(c));
    const without = await measure3d(c, contactScene([scaleFixture(c, 1)]), scaleMaterial(c, 0));
    expect(without.map((size) => Math.round(size.heightMm))).toEqual(
      withDepth.map((size) => Math.round(size.heightMm)),
    );
    expect(without.map((size) => Math.round(size.acrossMm))).toEqual(
      withDepth.map((size) => Math.round(size.acrossMm)),
    );
  });
});
