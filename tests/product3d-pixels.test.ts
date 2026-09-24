import { describe, it, expect } from 'vitest';
import { defringeAlpha, foregroundBounds, rgbNchw, transposeTokens } from '../src/lib/product3d/pixels';

describe('multiview transparent source preparation', () => {
  it('finds asymmetric foreground without carrying transparent padding into the model crop', () => {
    const rgba = new Uint8ClampedArray(8 * 6 * 4);
    for (let y = 2; y < 5; y++) for (let x = 1; x < 4; x++) rgba[(y * 8 + x) * 4 + 3] = 255;
    expect(foregroundBounds(rgba, 8, 6)).toEqual({ x: 1, y: 2, width: 3, height: 3 });
  });
  it('does not run reconstruction on an unremoved background or an empty image', () => {
    expect(() => foregroundBounds(new Uint8ClampedArray(16).fill(255), 2, 2)).toThrow('배경 제거');
    expect(() => foregroundBounds(new Uint8ClampedArray(16), 2, 2)).toThrow('제품이 보이지');
  });
  it('uses RGB 0..1 channels, as expected by the exported ViT, without background-removal normalization', () => {
    const value = rgbNchw(new Uint8ClampedArray([255, 128, 0, 255, 0, 255, 128, 255]), 2, 1);
    expect([...value.slice(0, 2)]).toEqual([1, 0]);
    expect(value[2]).toBeCloseTo(128 / 255);
    expect(value[3]).toBe(1);
    expect(value[4]).toBe(0);
    expect(value[5]).toBeCloseTo(128 / 255);
  });
  it('transposes channel-first image features to token-first without aliasing', () => {
    const input = new Float32Array([1, 2, 3, 4, 5, 6]);
    const output = transposeTokens(input, 2, 3);
    expect([...output]).toEqual([1, 4, 2, 5, 3, 6]);
    output[0] = 99;
    expect(input[0]).toBe(1);
    expect(() => transposeTokens(input, 3, 3)).toThrow('크기');
  });
});

describe('cut-out edge cleanup before the grey background', () => {
  // A 7×7 red square cut out with a one-pixel semi-transparent grey fringe around it.
  const size = 9;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = x >= 1 && x <= 7 && y >= 1 && y <= 7;
      const edge = inside && (x === 1 || x === 7 || y === 1 || y === 7);
      if (!inside) continue;
      rgba.set(edge ? [128, 128, 128, 120] : [220, 30, 30, 255], i);
    }
  const at = (data: Uint8ClampedArray, x: number, y: number) => [
    ...data.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
  ];

  it('gives fringe pixels the product colour instead of the grey they were blended with', () => {
    const cleaned = defringeAlpha(rgba, size, size, 0);
    expect(at(cleaned, 1, 4)).toEqual([220, 30, 30, 120]);
    expect(at(cleaned, 4, 4)).toEqual([220, 30, 30, 255]);
    expect(at(cleaned, 0, 0)[3]).toBe(0);
  });

  it('shrinks the alpha by the radius and leaves the source untouched', () => {
    const cleaned = defringeAlpha(rgba, size, size, 1);
    expect(at(cleaned, 1, 4)[3]).toBe(0);
    expect(at(cleaned, 2, 4)[3]).toBe(120);
    expect(at(cleaned, 4, 4)[3]).toBe(255);
    expect(at(rgba, 1, 4)).toEqual([128, 128, 128, 120]);
  });
});
