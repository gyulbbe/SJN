import { describe, expect, it } from 'vitest';
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../src/lib/ai-export/color';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import type { Cut } from '../src/lib/ai-export/fixture-outline';
import {
  METAL_BANDS,
  METAL_RATIO,
  metalCeramics,
  metalScores,
  pasteRenderFixtures,
  trimProtrusions,
} from '../src/lib/ai-export/fixture-shape';
import { fluxResultNotices } from '../src/lib/ai-export/notices';
import type { FluxFixture } from '../src/lib/ai-export/scene-contract';

/**
 * The fixture-shape fixes of today's method (docs/fixture-shape-20261120.md): T1 takes a thin piece
 * sticking up out of a fixture (an invented tap) out of its cut-out; P1 puts a ceramic the model drew as
 * metal back as the render's.
 */
const regions = [{ key: 'face:back', kind: 'wall' as const }];
const maskOf = (w: number, h: number, label: (x: number, y: number) => number): RegionMask => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = label(x, y);
  return { width: w, height: h, regions, data };
};
const fact = (kind: FluxFixture['kind'], box: [number, number, number, number]): FluxFixture => ({
  kind,
  forms: [],
  face: 'back',
  color: '#ffffff',
  finish: 'glossy',
  sizeMm: [500, 850, 400],
  box,
});

describe('T1: a thin piece sticking up out of a fixture leaves its cut-out', () => {
  // A 200 × 120 result (far: 4 px); the render's basin at x 80–120, y 60–100.
  const W = 200,
    H = 120;
  const inBasin = (x: number, y: number) => x >= 80 && x < 120 && y >= 60 && y < 100;
  const renderMask = maskOf(W, H, (x, y) => (inBasin(x, y) ? FIXTURE_REGION : 1));
  const basin = fact('basin', [80 / W, 60 / H, 120 / W, 100 / H]);
  // The model's cut-out: the basin and what `extra` adds.
  const cut = (extra: (x: number, y: number) => boolean): Cut => {
    const crop = { fixture: 0, left: 60, top: 10, width: 80, height: 100 };
    const alpha = new Uint8Array(crop.width * crop.height);
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++) {
        const px = crop.left + x,
          py = crop.top + y;
        if (inBasin(px, py) || extra(px, py)) alpha[y * crop.width + x] = 255;
      }
    return { ...crop, alpha };
  };
  const held = (c: Cut, x: number, y: number) => c.alpha[(y - c.top) * c.width + x - c.left] >= 128;

  it('takes out a tap 4 px wide and 30 px tall over the basin, down to its rim', () => {
    const tap = (x: number, y: number) => x >= 98 && x < 102 && y >= 30 && y < 60;
    const { cuts, trimmed } = trimProtrusions({ cuts: [cut(tap)], renderMask, fixtures: [basin] });
    expect(trimmed).toEqual([expect.objectContaining({ fixture: 0, width: 4 })]);
    for (let y = 30; y < 60; y++) expect(held(cuts[0], 100, y)).toBe(false);
    // The basin itself stays.
    expect(held(cuts[0], 100, 60)).toBe(true);
    expect(held(cuts[0], 81, 99)).toBe(true);
  });

  it('keeps a wide bump, a flush button of a few px and a piece beside the fixture', () => {
    const wide = (x: number, y: number) => x >= 85 && x < 115 && y >= 40 && y < 60;
    const button = (x: number, y: number) => x >= 90 && x < 93 && y >= 57 && y < 60;
    const beside = (x: number, y: number) => x >= 120 && x < 135 && y >= 70 && y < 73;
    for (const extra of [wide, button, beside]) {
      const original = cut(extra);
      const { cuts, trimmed } = trimProtrusions({ cuts: [original], renderMask, fixtures: [basin] });
      expect(trimmed).toEqual([]);
      expect(cuts[0]).toBe(original);
    }
  });

  it('keeps a piece too short to be a tap (under 1% of the width tall)', () => {
    const short = (x: number, y: number) => x >= 98 && x < 102 && y >= 54 && y < 60;
    // Reaches 6 px from the basin, but its far part (more than 4 px away) is 2 px tall.
    const { trimmed } = trimProtrusions({ cuts: [cut(short)], renderMask, fixtures: [basin] });
    expect(trimmed).toEqual([]);
  });
});

