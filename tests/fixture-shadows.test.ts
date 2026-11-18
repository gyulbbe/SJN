import { describe, expect, it } from 'vitest';
import {
  FIXTURE_REGION,
  projectMask,
  rgbToLab,
  type Pixels,
  type RegionMask,
} from '../src/lib/ai-export/color';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import { BODY_MIN_L, finishFixtureBodies } from '../src/lib/ai-export/fixture-body';
import { finishFixtureEdges, RIM_GAP, RIM_LIFT } from '../src/lib/ai-export/fixture-edge';
import {
  cutoutMask,
  outlineCrops,
  type Cut,
  type FixtureOutline,
} from '../src/lib/ai-export/fixture-outline';
import { OUTLINE_RIMS, restoreJoints } from '../src/lib/ai-export/joints';
import { fluxResultNotices } from '../src/lib/ai-export/notices';
import type { FluxFixture } from '../src/lib/ai-export/scene-contract';

/**
 * The finishing steps added on the model's fixture outline (docs/fixture-shadows-20261118.md): shadow
 * pieces, faces restored up to fixtures and the backdrop, ceramic edges mixed again, ceramic shading
 * narrowed toward the render's. Pictures in result pixels, grey levels as sRGB.
 */
const W = 120,
  H = 80;
const regions = [
  { key: 'face:back', kind: 'wall' as const },
  { key: 'face:floor', kind: 'floor' as const },
];
const grey = (w: number, h: number, value: (x: number, y: number) => number): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = value(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
};
const maskOf = (w: number, h: number, label: (x: number, y: number) => number): RegionMask => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = label(x, y);
  return { width: w, height: h, regions, data };
};
const fact = (kind: FluxFixture['kind'], box: [number, number, number, number]): FluxFixture => ({
  kind,
  forms: [],
  face: 'back',
  color: '#f2f1ec',
  finish: 'glossy',
  sizeMm: [400, 700, 600],
  box,
});
const value = (image: Pixels, x: number, y: number) => image.data[(y * image.width + x) * 4];

describe('shadow pieces in the model fixture outline', () => {
  // The render has a toilet at x 40–60, y 20–60; the model drew it at x 46–60 (its cut-out holds that).
  const inRender = (x: number, y: number) => x >= 40 && x < 60 && y >= 20 && y < 60;
  const held = (x: number, y: number) => x >= 46 && x < 60 && y >= 20 && y < 60;
  const renderMask = maskOf(W, H, (x, y) => (inRender(x, y) ? FIXTURE_REGION : y < 60 ? 1 : 2));
  const behindMask = maskOf(W, H, (_x, y) => (y < 60 ? 1 : 2));
  const toilet = fact('toilet', [40 / W, 20 / H, 60 / W, 60 / H]);
  const cut = (): Cut => {
    const crop = outlineCrops([toilet], { width: W, height: H })[0];
    const alpha = new Uint8Array(crop.width * crop.height);
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++)
        if (held(crop.left + x, crop.top + y)) alpha[y * crop.width + x] = 255;
    return { ...crop, alpha };
  };
  const outline = (piece: number, from = 40) =>
    cutoutMask({
      model: grey(W, H, (x, y) =>
        held(x, y) ? 250 : x >= from && x < 46 && y >= 20 && y < 60 ? piece : y < 60 ? 200 : 170,
      ),
      renderMask,
      behindMask,
      fixtures: [toilet],
      cuts: [cut()],
    });

  it('makes the dark band the model drew beside its fixture the wall behind, though its edge is sharp', () => {
    const shadow = outline(40);
    expect(shadow.mask.data[40 * W + 43]).toBe(1);
    expect(shadow.colourMask.data[40 * W + 43]).toBe(1);
    // A thin band (2 px) too.
    expect(outline(40, 44).mask.data[40 * W + 45]).toBe(1);
  });

  it('keeps a light piece with a drawn outline as the model fixture', () => {
    expect(outline(250).mask.data[40 * W + 43]).toBe(FIXTURE_REGION);
  });
});

