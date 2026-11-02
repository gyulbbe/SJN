import { describe, expect, it } from 'vitest';
import {
  budgetCheck,
  callNeurons,
  gemmaBox,
  matchBoxes,
  patternNeighbours,
  positionScore,
  rankOf,
  thirdOf,
  topN,
} from './catalog-match/score';
import {
  applyHomography,
  cleanRectangle,
  colourFeatures,
  deltaE2000,
  invertHomography,
  rgbToLab,
  sizeDistance,
  squareToQuad,
  textureFeatures,
  type Quad,
} from './catalog-match/tile-features';

describe('catalog-match scoring', () => {
  it('counts top-N hits from ranks', () => {
    expect(rankOf(['a', 'b', 'c'], (id) => id === 'c')).toBe(3);
    expect(rankOf(['a'], (id) => id === 'z')).toBe(Infinity);
    expect(topN([1, 3, 7, 30])).toEqual({ 1: 0.25, 5: 0.5, 20: 0.75, n: 4 });
  });
  it('counts a same-pattern hit from pairs, never chained', () => {
    const same = patternNeighbours(
      ['a', 'b', 'c', 'd'],
      [
        ['b', 'a'],
        ['c', 'b'],
      ],
    );
    expect([...same.get('b')!].sort()).toEqual(['a', 'b', 'c']);
    // a–b and b–c do not make a–c.
    expect(same.get('a')!.has('c')).toBe(false);
    const strict = rankOf(['b', 'x'], (id) => id === 'a');
    const pattern = rankOf(['b', 'x'], (id) => same.get('a')!.has(id));
    expect([strict, pattern]).toEqual([Infinity, 1]);
  });
  it('matches boxes one to one by kind and IoU', () => {
    const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
    const truth = [
      { kind: 'toilet', box: box(0, 0, 0.4, 0.4) },
      { kind: 'basin', box: box(0.5, 0.5, 0.9, 0.9) },
    ];
    const predicted = [
      { kind: 'toilet', box: box(0, 0, 0.4, 0.38) },
      { kind: 'toilet', box: box(0, 0, 0.38, 0.4) },
      { kind: 'bath', box: box(0.5, 0.5, 0.9, 0.9) },
    ];
    const result = matchBoxes(truth, predicted);
    expect(result.hits).toHaveLength(1);
    expect(result.misses.map((t) => t.kind)).toEqual(['basin']);
    expect(result.extras).toHaveLength(2);
  });
  it('turns Gemma [ymin,xmin,ymax,xmax] 0–1000 into a box', () => {
    expect(gemmaBox([100, 200, 500, 900])).toEqual({ left: 0.2, top: 0.1, right: 0.9, bottom: 0.5 });
  });
  it('scores walls, thirds and left-right order', () => {
    expect(thirdOf(0.1)).toBe('left');
    expect(thirdOf(0.5)).toBe('middle');
    const score = positionScore(
      [
        { id: 't', wall: 'back', u: 0.2 },
        { id: 'b', wall: 'back', u: 0.8 },
        { id: 'x', wall: 'unknown' },
        { id: 'w', wall: 'left', u: 0.5 },
      ],
      [
        { id: 't', wall: 'back', u: 0.1 },
        { id: 'b', wall: 'back', u: 0.5 },
        { id: 'w', wall: 'right', u: 0.5 },
      ],
    );
    expect(score.known).toBe(3);
    expect(score.sameWall).toBeCloseTo(2 / 3);
    expect(score.sameThird).toBeCloseTo(1 / 2);
    expect(score.order).toBe(1);
  });
  it('estimates neurons from the listed price', () => {
    // Gemma: $0.10 / M in, $0.30 / M out → 1,500 in + 200 out = $0.00021 ≈ 19.1 neurons.
    expect(callNeurons({ inputPerM: 0.1, outputPerM: 0.3 }, 1500, 200)).toBeCloseTo(19.09, 1);
    expect(callNeurons({ inputPerM: 0.038 }, 1000, 500)).toBeCloseTo(3.45, 1);
  });
  it('refuses a call past 90% of the budget or past the account’s day', () => {
    const rows = [
      { at: '2026-11-02T01:00:00Z', account: 'own', neurons: 7000, status: 200 },
      { at: '2026-11-02T02:00:00Z', account: 'own', neurons: 900, status: 'refused' },
      // A failed call counts (it may be billed).
      { at: '2026-11-01T02:00:00Z', account: 'own', neurons: 1000, status: 500 },
    ];
    const limits = { budget: 15000, accountDaily: 7500 };
    const at = '2026-11-02T03:00:00Z';
    expect(budgetCheck(rows, { account: 'own', at, cost: 400 }, limits).ok).toBe(true);
    // The account's day: 7,000 + 600 > 7,500.
    expect(budgetCheck(rows, { account: 'own', at, cost: 600 }, limits).ok).toBe(false);
    expect(budgetCheck(rows, { account: 'extra-1', at, cost: 600 }, limits).ok).toBe(true);
    // The whole trial: 8,000 + 200 > 90% of 9,000.
    expect(budgetCheck(rows, { account: 'extra-1', at, cost: 200 }, { ...limits, budget: 9000 }).ok).toBe(
      false,
    );
  });
});

