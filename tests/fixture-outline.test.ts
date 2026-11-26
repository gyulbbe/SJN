import { describe, expect, it } from 'vitest';
import { FIXTURE_REGION, reviewResultColors, type Pixels, type RegionMask } from '../src/lib/ai-export/color';
import { restoreFixtureLightness } from '../src/lib/ai-export/fixture-light';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import { FACE_LIGHTNESS_BAND, refineCurrentResult } from '../src/lib/ai-export/current-refine';
import {
  cropPixels,
  CUT_RESCUE,
  cutoutMask,
  MIN_IOU,
  OUTLINE_PAD,
  outlineCrops,
  type Cut,
} from '../src/lib/ai-export/fixture-outline';
import type { FluxFixture } from '../src/lib/ai-export/scene-contract';

/**
 * The model's fixture outline (docs/fixture-haze-20261116.md, F1), in result pixels: a 120 × 80 result,
 * a back wall above row 60 and a floor below; the render has a toilet at x 40–60, y 20–60. The model
 * drew it 2 px to the right and wider (x 42–64): x 40–42 is the model's wall, x 60–64 its toilet.
 */
const W = 120,
  H = 80;
const regions = [
  { key: 'face:back', kind: 'wall' as const },
  { key: 'face:floor', kind: 'floor' as const },
];
const inRender = (x: number, y: number) => x >= 40 && x < 60 && y >= 20 && y < 60;
const inModel = (x: number, y: number) => x >= 42 && x < 64 && y >= 20 && y < 60;
const face = (y: number) => (y < 60 ? 1 : 2);
function maskOf(fixture: (x: number, y: number) => boolean): RegionMask {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) data[y * W + x] = fixture(x, y) ? FIXTURE_REGION : face(y);
  return { width: W, height: H, regions, data };
}
const renderMask = maskOf(inRender);
const behindMask = maskOf(() => false);
function model(fixture = inModel, tap?: (x: number, y: number) => boolean): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = tap?.(x, y) ? 90 : fixture(x, y) ? 250 : y < 60 ? 200 : 170;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
}
const fact = (kind: FluxFixture['kind'], box: [number, number, number, number]): FluxFixture => ({
  kind,
  forms: [],
  face: 'back',
  color: '#f2f1ec',
  finish: 'glossy',
  sizeMm: [400, 700, 600],
  box,
});
const toilet = fact('toilet', [40 / W, 20 / H, 60 / W, 60 / H]);
/** A cut-out over the crop around `fixture` holding `held` (result pixels). */
function cutOf(fixture: number, facts: readonly FluxFixture[], held: (x: number, y: number) => boolean): Cut {
  const crop = outlineCrops(facts, { width: W, height: H }).find((c) => c.fixture === fixture)!;
  const alpha = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++)
    for (let x = 0; x < crop.width; x++)
      if (held(crop.left + x, crop.top + y)) alpha[y * crop.width + x] = 255;
  return { ...crop, alpha };
}
const label = (mask: RegionMask, x: number, y: number) => mask.data[y * W + x];

