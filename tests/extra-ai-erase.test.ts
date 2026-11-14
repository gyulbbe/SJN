// The added-objects trial's erasing step (tests/extra-ai/erase.ts): it removes what the model added on
// a face, keeps the rest of the model's picture, and never touches fixtures, glass or the backdrop.
import { describe, expect, it } from 'vitest';
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../src/lib/ai-export/color';
import { eraseAdded } from './extra-ai/erase';

const W = 240,
  H = 160;
/** A white tiled wall: 20 px tiles, 2 px grey joints. */
function render(): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const joint = x % 20 < 2 || y % 20 < 2;
      const v = joint ? 170 : 235;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
}
/** The model's picture: the render under a soft light from the left, warmer, plus `paint`. */
function model(reference: Pixels, paint?: (x: number, y: number) => [number, number, number] | undefined) {
  const data = new Uint8ClampedArray(reference.data);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const light = 1 - (0.25 * x) / W;
      const own = paint?.(x, y);
      if (own) data.set([...own, 255], o);
      else
        data.set(
          [
            reference.data[o] * light,
            reference.data[o + 1] * light * 0.97,
            reference.data[o + 2] * light * 0.92,
            255,
          ],
          o,
        );
    }
  return { width: W, height: H, data };
}
/** One wall face; a fixture box on the right when asked. */
function mask(fixture?: [number, number, number, number]): RegionMask {
  const data = new Uint8Array(W * H).fill(1);
  if (fixture)
    for (let y = fixture[1]; y < fixture[1] + fixture[3]; y++)
      for (let x = fixture[0]; x < fixture[0] + fixture[2]; x++) data[y * W + x] = FIXTURE_REGION;
  return { width: W, height: H, regions: [{ key: 'face:back', kind: 'wall' }], data };
}
const at = (image: Pixels, x: number, y: number) => {
  const o = (y * W + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2]];
};

describe('eraseAdded', () => {
  it('leaves a picture without added objects as it is', () => {
    const reference = render();
    const result = model(reference);
    const erased = eraseAdded(reference, result, mask());
    expect(erased.objects).toEqual([]);
    expect(Buffer.from(erased.image.data).equals(Buffer.from(result.data))).toBe(true);
  });

  it('removes a dark holder and keeps the light round it', () => {
    const reference = render();
    const holder = (x: number, y: number) =>
      x >= 100 && x < 124 && y >= 60 && y < 76 ? ([40, 40, 45] as [number, number, number]) : undefined;
    const result = model(reference, holder);
    const clean = model(reference);
    const erased = eraseAdded(reference, result, mask());
    expect(erased.objects).toHaveLength(1);
    expect(erased.objects[0].reasons).toContain('dark');
    // Where the holder was, the wall again (a tile's middle, within a few levels of the clean picture).
    for (const [x, y] of [
      [110, 68],
      [105, 64],
    ]) {
      const got = at(erased.image, x, y),
        want = at(clean, x, y);
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c])).toBeLessThan(14);
    }
    // Far from it, nothing changed.
    expect(at(erased.image, 20, 130)).toEqual(at(result, 20, 130));
    expect(erased.changed[1]).toBeLessThan(0.05);
  });

  it('finds an object of another colour at the same brightness', () => {
    const reference = render();
    const towel = (x: number, y: number) =>
      x >= 60 && x < 90 && y >= 90 && y < 104 ? ([250, 170, 200] as [number, number, number]) : undefined;
    const erased = eraseAdded(reference, model(reference, towel), mask());
    expect(erased.objects.map((o) => o.reasons).flat()).toContain('colour');
  });

  it('never touches the fixture region or a margin round it', () => {
    const reference = render();
    const fixture: [number, number, number, number] = [150, 40, 40, 60];
    // A dark object right against the fixture, and the fixture itself drawn dark.
    const result = model(reference, (x, y) =>
      (x >= 130 && x < 150 && y >= 50 && y < 70) || (x >= 150 && x < 190 && y >= 40 && y < 100)
        ? [30, 30, 30]
        : undefined,
    );
    const erased = eraseAdded(reference, result, mask(fixture));
    for (let y = 40; y < 100; y++)
      for (let x = 144; x < 196; x++) expect(at(erased.image, x, y)).toEqual(at(result, x, y));
  });

  it('erases only the faces it is given', () => {
    const reference = render();
    const result = model(reference, (x, y) =>
      x >= 100 && x < 124 && y >= 60 && y < 76 ? [40, 40, 45] : undefined,
    );
    const erased = eraseAdded(reference, result, mask(), { labels: new Set([2]) });
    expect(erased.objects).toEqual([]);
    expect(Buffer.from(erased.image.data).equals(Buffer.from(result.data))).toBe(true);
  });
});