describe('catalog-match tile features', () => {
  it('converts colours to Lab and measures CIEDE2000', () => {
    const white = rgbToLab(255, 255, 255);
    expect(white[0]).toBeCloseTo(100, 1);
    expect(Math.abs(white[1])).toBeLessThan(0.01);
    // Sharma et al. 2005 test pair 1.
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
  });
  it('separates two tiles by colour and texture', () => {
    const solid = (r: number, g: number, b: number, stripe = false) => {
      const data = new Uint8ClampedArray(32 * 32 * 4);
      for (let i = 0; i < 32 * 32; i++) {
        const dark = stripe && i % 32 < 16;
        data.set([dark ? r / 2 : r, dark ? g / 2 : g, dark ? b / 2 : b, 255], i * 4);
      }
      return { data, width: 32, height: 32 };
    };
    const grey = colourFeatures(solid(128, 128, 128));
    expect(grey.hist[0].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(textureFeatures(solid(128, 128, 128)).contrast).toBe(0);
    expect(textureFeatures(solid(128, 128, 128, true)).contrast).toBeGreaterThan(0.05);
  });
  it('keeps the size score weak and symmetric in orientation', () => {
    expect(sizeDistance({ widthMm: 600, heightMm: 300 }, { widthMm: 300, heightMm: 600 })).toBe(0);
    expect(sizeDistance({ widthMm: 600, heightMm: 600 }, undefined)).toBe(0);
    expect(sizeDistance({ widthMm: 1800, heightMm: 1800 }, { widthMm: 600, heightMm: 600 })).toBeCloseTo(1);
  });
  it('maps the unit square to a quad and back, and finds the clean rectangle', () => {
    const quad: Quad = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.2 },
      { x: 0.8, y: 0.9 },
      { x: 0.2, y: 0.8 },
    ];
    const m = squareToQuad(quad);
    expect(applyHomography(m, { x: 1, y: 1 })).toMatchObject({
      x: expect.closeTo(0.8),
      y: expect.closeTo(0.9),
    });
    const back = applyHomography(invertHomography(m), { x: 0.9, y: 0.2 });
    expect(back.x).toBeCloseTo(1);
    expect(back.y).toBeCloseTo(0);
    // A product over the right half leaves the left part.
    const rect = cleanRectangle(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      [{ left: 0.5, top: 0, right: 1, bottom: 1 }],
      { grid: 10, frameMargin: 0 },
    )!;
    expect(rect.u0).toBe(0);
    expect(rect.u1).toBeCloseTo(0.5);
    expect(rect.v1 - rect.v0).toBeCloseTo(1);
  });
});