describe('the model fixture outline', () => {
  it('crops each fixture box grown by OUTLINE_PAD and skips tiny ones', () => {
    const crops = outlineCrops([toilet, fact('faucet', [0.5, 0.5, 0.5 + 2 / W, 0.5 + 2 / H])], {
      width: W,
      height: H,
    });
    expect(crops).toEqual([
      {
        fixture: 0,
        left: Math.floor(40 - 20 * OUTLINE_PAD),
        top: Math.floor(20 - 40 * OUTLINE_PAD),
        width: Math.ceil(60 + 20 * OUTLINE_PAD) - Math.floor(40 - 20 * OUTLINE_PAD),
        height: Math.ceil(60 + 40 * OUTLINE_PAD) - Math.floor(20 - 40 * OUTLINE_PAD),
      },
    ]);
    const crop = cropPixels(model(), crops[0]);
    expect(crop.width * crop.height * 4).toBe(crop.data.length);
    // The crop's first pixel is the model's pixel at its corner.
    expect([...crop.data.subarray(0, 4)]).toEqual([
      ...model().data.subarray(
        (crops[0].top * W + crops[0].left) * 4,
        (crops[0].top * W + crops[0].left) * 4 + 4,
      ),
    ]);
  });

  it('makes the spilled-over model fixture a fixture and the wall it drew there the face behind', () => {
    const outline = cutoutMask({
      model: model(),
      renderMask,
      behindMask,
      fixtures: [toilet],
      cuts: [cutOf(0, [toilet], inModel)],
    });
    expect(outline.verdicts).toEqual([{ fixture: 0, iou: expect.any(Number), used: true }]);
    expect(outline.verdicts[0].iou).toBeGreaterThanOrEqual(MIN_IOU);
    // Spilled over: fixture in both masks.
    expect(label(outline.mask, 62, 40)).toBe(FIXTURE_REGION);
    expect(label(outline.colourMask, 62, 40)).toBe(FIXTURE_REGION);
    // The model drew wall where the render has its toilet: the wall behind (the joints and colour steps).
    expect(label(outline.mask, 40, 40)).toBe(1);
    expect(label(outline.colourMask, 40, 40)).toBe(1);
    // Both drew the toilet: unchanged.
    expect(label(outline.mask, 50, 40)).toBe(FIXTURE_REGION);
    expect(outline.added).toBe(4 * 40);
    expect(outline.removed).toBeGreaterThan(0);
  });

  it('keeps the render outline for a ceramic whose cut-out missed most of it', () => {
    const outline = cutoutMask({
      model: model(),
      renderMask,
      behindMask,
      fixtures: [toilet],
      cuts: [cutOf(0, [toilet], (x, y) => x >= 42 && x < 46 && y >= 20 && y < 60)],
    });
    expect(outline.verdicts[0].used).toBe(false);
    expect(outline.mask.data).toEqual(renderMask.data);
    expect(outline.colourMask.data).toEqual(renderMask.data);
  });

  it('keeps a tap the model drew in the render outline of a thin fitting, and gives its wall to the face', () => {
    const tapRender = (x: number, y: number) => x >= 80 && x < 90 && y >= 20 && y < 30;
    const mask = maskOf((x, y) => inRender(x, y) || tapRender(x, y));
    const faucet = fact('faucet', [80 / W, 20 / H, 90 / W, 30 / H]);
    // The model's tap is the left half of the render's.
    const tap = (x: number, y: number) => x >= 80 && x < 85 && y >= 20 && y < 30;
    const outline = cutoutMask({
      model: model(inModel, tap),
      renderMask: mask,
      behindMask,
      fixtures: [toilet, faucet],
      cuts: [cutOf(0, [toilet, faucet], inModel)],
    });
    expect(label(outline.mask, 81, 25)).toBe(FIXTURE_REGION);
    expect(label(outline.mask, 88, 25)).toBe(1);
  });
});

describe('the finishing steps of today\x27s method', () => {
  /** The same in capture space: a 240 × 160 capture and the model's answer at twice the input. */
  const CW = 240,
    CH = 160;
  const layout = fluxInputLayout(CW, CH);
  const inBasin = (x: number, y: number) => x >= 100 && x < 130 && y >= 60 && y < 100;
  const captureMask: RegionMask = (() => {
    const data = new Uint8Array(CW * CH);
    for (let y = 0; y < CH; y++)
      for (let x = 0; x < CW; x++) data[y * CW + x] = inBasin(x, y) ? FIXTURE_REGION : y < 110 ? 1 : 2;
    return { width: CW, height: CH, regions, data };
  })();
  const behind: RegionMask = {
    ...captureMask,
    data: captureMask.data.map((v, i) => (v === FIXTURE_REGION ? (Math.floor(i / CW) < 110 ? 1 : 2) : v)),
  };
  const paint = (w: number, h: number, value: (x: number, y: number) => number): Pixels => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = value(x, y);
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    return { width: w, height: h, data };
  };
  const capture = paint(CW, CH, (x, y) => (inBasin(x, y) ? 245 : y < 110 ? 230 : 190));
  const behindImage = paint(CW, CH, (_x, y) => (y < 110 ? 230 : 190));
  // The model drew the basin 6 px narrower on the left, its walls a little darker.
  const raw = paint(layout.width * 2, layout.height * 2, (u, v) => {
    const x = ((u + 0.5) / 2 - layout.x) / layout.scale,
      y = ((v + 0.5) / 2 - layout.y) / layout.scale;
    return x >= 106 && x < 130 && y >= 60 && y < 100 ? 245 : y < 110 ? 214 : 176;
  });
  const basin = fact('basin', [
    (100 * layout.scale + layout.x) / layout.width,
    (60 * layout.scale + layout.y) / layout.height,
    (130 * layout.scale + layout.x) / layout.width,
    (100 * layout.scale + layout.y) / layout.height,
  ]);
  const base = { raw, capture, mask: captureMask, layout, fixtures: [basin] };

  it('is the render-outline result without cut-outs (a failed cut-out changes nothing)', () => {
    const plain = refineCurrentResult(base);
    const failed = refineCurrentResult({ ...base, behind: { image: behindImage, mask: behind } });
    expect(plain.outline).toBeUndefined();
    expect(failed.outline).toBeUndefined();
    expect(plain.shown).toBeDefined();
    expect(failed.shown!.data).toEqual(plain.shown!.data);
    // The steps as the dialog ran them before (no widened joints here: colours, then ceramics).
    // Today's method gives the faces no lightness band (FACE_LIGHTNESS_BAND, 2026-11-25).
    const review = reviewResultColors({
      capture,
      mask: captureMask,
      layout,
      result: raw,
      lightnessBand: FACE_LIGHTNESS_BAND,
    });
    const before =
      restoreFixtureLightness({
        capture,
        mask: captureMask,
        layout,
        fixtures: [basin],
        result: review.corrected ?? raw,
        frame: review.framing,
      }).image ?? review.corrected;
    expect(plain.shown!.data).toEqual(before!.data);
  });

  it('corrects the wall the model drew where the render has its basin', () => {
    const size = { width: raw.width, height: raw.height };
    const crop = outlineCrops([basin], size)[0];
    const alpha = new Uint8Array(crop.width * crop.height);
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++)
        if (raw.data[((crop.top + y) * raw.width + crop.left + x) * 4] === 245)
          alpha[y * crop.width + x] = 255;
    const plain = refineCurrentResult(base);
    const f1 = refineCurrentResult({
      ...base,
      behind: { image: behindImage, mask: behind },
      cuts: [{ ...crop, alpha }],
    });
    expect(f1.outline?.verdicts[0].used).toBe(true);
    expect(f1.outline!.removed).toBeGreaterThan(0);
    // At capture x 102 (the model's wall inside the render's basin) the wall's colour change reaches it.
    const at = (image: Pixels, x: number, y: number) =>
      image.data[
        (Math.round((y * layout.scale + layout.y) * 2) * image.width +
          Math.round((x * layout.scale + layout.x) * 2)) *
          4
      ];
    const wall = at(f1.shown!, 60, 80);
    expect(Math.abs(at(f1.shown!, 102, 80) - wall)).toBeLessThan(
      Math.abs(at(plain.shown!, 102, 80) - at(plain.shown!, 60, 80)),
    );
  });
});