describe('faces restored up to the fixtures and the backdrop', () => {
  // One wall (label 1), a fixture at x 20–40 and the backdrop (label 0) from x 56. The model drew a
  // contact shadow on the wall at x 18–19 and left white at x 54–55 where it ended the room short.
  const w = 60,
    h = 40;
  const mask = maskOf(w, h, (x) => (x >= 56 ? 0 : x >= 20 && x < 40 ? FIXTURE_REGION : 1));
  const reference = grey(w, h, (x) => (x >= 56 ? 255 : 200));
  const result = grey(w, h, (x) =>
    x >= 56 ? 255 : x >= 20 && x < 40 ? 240 : x === 18 || x === 19 ? 60 : x === 54 || x === 55 ? 255 : 200,
  );
  const run = (rims?: typeof OUTLINE_RIMS) =>
    restoreJoints(reference, result, mask, new Set([1]), { dx: 0, dy: 0 }, 0.25, rims);

  it('leaves the model contact shadow and the white by the backdrop without rims (the default)', () => {
    const plain = run();
    expect(value(plain, 19, 20)).toBeLessThan(120);
    expect(value(plain, 55, 20)).toBeGreaterThan(225);
  });

  it('restores the face up to them with OUTLINE_RIMS', () => {
    const rimmed = run(OUTLINE_RIMS);
    expect(OUTLINE_RIMS).toEqual({ fixture: 0.5, backdrop: true, faces: true });
    // By the fixture half of the model's pixel stays (a softer contact shadow).
    expect(value(rimmed, 19, 20)).toBeGreaterThan(value(run(), 19, 20) + 30);
    // By the backdrop the face is the restored wall, and its white gives no light.
    expect(value(rimmed, 55, 20)).toBeLessThan(212);
    // The fixture and the backdrop themselves stay as they were.
    expect(value(rimmed, 30, 20)).toBe(240);
    expect(value(rimmed, 58, 20)).toBe(255);
  });
});

describe('the ceramic edges mixed again', () => {
  // A wall (label 1) left of x 30, a basin from x 30 to 70; the cut-out holds x 31– fully and x 30 half.
  const mask = maskOf(W, H, (x) => (x >= 30 && x < 70 ? FIXTURE_REGION : 1));
  const outline: FixtureOutline = {
    mask,
    colourMask: mask,
    verdicts: [{ fixture: 0, iou: 1, used: true }],
    added: 0,
    removed: 0,
  };
  const alpha = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 30; x < 70; x++) alpha[y * W + x] = x === 30 ? 128 : 255;
  const cuts: Cut[] = [{ fixture: 0, left: 0, top: 0, width: W, height: H, alpha }];
  const basin = fact('basin', [30 / W, 0, 70 / W, 1]);

  it('mixes a half-held pixel from the basin and the wall beside it', () => {
    const shown = grey(W, H, (x) => (x === 30 ? 90 : x >= 31 && x < 70 ? 240 : 200));
    const { image, mixed } = finishFixtureEdges({ shown, outline, cuts, fixtures: [basin] });
    expect(mixed).toBe(H);
    expect(Math.abs(value(image, 30, 40) - (240 * 128 + 200 * 127) / 255)).toBeLessThanOrEqual(1);
  });

  it('lifts a dark outline darker than both sides, and leaves the basin inside and the wall alone', () => {
    const shown = grey(W, H, (x) => (x === 31 ? 80 : x >= 30 && x < 70 ? 240 : 200));
    const { image, lifted } = finishFixtureEdges({ shown, outline, cuts, fixtures: [basin] });
    expect(lifted).toBeGreaterThan(0);
    const target = 200 - RIM_GAP;
    expect(Math.abs(value(image, 31, 40) - (80 + RIM_LIFT * (target - 80)))).toBeLessThanOrEqual(6);
    expect(value(image, 50, 40)).toBe(240);
    expect(value(image, 10, 40)).toBe(200);
  });

  it('leaves a thin dark fitting (a tap) with no basin inside near it', () => {
    const thin = maskOf(W, H, (x) => (x >= 30 && x < 32 ? FIXTURE_REGION : 1));
    const thinAlpha = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 30; x < 32; x++) thinAlpha[y * W + x] = 255;
    const shown = grey(W, H, (x) => (x >= 30 && x < 32 ? 70 : 200));
    const { image, lifted } = finishFixtureEdges({
      shown,
      outline: { ...outline, mask: thin, colourMask: thin },
      cuts: [{ fixture: 0, left: 0, top: 0, width: W, height: H, alpha: thinAlpha }],
      fixtures: [basin],
    });
    expect(lifted).toBe(0);
    expect(value(image, 30, 40)).toBe(70);
  });
});

