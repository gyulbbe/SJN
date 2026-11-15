import { describe, expect, it } from 'vitest';
import {
  FIXTURE_REGION,
  LIGHTNESS_BAND,
  rgbToLab,
  type Pixels,
  type RegionMask,
} from '../src/lib/ai-export/color';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import { restoreFixtureLightness } from '../src/lib/ai-export/fixture-light';
import { fluxResultNotices } from '../src/lib/ai-export/notices';
import type { FluxFixture } from '../src/lib/ai-export/scene-contract';

/**
 * A capture of 240 × 160: a back wall above row 110, a floor below, a white washbasin at x 100–130,
 * y 60–100 and a metal faucet at x 140–150, y 60–80 (docs/fixture-colour-20261115.md).
 */
const W = 240,
  H = 160;
const inBasin = (x: number, y: number) => x >= 100 && x < 130 && y >= 60 && y < 100;
const inFaucet = (x: number, y: number) => x >= 140 && x < 150 && y >= 60 && y < 80;
function capture(): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = inBasin(x, y) ? 215 : inFaucet(x, y) ? 150 : y < 110 ? 230 : 190;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
}
const mask: RegionMask = (() => {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      data[y * W + x] = inBasin(x, y) || inFaucet(x, y) ? FIXTURE_REGION : y < 110 ? 1 : 2;
  return {
    width: W,
    height: H,
    regions: [
      { key: 'face:back', kind: 'wall' },
      { key: 'face:floor', kind: 'floor' },
    ],
    data,
  };
})();
const layout = fluxInputLayout(W, H);
/** Image-0 box of a capture rectangle. */
const box = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [
  (x0 * layout.scale + layout.x) / layout.width,
  (y0 * layout.scale + layout.y) / layout.height,
  (x1 * layout.scale + layout.x) / layout.width,
  (y1 * layout.scale + layout.y) / layout.height,
];
const fixture = (kind: FluxFixture['kind'], b: [number, number, number, number]): FluxFixture => ({
  kind,
  forms: [],
  face: 'back',
  color: '#f2f1ec',
  finish: 'glossy',
  sizeMm: [500, 400, 350],
  box: b,
});
const fixtures = [fixture('basin', box(100, 60, 130, 100)), fixture('faucet', box(140, 60, 150, 80))];
/** The model's answer at twice the input, `basin(x)` the basin's grey at capture column x. */
function answer(basin: (x: number) => number, faucet = 90): Pixels {
  const w = layout.width * 2,
    h = layout.height * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const x = ((u + 0.5) / 2 - layout.x) / layout.scale,
        y = ((v + 0.5) / 2 - layout.y) / layout.scale;
      const value = inBasin(x, y) ? basin(x) : inFaucet(x, y) ? faucet : y < 110 ? 228 : 190;
      data.set([value, value, value, 255], (v * w + u) * 4);
    }
  return { width: w, height: h, data };
}
const at = (image: Pixels, x: number, y: number) => {
  const u = Math.round(x * layout.scale + layout.x) * 2,
    v = Math.round(y * layout.scale + layout.y) * 2;
  const o = (v * image.width + u) * 4;
  return rgbToLab(image.data[o], image.data[o + 1], image.data[o + 2])[0];
};
const run = (result: Pixels) =>
  restoreFixtureLightness({ capture: capture(), mask, layout, fixtures, result, frame: { dx: 0, dy: 0 } });

describe('the white ceramics the model drew much darker (2026-11-15)', () => {
  it('gives a grey washbasin its lightness back and keeps the model’s shading on it', () => {
    // Grey, darker on the left than on the right (the model's shading).
    const result = answer((x) => 110 + (x - 100) * 0.7);
    const done = run(result);
    expect(done.image).toBeDefined();
    const basin = done.fixtures.find((f) => f.kind === 'basin')!;
    expect(basin.added).toBeGreaterThan(15);
    const before = [at(result, 104, 80), at(result, 126, 80)],
      after = [at(done.image!, 104, 80), at(done.image!, 126, 80)];
    expect(after[0] - before[0]).toBeGreaterThan(15);
    // The shading is the model's still: the right side stays lighter by about as much.
    expect(after[1] - after[0]).toBeGreaterThan((before[1] - before[0]) * 0.7);
  });
  it('changes nothing outside the ceramics: walls, floor, the faucet', () => {
    const result = answer(() => 110);
    const done = run(result);
    expect(done.image).toBeDefined();
    const w = result.width;
    for (const [x, y] of [
      [50, 50],
      [200, 130],
      [145, 70],
      [90, 80],
    ]) {
      const u = Math.round(x * layout.scale + layout.x) * 2,
        v = Math.round(y * layout.scale + layout.y) * 2;
      const o = (v * w + u) * 4;
      expect([...done.image!.data.slice(o, o + 3)]).toEqual([...result.data.slice(o, o + 3)]);
    }
    expect(done.fixtures.map((f) => f.kind)).toEqual(['basin']);
  });
  it('takes back only half of a small dimming (the walls’ rule for a light surface), nothing of a lighter one', () => {
    const close = run(answer(() => 212));
    const basin = close.fixtures[0];
    const missing = basin.reference[0] - basin.result[0];
    expect(missing).toBeGreaterThan(0);
    expect(missing).toBeLessThan(LIGHTNESS_BAND);
    expect(basin.added).toBeCloseTo(missing / 2, 5);
    const lighter = run(answer(() => 250));
    expect(lighter.image).toBeUndefined();
    expect(lighter.fixtures[0].added).toBe(0);
  });
  it('does nothing without a ceramic fixture in the facts', () => {
    const done = restoreFixtureLightness({
      capture: capture(),
      mask,
      layout,
      fixtures: [fixtures[1]],
      result: answer(() => 110),
      frame: { dx: 0, dy: 0 },
    });
    expect(done).toEqual({ fixtures: [] });
  });
});

describe('the ceramics notice', () => {
  const colors = { status: 'corrected' as const, warnings: [] };
  it('says how many ceramics got their lightness back, after the colour and joints lines', () => {
    const notices = fluxResultNotices({
      products: [],
      colors,
      corrected: true,
      showTiles: false,
      joints: 2,
      ceramics: 1,
    });
    expect(notices.infos.map((info) => info.key)).toEqual(['color', 'joints', 'ceramics']);
    expect(notices.infos[0].text).toContain('. 제품 모양·유리는 AI 결과 그대로예요.');
    expect(notices.infos[0].text).not.toContain('빛과');
    expect(notices.infos[2].text).toBe(
      'AI가 어둡게 그린 도기(세면대·변기·욕조) 1개는 밝기를 설계 쪽으로 되돌렸어요.',
    );
  });
  it('says nothing about them on the model’s own picture, or when none changed', () => {
    const original = fluxResultNotices({
      products: [],
      colors,
      corrected: false,
      showTiles: false,
      ceramics: 1,
    });
    expect(original.infos.find((info) => info.key === 'ceramics')).toBeUndefined();
    const none = fluxResultNotices({ products: [], colors, corrected: true, showTiles: false, joints: 2 });
    expect(none.infos.map((info) => info.key)).toEqual(['color', 'joints']);
    expect(none.infos[0].text).toContain('. 제품·유리는 AI 결과 그대로예요.');
  });
});
