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
  it('keeps the own colour of a body that is mostly but not fully opaque, filling only its soft edge', () => {
    // A row of 12 like LAUCHE LC-2100's side photo: transparent, a black-matted edge, a grey body only
    // 87% opaque (alpha 222), and one fully opaque dark pixel (the seat's shadow) at the far end.
    const pixel = (rgb: number, a: number) => [rgb, rgb, rgb, a];
    const row = [
      pixel(0, 0),
      pixel(40, 90),
      ...Array.from({ length: 9 }, () => pixel(180, 222)),
      pixel(20, 255),
    ];
    const filled = edgeFilled(new Uint8ClampedArray(row.flat()), row.length, 1);
    const at = (i: number) => [...filled.slice(i * 4, i * 4 + 4)];
    // The body more than EDGE_RING steps from the soft edge keeps its grey (not the shadow's 20).
    for (let i = 5; i <= 10; i++) expect(at(i)).toEqual([180, 180, 180, 222]);
    // The soft edge and the body within the ring take the body's grey, with their own alpha.
    expect(at(1)).toEqual([180, 180, 180, 90]);
    for (let i = 2; i <= 4; i++) expect(at(i)).toEqual([180, 180, 180, 222]);
    expect(at(11)).toEqual([20, 20, 20, 255]);
  });
  it('fills every soft pixel of a thin part from its opaque core, as before', () => {
    // A 1-pixel-tall pipe is all edge: its 200-alpha pixels are within the ring and take the core's colour.
    const data = new Uint8ClampedArray([
      0, 0, 0, 0, 30, 30, 30, 200, 160, 150, 140, 255, 30, 30, 30, 200, 0, 0, 0, 0,
    ]);
    const filled = edgeFilled(data, 5, 1);
    expect([...filled.slice(4, 8)]).toEqual([160, 150, 140, 200]);
    expect([...filled.slice(12, 16)]).toEqual([160, 150, 140, 200]);
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
