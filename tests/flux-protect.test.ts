import { describe, expect, it } from 'vitest';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import {
  edges,
  FEATHER_PX,
  fixtureAlignment,
  globalAlignment,
  maskBounds,
  projectCapture,
  projectMask,
  protectFixtures,
  resultToCapture,
  type FixtureMask,
  type Pixels,
} from '../src/lib/ai-export/protect';

const W = 400,
  H = 272;
/** A room-like picture: shaded walls with panel lines, a floor line and a few boxes. */
function room(width = W, height = H, shift = { x: 0, y: 0 }, scale = 1): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x - width / 2) / scale + width / 2 - shift.x,
        v = (y - height / 2) / scale + height / 2 - shift.y;
      let value = v > 180 ? 200 : 140 + ((Math.floor(u / 37) * 53) % 40);
      if (Math.abs(u - 60) < 2 || Math.abs(u - 340) < 2 || Math.abs(v - 180) < 2) value = 70;
      if (u > 250 && u < 290 && v > 120 && v < 200) value = 245; // "toilet"
      if (u > 90 && u < 150 && v > 100 && v < 130) value = 235; // "basin"
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = value;
      data[o + 3] = 255;
    }
  return { width, height, data };
}
function mask(width = W, height = H): FixtureMask {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x > 250 && x < 290 && y > 120 && y < 200) data[y * width + x] = 1;
      if (x > 90 && x < 150 && y > 100 && y < 130) data[y * width + x] = 2;
    }
  return { width, height, ids: ['toilet', 'basin'], data };
}
const kinds = { toilet: 'toilet', basin: 'basin' } as const;

describe('coordinates', () => {
  it('maps result pixels through the padded model input back to the capture', () => {
    // 1024×576 → 496×279 content, padded to the 16 px grid (288) with white rows above and below.
    const layout = fluxInputLayout(1024, 576);
    expect(layout).toMatchObject({ width: 496, height: 288 });
    const map = resultToCapture(layout, { width: layout.width * 2, height: layout.height * 2 });
    const centre = map(layout.width - 0.5, layout.height - 0.5);
    expect(centre.x).toBeCloseTo(511.5, 1);
    expect(centre.y).toBeCloseTo(287.5, 1);
    // The first content row of the result sits below the padding.
    const top = map(0, 2 * layout.y);
    expect(top.y).toBeCloseTo(-0.5 + 0.5 / (2 * layout.scale), 1);
  });

  it('projects the capture with white padding and the mask by nearest id', () => {
    const capture = room(100, 50);
    const layout = fluxInputLayout(capture.width, capture.height);
    const size = { width: layout.width * 2, height: layout.height * 2 };
    const reference = projectCapture(capture, layout, size);
    expect(reference.width).toBe(size.width);
    if (layout.y > 1) expect([...reference.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    const small = mask(100, 50);
    small.data.fill(0);
    small.data[25 * 100 + 50] = 1;
    const projected = projectMask(small, layout, size);
    const hits = projected.data.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);
    const perPixel = ((layout.scale * size.width) / layout.width) ** 2;
    expect(hits).toBeGreaterThan(perPixel * 0.5);
    expect(hits).toBeLessThan(perPixel * 2);
  });
});

describe('alignment', () => {
  const reference = room();
  const a = edges(reference);
  it('finds a small shift of the whole picture and of each fixture', () => {
    const result = room(W, H, { x: 6, y: 4 });
    const b = edges(result);
    const framing = globalAlignment(a, b);
    expect(framing.aligned).toBe(true);
    const m = mask();
    const toilet = fixtureAlignment(a, b, m, 1, maskBounds(m, 1)!, framing);
    expect(toilet).toMatchObject({ dx: 6, dy: 4, aligned: true });
    expect(toilet.score).toBeGreaterThan(0.8);
  });

  it('does not accept a fixture the model redrew as something else', () => {
    const result = room(W, H, { x: 2, y: 0 });
    // A dark cylinder where the toilet was.
    for (let y = 110; y < 205; y++)
      for (let x = 240; x < 300; x++) {
        const o = (y * W + x) * 4,
          dx = (x - 270) / 18;
        const value = Math.abs(dx) < 1 && y > 130 ? 90 + 60 * (1 - dx * dx) : 200;
        result.data[o] = result.data[o + 1] = result.data[o + 2] = value;
      }
    const b = edges(result);
    const framing = globalAlignment(a, b);
    const m = mask();
    expect(framing.aligned).toBe(true);
    expect(fixtureAlignment(a, b, m, 1, maskBounds(m, 1)!, framing).aligned).toBe(false);
    expect(fixtureAlignment(a, b, m, 2, maskBounds(m, 2)!, framing).aligned).toBe(true);
  });

  it('does not accept a reframed picture', () => {
    const framing = globalAlignment(a, edges(room(W, H, { x: 0, y: 0 }, 1.35)));
    expect(framing.aligned).toBe(false);
  });
});

describe('protection', () => {
  it('paints aligned fixtures back, leaves everything else and reports each fixture', () => {
    const reference = room();
    const result = room(W, H, { x: 6, y: 4 });
    // The model tinted the toilet: protection restores the render's colour.
    for (let y = 124; y < 204; y++)
      for (let x = 256; x < 296; x++) {
        const o = (y * W + x) * 4;
        result.data[o] = 200;
        result.data[o + 1] = 215;
        result.data[o + 2] = 255;
      }
    const m = mask();
    const { image, fixtures, framing } = protectFixtures({ reference, result, mask: m, kinds });
    expect(framing.aligned).toBe(true);
    expect(fixtures.map((f) => [f.id, f.status])).toEqual([
      ['toilet', 'protected'],
      ['basin', 'protected'],
    ]);
    // Inside the moved toilet: the render's pixel.
    const inside = (170 * W + 276) * 4;
    expect([...image.data.slice(inside, inside + 3)]).toEqual([245, 245, 245]);
    // Well away from both fixtures: untouched.
    const reach = 2 * FEATHER_PX + 1;
    for (const [x, y] of [
      [20, 20],
      [200, 240],
      [256 - reach - 1, 150],
    ]) {
      const o = (y * W + x) * 4;
      expect([...image.data.slice(o, o + 4)]).toEqual([...result.data.slice(o, o + 4)]);
    }
    // Across the edge the blend is gradual, not a hard step.
    const row = 170 * W;
    const edge = [252, 254, 256, 258, 260].map((x) => image.data[(row + x) * 4 + 2]);
    expect(new Set(edge).size).toBeGreaterThan(2);
  });

  it('skips kinds left to the model, reports hidden fixtures and nothing moves on a reframed picture', () => {
    const reference = room();
    const m = mask();
    m.ids = ['mirror', 'toilet', 'gone'];
    const kept = protectFixtures({
      reference,
      result: room(W, H, { x: 2, y: 2 }),
      mask: m,
      kinds: { mirror: 'mirror', toilet: 'toilet' },
    });
    expect(kept.fixtures).toEqual([
      { id: 'mirror', kind: 'mirror', status: 'skipped' },
      expect.objectContaining({ id: 'toilet', status: 'protected' }),
      { id: 'gone', kind: undefined, status: 'hidden' },
    ]);
    const reframed = room(W, H, { x: 0, y: 0 }, 1.35);
    const moved = protectFixtures({ reference, result: reframed, mask: mask(), kinds });
    expect(moved.fixtures.every((f) => f.status === 'moved')).toBe(true);
    expect([...moved.image.data]).toEqual([...reframed.data]);
    expect(() => protectFixtures({ reference, result: room(100, 50), mask: mask(), kinds })).toThrow();
  });
});