describe('the rescue of a cut-out that fails MIN_IOU (CUT_RESCUE, 2026-11-26)', () => {
  // The crop around the toilet is x 34–66, y 8–72; the rescue here clips at 4 px so the crop has room.
  const rescue = { ...CUT_RESCUE, clipCuts: 4, rescueGuard: { ...CUT_RESCUE.rescueGuard } };
  const run = (held: (x: number, y: number) => boolean, options: object = rescue) =>
    cutoutMask({
      model: model(),
      renderMask,
      behindMask,
      fixtures: [toilet],
      cuts: [cutOf(0, [toilet], held)],
      ...options,
    });
  // A neighbour the cut-out took along: rows 8–20 above the toilet and 6 px on each side.
  const withNeighbour = (x: number, y: number) => (y >= 8 && y < 60 && x >= 34 && x < 66) || inRender(x, y);

  it('uses a failing cut-out once clipped near the render fixture, when it covers it and its top', () => {
    const outline = run(withNeighbour);
    const v = outline.verdicts[0];
    expect(v.iou).toBeLessThan(MIN_IOU);
    expect(v.used).toBe(true);
    expect(v.rescue).toMatchObject({ used: true, recall: 1, top: 1 });
    expect(v.rescue!.iou).toBeGreaterThanOrEqual(CUT_RESCUE.minIou);
    // Without the rescue the same cut-out is not used (today before 2026-11-26).
    expect(run(withNeighbour, {}).verdicts[0].used).toBe(false);
  });

  it('keeps the render outline when the clipped cut-out lost the top quarter (a white tank on a white wall)', () => {
    // The lower three quarters of the toilet, a 6 px strip beside it and junk rows 8–12 far above.
    const lostTank = (x: number, y: number) =>
      (y >= 30 && y < 60 && x >= 40 && x < 66) || (y >= 8 && y < 12 && x >= 34 && x < 66);
    const v = run(lostTank).verdicts[0];
    expect(v.iou).toBeLessThan(MIN_IOU);
    expect(v.rescue!.iou).toBeGreaterThanOrEqual(CUT_RESCUE.minIou);
    expect(v.rescue!.recall).toBeGreaterThanOrEqual(CUT_RESCUE.rescueGuard.recall);
    expect(v.rescue!.top).toBe(0);
    expect(v.used).toBe(false);
  });

  it('keeps the render outline when the clipped cut-out is too large for the fixture', () => {
    const v = run(withNeighbour, { ...rescue, rescueGuard: { ...rescue.rescueGuard, ratio: 1.2 } })
      .verdicts[0];
    expect(v.rescue!.ratio).toBeGreaterThan(1.2);
    expect(v.used).toBe(false);
  });

  it('leaves a cut-out that passes as it is unclipped', () => {
    // Rows 8–14 above the toilet, farther than 4 px: kept, because the plain cut-out passes.
    const above = (x: number, y: number) => inRender(x, y) || (y >= 8 && y < 14 && x >= 40 && x < 60);
    const outline = run(above);
    expect(outline.verdicts[0]).toEqual({ fixture: 0, iou: expect.any(Number), used: true });
    expect(outline.verdicts[0].iou).toBeGreaterThanOrEqual(MIN_IOU);
    expect(run(above, {}).mask.data).toEqual(outline.mask.data);
  });
});
