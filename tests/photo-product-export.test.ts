import { describe, expect, it } from 'vitest';
import { photoProductCount } from '../src/lib/ai-export/scene';
import { edgeFilled } from '../src/lib/room-viewer/fixtures';
import type { RenderSnapshot } from '../src/lib/types';

describe('a product photo in the 3D room', () => {
  it('gives its soft and transparent pixels the colour of the nearest opaque one, keeping every alpha', () => {
    // A row of 5: opaque white, a soft black-matted edge, transparent black, a soft edge, opaque red.
    const data = new Uint8ClampedArray([
      255, 255, 255, 255, 30, 30, 30, 128, 0, 0, 0, 0, 40, 0, 0, 100, 200, 10, 10, 255,
    ]);
    const filled = edgeFilled(data, 5, 1);
    expect([...filled.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    // The edge next to white is white now (no black outline), half transparent as before.
    expect([...filled.slice(4, 8)]).toEqual([255, 255, 255, 128]);
    // The transparent pixel takes a neighbour's colour and stays transparent.
    expect(filled[11]).toBe(0);
    expect([...filled.slice(8, 11)]).not.toEqual([0, 0, 0]);
    expect([...filled.slice(12, 16)]).toEqual([200, 10, 10, 100]);
    expect([...filled.slice(16, 20)]).toEqual([200, 10, 10, 255]);
    // The input is not changed.
    expect([...data.slice(4, 8)]).toEqual([30, 30, 30, 128]);
  });
  it('leaves a photo without an opaque pixel as it is', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 100, 0, 0, 0, 0]);
    expect([...edgeFilled(data, 2, 1)]).toEqual([...data]);
  });
});

describe('the photo products of a design', () => {
  const snapshot = (fixtures: object[], materials: object) =>
    ({ scene: { fixtures }, materials }) as unknown as Pick<RenderSnapshot, 'scene' | 'materials'>;
  it('counts the products drawn as their own photos, not standard models or products without a picture', () => {
    const materials = {
      photo: { views: [{ assetId: 'front', direction: '정면' }] },
      cover: { views: [], coverAssetId: 'cover' },
      bare: { views: [] },
    };
    expect(
      photoProductCount(
        snapshot(
          [
            { materialVersionId: 'photo', viewIndex: 0 },
            { materialVersionId: 'cover', viewIndex: 0 },
            { materialVersionId: 'photo', viewIndex: 0, reconstruction: { kind: 'toilet' } },
            { materialVersionId: 'bare', viewIndex: 0 },
          ],
          materials,
        ),
      ),
    ).toBe(2);
    expect(photoProductCount(snapshot([], materials))).toBe(0);
  });
});
