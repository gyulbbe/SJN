import { describe, expect, it } from 'vitest';
import { extractFixturePixels } from '../src/lib/extract-fixture';

function image(width: number, height: number, rgba = [37, 121, 203, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}
function alpha(target: ReturnType<typeof image>, x: number, y: number, value: number) {
  target.data[(y * target.width + x) * 4 + 3] = value;
}

describe('manual fixture extraction', () => {
  it('crops to nonzero alpha bounds and returns the original bottom-center placement', () => {
    const source = image(10, 8),
      mask = image(10, 8, [0, 0, 0, 0]);
    alpha(mask, 2, 3, 1);
    alpha(mask, 5, 6, 255);
    const crop = extractFixturePixels(source, mask);
    expect(crop.bounds).toEqual({ x: 2, y: 3, width: 4, height: 4 });
    expect(crop.position).toEqual({ x: 0.4, y: 0.875 });
    expect(crop.width).toBe(0.4);
    expect(crop.height).toBe(0.5);
    expect(crop.anchor).toEqual({ x: 0.5, y: 1 });
    expect(crop.position.x - crop.width * crop.anchor.x).toBe(0.2);
    expect(crop.position.y - crop.height * crop.anchor.y).toBe(0.375);
    expect(crop.pixels[3]).toBe(1);
  });

  it('preserves RGB and fractional mask alpha, including transparent holes, without changing inputs', () => {
    const source = image(4, 1),
      mask = image(4, 1, [255, 0, 100, 0]);
    [255, 128, 0, 1].forEach((value, x) => alpha(mask, x, 0, value));
    const original = source.data.slice(),
      selection = mask.data.slice();
    const crop = extractFixturePixels(source, mask);
    expect([...crop.pixels]).toEqual([
      37, 121, 203, 255, 37, 121, 203, 128, 37, 121, 203, 0, 37, 121, 203, 1,
    ]);
    expect(source.data).toEqual(original);
    expect(mask.data).toEqual(selection);
  });

  it('multiplies source transparency and excludes fully invisible selected pixels from bounds', () => {
    const source = image(4, 1),
      mask = image(4, 1, [0, 0, 0, 128]);
    alpha(source, 0, 0, 0);
    alpha(source, 1, 0, 128);
    alpha(source, 3, 0, 0);
    const crop = extractFixturePixels(source, mask);
    expect(crop.bounds).toEqual({ x: 1, y: 0, width: 2, height: 1 });
    expect([crop.pixels[3], crop.pixels[7]]).toEqual([64, 128]);
  });

  it('keeps edge-touching selections and a single feathered pixel', () => {
    const source = image(2, 2),
      mask = image(2, 2, [255, 255, 255, 0]);
    alpha(mask, 1, 1, 1);
    const crop = extractFixturePixels(source, mask);
    expect(crop.bounds).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    expect(crop.position).toEqual({ x: 0.75, y: 1 });
    expect(crop.pixels).toEqual(new Uint8ClampedArray([37, 121, 203, 1]));
  });

  it('rejects empty or mismatched masks instead of creating an invisible material', () => {
    expect(() => extractFixturePixels(image(2, 2), image(2, 2, [255, 255, 255, 0]))).toThrow('먼저 선택');
    expect(() => extractFixturePixels(image(2, 2), image(1, 2))).toThrow('크기가 같아야');
    expect(() => extractFixturePixels(image(0, 0), image(0, 0))).toThrow('사진 크기');
    expect(() =>
      extractFixturePixels({ ...image(2, 2), data: new Uint8ClampedArray(3) }, image(2, 2)),
    ).toThrow('크기가 같아야');
  });
});
