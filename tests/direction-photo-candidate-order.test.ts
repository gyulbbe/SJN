import { describe, expect, it } from 'vitest';
import {
  maskOverlap,
  OUTLINE_SIZE,
  outlineMask,
  overlapOrder,
} from '../src/lib/direction-photo/candidate-order';

/** A white picture with grey rectangles [x, y, w, h] painted on it (opaque unless alpha is given). */
function picture(width: number, height: number, boxes: number[][], alpha = 255) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [bx, by, bw, bh] of boxes)
    for (let y = by; y < by + bh; y++)
      for (let x = bx; x < bx + bw; x++) rgba.set([120, 120, 120, alpha], (y * width + x) * 4);
  return rgba;
}

describe('direction photo candidate order', () => {
  it('reads the product as everything darker than near white, cut to its box', () => {
    const mask = outlineMask(picture(40, 30, [[10, 5, 20, 20]]), 40, 30)!;
    expect(mask).toHaveLength(OUTLINE_SIZE * OUTLINE_SIZE);
    // The box fills the square: a plain rectangle is all product.
    expect(mask.every((value) => value === 1)).toBe(true);
    expect(outlineMask(picture(40, 30, []), 40, 30)).toBeUndefined();
    // Near white (the faint shadow) and transparency count as background.
    const faint = new Uint8ClampedArray(40 * 30 * 4).fill(240);
    expect(outlineMask(faint, 40, 30)).toBeUndefined();
    expect(outlineMask(picture(40, 30, [[10, 5, 20, 20]], 0), 40, 30)).toBeUndefined();
  });

  it('is 1 for the same outline at another size and position, less for a different one', () => {
    // A tank on the left and a bowl on the right, as a side guide.
    const guide = outlineMask(
      picture(80, 60, [
        [0, 0, 20, 60],
        [20, 30, 60, 30],
      ]),
      80,
      60,
    )!;
    const larger = outlineMask(
      picture(200, 140, [
        [20, 10, 40, 120],
        [60, 70, 120, 60],
      ]),
      200,
      140,
    )!;
    expect(maskOverlap(guide, larger)).toBeCloseTo(1, 1);
    // The same parts seen turned: the tank narrower, the bowl's front showing as a wider block.
    const turned = outlineMask(
      picture(80, 60, [
        [0, 0, 12, 60],
        [12, 20, 68, 40],
      ]),
      80,
      60,
    )!;
    expect(maskOverlap(guide, turned)).toBeLessThan(0.9);
    expect(maskOverlap(guide, turned)).toBeGreaterThan(0);
    expect(maskOverlap(new Uint8Array(4), new Uint8Array(4))).toBe(0);
  });

  it('puts the larger overlap first, keeps ties in place and the unmeasured last', () => {
    expect(overlapOrder([0.6, 0.8])).toEqual([1, 0]);
    expect(overlapOrder([0.8, 0.6])).toEqual([0, 1]);
    expect(overlapOrder([0.7, 0.7])).toEqual([0, 1]);
    expect(overlapOrder([undefined, 0.5])).toEqual([1, 0]);
    expect(overlapOrder([0.5, undefined, 0.9])).toEqual([2, 0, 1]);
    expect(overlapOrder([undefined, undefined])).toEqual([0, 1]);
  });
});
