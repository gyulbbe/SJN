import { describe, expect, it } from 'vitest';
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../src/lib/ai-export/color';
import { BATH_WALL_LIKE, cutoutMask, outlineCrops, type Cut } from '../src/lib/ai-export/fixture-outline';
import type { FluxFixture } from '../src/lib/ai-export/scene-contract';

/**
 * docs/big-fixture-edges-20261124.md, in result pixels: a 120 × 80 result, a back wall above row 70 and a
 * floor below. The render has a big fixture at x 40–80, y 30–60; the model drew it lower, from row 36
 * (the cut-out holds x 40–80, y 36–60), and in the band y 30–36 drew `band` (its wall, or a shade).
 */
const W = 120,
  H = 80;
const regions = [
  { key: 'face:back', kind: 'wall' as const },
  { key: 'face:floor', kind: 'floor' as const },
];
const inRender = (x: number, y: number) => x >= 40 && x < 80 && y >= 30 && y < 60;
const inModel = (x: number, y: number) => x >= 40 && x < 80 && y >= 36 && y < 60;
const inBand = (x: number, y: number) => x >= 40 && x < 80 && y >= 30 && y < 36;
function maskOf(fixture: (x: number, y: number) => boolean): RegionMask {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) data[y * W + x] = fixture(x, y) ? FIXTURE_REGION : y < 70 ? 1 : 2;
  return { width: W, height: H, regions, data };
}
const renderMask = maskOf(inRender);
const behindMask = maskOf(() => false);
function model(band: number): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = inModel(x, y) ? 250 : inBand(x, y) ? band : y < 70 ? 200 : 170;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
}
const fact = (kind: FluxFixture['kind'], box: [number, number, number, number]): FluxFixture => ({
  kind,
  forms: [],
  face: 'floor',
  color: '#f2f1ec',
  finish: 'glossy',
  sizeMm: [1500, 560, 750],
  box,
});
function cutOf(facts: readonly FluxFixture[]): Cut {
  const crop = outlineCrops(facts, { width: W, height: H })[0];
  const alpha = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++)
      if (inModel(crop.left + x, crop.top + y)) alpha[y * crop.width + x] = 255;
  return { ...crop, alpha };
}
const at = (mask: RegionMask, x: number, y: number) => mask.data[y * W + x];

describe('big fixture edges (2026-11-24)', () => {
  it('is a bath-only colour rule at 70', () => {
    expect(BATH_WALL_LIKE).toEqual({ kinds: ['bath'], near: 70 });
  });

  it('gives a band no box holds to the moved box: the wall the model drew there becomes the wall', () => {
    // The render mask was moved up 4 px with the model's room; the fact's box was not (it starts at 34).
    const bath = fact('bath', [40 / W, 34 / H, 80 / W, 60 / H]);
    const moved = fact('bath', [40 / W, 30 / H, 80 / W, 56 / H]);
    const base = { model: model(200), renderMask, behindMask, cuts: [cutOf([bath])] };
    const before = cutoutMask({ ...base, fixtures: [bath] });
    // Rows 30–33 belong to no box: they stayed fixture, the model's pixels kept (the grey bar).
    expect(at(before.mask, 60, 31)).toBe(FIXTURE_REGION);
    const after = cutoutMask({ ...base, fixtures: [bath], movedFixtures: [moved] });
    expect(at(after.mask, 60, 31)).toBe(1);
    // A pixel today's box holds keeps today's owner and verdict.
    expect(at(after.mask, 60, 34)).toBe(at(before.mask, 60, 34));
    expect(at(after.mask, 60, 45)).toBe(FIXTURE_REGION);
  });

  it("makes a bath's piece the colour of the wall wall, while a toilet keeps the line rule", () => {
    // A shade 35 darker than the wall: a line all along its border with the wall, so by lines a fixture.
    for (const kind of ['bath', 'toilet'] as const) {
      const f = fact(kind, [40 / W, 30 / H, 80 / W, 60 / H]);
      const base = { model: model(165), renderMask, behindMask, fixtures: [f], cuts: [cutOf([f])] };
      const lines = cutoutMask(base);
      expect(at(lines.mask, 60, 32)).toBe(FIXTURE_REGION);
      const rule = cutoutMask({ ...base, wallLike: BATH_WALL_LIKE });
      expect(at(rule.mask, 60, 32)).toBe(kind === 'bath' ? 1 : FIXTURE_REGION);
      // The fixture the cut-out holds stays.
      expect(at(rule.mask, 60, 45)).toBe(FIXTURE_REGION);
    }
  });

  it('keeps a white bath piece far from a darker wall a fixture', () => {
    const f = fact('bath', [40 / W, 30 / H, 80 / W, 60 / H]);
    const rule = cutoutMask({
      model: model(250),
      renderMask,
      behindMask,
      fixtures: [f],
      cuts: [cutOf([f])],
      wallLike: BATH_WALL_LIKE,
    });
    // 250 against a 200 wall: 87 apart in sRGB, beyond 70.
    expect(at(rule.mask, 60, 32)).toBe(FIXTURE_REGION);
  });
});
