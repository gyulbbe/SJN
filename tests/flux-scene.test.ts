import { describe, expect, it } from 'vitest';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import {
  describeFixture,
  finishCategory,
  fixtureImageBox,
  orderFixtures,
  toInputBox,
} from '../src/lib/ai-export/scene';
import type { FixtureInstance, MaterialVersion } from '../src/lib/types';

const base: FixtureInstance = {
  id: 'f',
  name: 'f',
  materialVersionId: 'm',
  viewIndex: 0,
  position: { x: 0.5, y: 0.8 },
  width: 0.1,
  height: 0.2,
  rotation: 0,
  anchor: { x: 0.5, y: 1 },
  locked: false,
  shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
  occlusion: { polygon: [], strokes: [] },
  color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
};
const product = (patch: Partial<MaterialVersion>): MaterialVersion =>
  ({
    id: 'm',
    materialId: 'm',
    version: 1,
    name: '제품',
    brand: '',
    code: '',
    category: 'toilet',
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 380,
    heightMm: 720,
    depthMm: 690,
    usage: 'floor',
    installation: 'floor',
    textureAssetIds: [],
    views: [{ assetId: 'photo', direction: '정면', anchor: { x: 0.5, y: 1 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    createdAt: '2026-09-25',
    ...patch,
  }) as MaterialVersion;
const close = (box: number[] | undefined, expected: number[]) =>
  expected.forEach((value, i) => expect(box?.[i]).toBeCloseTo(value, 6));

describe('fixtureImageBox (2D compositor geometry)', () => {
  it('uses the anchored rectangle', () => {
    close(fixtureImageBox(base, 1.5), [0.45, 0.6, 0.55, 0.8]);
  });
  it('rotates in pixel space like the fixture shader', () => {
    // 90° turns the 0.1-wide (0.15 in pixel units) × 0.2 box around its anchor.
    const box = fixtureImageBox({ ...base, rotation: 90, anchor: { x: 0.5, y: 0.5 } }, 1.5);
    close(box, [0.5 - 0.2 / 1.5 / 2, 0.8 - 0.075, 0.5 + 0.2 / 1.5 / 2, 0.8 + 0.075]);
  });
  it('prefers the perspective quad and clamps to the image', () => {
    const quad = [
      { x: 0.9, y: 0.1 },
      { x: 1.2, y: 0.12 },
      { x: 1.2, y: 0.3 },
      { x: 0.9, y: 0.28 },
    ] as FixtureInstance['projectedQuad'];
    close(fixtureImageBox({ ...base, projectedQuad: quad }, 1.5), [0.9, 0.1, 1, 0.3]);
    expect(fixtureImageBox({ ...base, position: { x: 3, y: 3 } }, 1.5)).toBeUndefined();
  });
});

describe('toInputBox', () => {
  it('follows the scale and white padding of the 496px input', () => {
    const layout = fluxInputLayout(2048, 1365);
    expect(layout).toMatchObject({ width: 496, height: 336 });
    const box = toInputBox([0, 0, 1, 1], layout);
    expect(box[0]).toBeCloseTo(0);
    expect(box[2]).toBeCloseTo(1);
    // 1365 × (496 / 2048) ≈ 330.6 of 336 rows: centred padding above and below.
    expect(box[1]).toBeCloseTo((336 - 1365 * (496 / 2048)) / 2 / 336, 6);
    expect(box[3]).toBeCloseTo(1 - box[1], 6);
  });
});

describe('describeFixture', () => {
  it('describes a photo toilet from its material, keeping its photo only to read its colour', () => {
    const draft = describeFixture(
      {
        ...base,
        roomPlacement: {
          face: 'floor',
          u: 0.7,
          v: 0.3,
          scale: 1,
          widthMm: 380,
          heightMm: 720,
          imageAspect: 0.5,
          contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
        },
      },
      product({ finish: '유광' }),
      [0.6, 0.7, 0.7, 0.9],
    );
    expect(draft).toMatchObject({
      kind: 'toilet',
      forms: ['floor-standing'],
      face: 'floor',
      finish: 'glossy',
      sizeMm: [380, 720, 690],
      photoAssetId: 'photo',
    });
    expect(draft?.color).toBeUndefined();
    expect(draft?.area).toBeCloseTo(0.02);
  });
  it('describes a standard model from its reconstruction, with its colour and shape', () => {
    const draft = describeFixture(
      {
        ...base,
        reconstruction: {
          version: 2,
          kind: 'basin',
          color: '#F2F1EC',
          widthMm: 600,
          heightMm: 220,
          depthMm: 430,
          basinVariant: 'wall',
          basinShape: 'rectangular',
        },
        roomPlacement: {
          face: 'back',
          u: 0.3,
          v: 0.6,
          scale: 1,
          widthMm: 600,
          heightMm: 220,
          imageAspect: 2,
          contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
        },
      },
      undefined,
      [0.2, 0.5, 0.3, 0.6],
    );
    expect(draft).toMatchObject({
      kind: 'basin',
      forms: ['wall-hung', 'rectangular'],
      face: 'back',
      color: '#f2f1ec',
      finish: 'glossy',
      sizeMm: [600, 220, 430],
    });
    expect(draft?.photoAssetId).toBeUndefined();
  });
  it('ignores tiles and unknown categories', () => {
    expect(describeFixture(base, product({ category: 'tile' }), [0, 0, 0.1, 0.1])).toBeUndefined();
  });
});

describe('ordering and finishes', () => {
  it('puts easily replaced fixtures first, larger first within a kind', () => {
    const order = orderFixtures([
      { kind: 'mirror' as const, area: 0.2, id: 'mirror' },
      { kind: 'toilet' as const, area: 0.01, id: 'small-toilet' },
      { kind: 'basin' as const, area: 0.03, id: 'basin' },
      { kind: 'toilet' as const, area: 0.02, id: 'big-toilet' },
    ]);
    expect(order.map((item) => item.id)).toEqual(['big-toilet', 'small-toilet', 'basin', 'mirror']);
  });
  it('maps finish text, with glazed ceramic and metal defaults when the text says nothing', () => {
    expect(finishCategory('폴리싱')).toBe('polished');
    expect(finishCategory('반광')).toBe('semi-gloss');
    expect(finishCategory('크롬')).toBe('metal');
    expect(finishCategory('무광', 'toilet')).toBe('matte');
    expect(finishCategory('', 'toilet')).toBe('glossy');
    expect(finishCategory('화이트', 'shower')).toBe('metal');
    expect(finishCategory('')).toBe('matte');
  });
});