describe('P1: a ceramic the model drew as metal goes back as the render', () => {
  // A 496 × 336 capture (its input layout is the result's own grid); a basin at x 200–240, y 100–260.
  const W = 496,
    H = 336;
  const layout = fluxInputLayout(W, H);
  const inBasin = (x: number, y: number) => x >= 200 && x < 240 && y >= 100 && y < 260;
  const mask = maskOf(W, H, (x, y) => (inBasin(x, y) ? FIXTURE_REGION : 1));
  const basin = fact('basin', [200 / W, 100 / H, 240 / W, 260 / H]);
  const image = (value: (x: number, y: number) => number): Pixels => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = value(x, y);
        data.set([v, v, v, 255], (y * W + x) * 4);
      }
    return { width: W, height: H, data };
  };
  // The render: a plain white basin on a grey wall.
  const capture = image((x, y) => (inBasin(x, y) ? 240 : 150));

  it('scores chrome bands only on a ceramic drawn as metal', () => {
    const chrome = image((x, y) => (inBasin(x, y) ? (Math.floor(x / 4) % 2 ? 230 : 60) : 150));
    const plain = image((x, y) => (inBasin(x, y) ? 235 : 150));
    const input = { colourMask: mask, capture, mask, layout, fixtures: [basin] };
    const metal = metalScores({ ...input, shown: chrome });
    expect(metal[0].bands).toBeGreaterThan(METAL_BANDS);
    expect(metal[0].ratio).toBeGreaterThan(METAL_RATIO);
    expect([...metalCeramics(metal)]).toEqual([0]);
    expect([...metalCeramics(metalScores({ ...input, shown: plain }))]).toEqual([]);
  });

  it("puts the render's pixels in the model's light at the fixture only", () => {
    // The model's light is 0.8 × the render's on the wall; what it drew in the basin is dark metal.
    const shown = image((x, y) => (inBasin(x, y) ? 70 : 132));
    const out = pasteRenderFixtures({
      shown,
      capture,
      mask,
      layout,
      fixtures: [basin],
      metal: new Set([0]),
      dx: 0,
      dy: 0,
    });
    const at = (x: number, y: number) => out.data[(y * W + x) * 4];
    // 150 → 132 in sRGB is about 0.78 × in linear light; the basin's 240 by the same gain.
    expect(at(220, 180)).toBeGreaterThan(205);
    expect(at(220, 180)).toBeLessThan(225);
    expect(at(100, 50)).toBe(132);
    // Nothing chosen: the picture stays.
    const none = pasteRenderFixtures({
      shown,
      capture,
      mask,
      layout,
      fixtures: [basin],
      metal: new Set(),
      dx: 0,
      dy: 0,
    });
    expect(none.data).toEqual(shown.data);
  });
});

describe('the shapes notice', () => {
  const base = {
    products: [],
    colors: { status: 'corrected' as const, warnings: [] },
    showTiles: false,
    joints: 2,
    ceramics: 1,
  };
  it('says what P1 and T1 changed, after the colour, joints and ceramics lines', () => {
    const notices = fluxResultNotices({ ...base, corrected: true, shapes: { metal: 1, trimmed: 2 } });
    const keys = notices.infos.map((info) => info.key);
    expect(keys.indexOf('shapes')).toBe(keys.indexOf('ceramics') + 1);
    expect(notices.infos.find((info) => info.key === 'shapes')?.text).toBe(
      'AI가 금속 물건처럼 그린 도기 1개는 설계 그림의 도기로 되돌렸어요. 제품 위로 가늘게 솟은 것(AI가 지어낸 수전 등) 2개는 지우고 벽으로 되돌렸어요.',
    );
  });
  it('says nothing with the model picture shown or nothing changed', () => {
    for (const notices of [
      fluxResultNotices({ ...base, corrected: false, shapes: { metal: 1, trimmed: 0 } }),
      fluxResultNotices({ ...base, corrected: true, shapes: { metal: 0, trimmed: 0 } }),
      fluxResultNotices({ ...base, corrected: true }),
    ])
      expect(notices.infos.some((info) => info.key === 'shapes')).toBe(false);
  });
});