describe('the ceramic shading narrowed toward the render', () => {
  // A capture of 240 × 160 with a basin at x 100–130, y 60–100 (fixture-light.test.ts).
  const cw = 240,
    ch = 160;
  const inBasin = (x: number, y: number) => x >= 100 && x < 130 && y >= 60 && y < 100;
  const mask = maskOf(cw, ch, (x, y) => (inBasin(x, y) ? FIXTURE_REGION : y < 110 ? 1 : 2));
  const layout = fluxInputLayout(cw, ch);
  const box = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [
    (x0 * layout.scale + layout.x) / layout.width,
    (y0 * layout.scale + layout.y) / layout.height,
    (x1 * layout.scale + layout.x) / layout.width,
    (y1 * layout.scale + layout.y) / layout.height,
  ];
  const basin = fact('basin', box(100, 60, 130, 100));
  const capture = (v: number) => grey(cw, ch, (x, y) => (inBasin(x, y) ? v : y < 110 ? 230 : 190));
  // The model's answer at the input size: the basin grey with a dark band down its left third.
  const size = { width: layout.width, height: layout.height };
  const answer = grey(size.width, size.height, (u, v) => {
    const x = (u + 0.5 - layout.x) / layout.scale,
      y = (v + 0.5 - layout.y) / layout.scale;
    return inBasin(x, y) ? (x < 110 ? 60 : 150) : y < 110 ? 228 : 190;
  });
  const resultMask = projectMask(mask, layout, size);
  const L = (image: Pixels, i: number) =>
    rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2])[0];
  const inside = (image: Pixels, x: number, y: number) =>
    Math.round(y * layout.scale + layout.y) * image.width + Math.round(x * layout.scale + layout.x);

  it('raises a grey ceramic to the render median and narrows its dark band, the wall untouched', () => {
    const { image, fixtures } = finishFixtureBodies({
      result: answer,
      capture: capture(215),
      mask,
      layout,
      fixtures: [basin],
      resultMask,
    });
    expect(image).toBeDefined();
    expect(fixtures).toEqual([
      expect.objectContaining({ kind: 'basin', dark: 0.5, raised: expect.any(Number) }),
    ]);
    const renderL = rgbToLab(215, 215, 215)[0];
    expect(Math.abs(L(image!, inside(image!, 120, 80)) - renderL)).toBeLessThan(1.5);
    // The band stays darker, by half as much.
    const before = L(answer, inside(answer, 120, 80)) - L(answer, inside(answer, 104, 80));
    const after = L(image!, inside(image!, 120, 80)) - L(image!, inside(image!, 104, 80));
    expect(after).toBeGreaterThan(before * 0.4);
    expect(after).toBeLessThan(before * 0.6);
    expect(L(image!, inside(image!, 50, 30))).toBe(L(answer, inside(answer, 50, 30)));
  });

  it('leaves a ceramic the render shows dark', () => {
    expect(rgbToLab(60, 60, 60)[0]).toBeLessThan(BODY_MIN_L);
    const { image, fixtures } = finishFixtureBodies({
      result: answer,
      capture: capture(60),
      mask,
      layout,
      fixtures: [basin],
      resultMask,
    });
    expect(image).toBeUndefined();
    expect(fixtures).toEqual([]);
  });
});

describe('the ceramics notice with the shading step', () => {
  it('says the shading was lightened', () => {
    const notices = fluxResultNotices({
      products: [],
      colors: { status: 'corrected', warnings: [] },
      corrected: true,
      showTiles: false,
      joints: 2,
      ceramics: 2,
      ceramicShading: true,
    });
    expect(notices.infos.find((info) => info.key === 'ceramics')?.text).toBe(
      '도기(세면대·변기·욕조) 2개는 AI가 칠한 회색·진한 그늘을 설계 밝기 쪽으로 옅게 했어요.',
    );
  });
});
