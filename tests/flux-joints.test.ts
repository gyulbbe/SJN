import { describe, expect, it } from 'vitest';
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../src/lib/ai-export/color';
import { composeFluxResult, type RoomLayers } from '../src/lib/ai-export/composite';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import {
  inputPxPerMm,
  JOINT_MIN_INPUT_PX,
  RESTORE_LIGHT_KEEP,
  restoreResultJoints,
  widenedJointMm,
  widenJoints,
  type FaceToFrame,
} from '../src/lib/ai-export/joints';
import { fluxResultNotices } from '../src/lib/ai-export/notices';
import { DEFAULT_TILE, type RenderSnapshot } from '../src/lib/types';

/** A capture of 240 × 160: a tiled back wall above row 110 (joints every `period` px), a plain floor below. */
const W = 240,
  H = 160;
function capture(period: number, joint = 1, wallTone = 230): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const wall = y < 110;
      const line = wall && period > 0 && (x % period < joint || y % period < joint);
      const v = line ? 150 : wall ? wallTone : 190;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
}
const mask = (fixture = false): RegionMask => {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      data[y * W + x] =
        fixture && x >= 100 && x < 130 && y >= 60 && y < 100 ? FIXTURE_REGION : y < 110 ? 1 : 2;
  return {
    width: W,
    height: H,
    regions: [
      { key: 'face:back', kind: 'wall' },
      { key: 'face:floor', kind: 'floor' },
    ],
    data,
  };
};
const layout = fluxInputLayout(W, H);
/** The model's answer at twice the input: a capture-like picture `draw(x, y)` in capture coordinates. */
function answer(draw: (x: number, y: number) => number): Pixels {
  const w = layout.width * 2,
    h = layout.height * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const x = ((u + 0.5) / 2 - layout.x) / layout.scale,
        y = ((v + 0.5) / 2 - layout.y) / layout.scale;
      const value = draw(x, y);
      data.set([value, value, value, 255], (v * w + u) * 4);
    }
  return { width: w, height: h, data };
}
const tiled = (period: number, extra?: (x: number, y: number) => number | undefined) =>
  answer((x, y) => {
    const own = extra?.(x, y);
    if (own !== undefined) return own;
    if (y >= 110) return 190;
    return x % period < 1.5 || y % period < 1.5 ? 160 : 228;
  });
const frame = { dx: 0, dy: 0 };
/** Mean luminance of an answer-sized picture over a capture-coordinate rectangle. */
function mean(image: Pixels, x0: number, y0: number, x1: number, y1: number) {
  let sum = 0,
    n = 0;
  for (let v = y0 * 2; v < y1 * 2; v++)
    for (let u = x0 * 2; u < x1 * 2; u++) {
      sum += image.data[(v * image.width + u) * 4];
      n++;
    }
  return sum / n;
}

describe('the widened capture', () => {
  it('draws every joint at least the width that is 1.25 input pixels, and keeps a joint-less surface so', () => {
    expect(widenedJointMm(0.0988)).toBe(Math.ceil(JOINT_MIN_INPUT_PX / 0.0988));
    expect(widenedJointMm(0)).toBe(10);
    const surface = (id: string, groutWidth: number) =>
      ({ id, tile: { ...DEFAULT_TILE, groutWidth } }) as RenderSnapshot['scene']['surfaces'][number];
    const snapshot = {
      scene: { surfaces: [surface('a', 2), surface('b', 0), surface('c', 20)] },
      beforeScene: { surfaces: [surface('a', 2)] },
      materials: {},
    } as unknown as RenderSnapshot;
    const widened = widenJoints(snapshot, 13);
    expect(widened.scene.surfaces.map((s) => s.tile.groutWidth)).toEqual([13, 0, 20]);
    // Only a copy changes: the snapshot the model's input was drawn from, and the Before, stay.
    expect(snapshot.scene.surfaces.map((s) => s.tile.groutWidth)).toEqual([2, 0, 20]);
    expect(widened.beforeScene).toBe(snapshot.beforeScene);
  });
  it('measures the input scale on the wall seen most squarely, skipping hidden walls', () => {
    const room = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };
    // The back wall spans 0.3–0.7 across and 0.2–0.8 up of a 1000 × 500 frame; the side walls are foreshortened.
    const toFrame: FaceToFrame = (face, u, v) =>
      face === 'back'
        ? { x: 0.3 + 0.4 * u, y: 0.2 + 0.6 * v }
        : face === 'left'
          ? { x: 0.1 + 0.2 * u, y: 0.1 + 0.8 * v }
          : null;
    // Back: across 400 px / 2400 mm, up 300 px / 2400 mm → 0.125; left: across ~0.083 → 0.083.
    expect(inputPxPerMm(toFrame, room, { width: 1000, height: 500 }, 0.5)).toBeCloseTo(0.0625, 4);
    expect(inputPxPerMm(() => null, room, { width: 1000, height: 500 }, 0.5)).toBe(0);
  });
});

describe('putting drifted joints back', () => {
  const joints = capture(24, 3);
  it('restores a wall the model re-laid at another size, and leaves the joint-less floor and fixtures alone', () => {
    const relaid = tiled(34);
    const done = restoreResultJoints({
      capture: capture(24),
      joints,
      mask: mask(),
      layout,
      result: relaid,
      frame,
    });
    expect(done.restored.map((face) => face.key)).toEqual(['face:back']);
    expect(done.image).toBeDefined();
    // The design's joint is back where the model had a tile: column 24 is darker than its middle.
    expect(mean(done.image!, 24, 20, 25, 100)).toBeLessThan(mean(done.image!, 12, 20, 13, 100) - 20);
    // The floor (not restored) is the model's, pixel for pixel.
    const at = (image: Pixels, x: number, y: number) => image.data[(y * 2 * image.width + x * 2) * 4];
    expect(at(done.image!, 50, 130)).toBe(at(relaid, 50, 130));
    const kept = restoreResultJoints({
      capture: capture(24),
      joints,
      mask: mask(),
      layout,
      result: tiled(24),
      frame,
    });
    // A wall that kept its joints is restored too (2026-11-15): its tiles may have lost their pattern.
    // The model had drawn the design's joints, so the restored wall stays close to its own picture.
    expect(kept.restored.map((face) => face.key)).toEqual(['face:back']);
    expect(kept.image).toBeDefined();
    expect(Math.abs(mean(kept.image!, 30, 20, 60, 100) - mean(tiled(24), 30, 20, 60, 100))).toBeLessThan(6);
    // Restoring only drifted faces is still possible (the rule before 2026-11-15).
    const before = restoreResultJoints({
      capture: capture(24),
      joints,
      mask: mask(),
      layout,
      result: tiled(24),
      frame,
      restoreBelow: 0.3,
    });
    expect(before.restored).toEqual([]);
    expect(before.image).toBeUndefined();
  });
  it('lets a dark object the model added go instead of leaving a smudge, and keeps a shadow the render has too', () => {
    // The render has a shadow at x 30–60, y 60–100; the model drew it too, and added a dark box at x 172–182.
    const shadowed = (tone: number) => (x: number, y: number) =>
      x >= 30 && x < 60 && y >= 60 && y < 100 ? Math.round(tone * 0.6) : undefined;
    const reference = capture(24);
    for (let y = 60; y < 100; y++)
      for (let x = 30; x < 60; x++) {
        const o = (y * W + x) * 4;
        const v = Math.round(reference.data[o] * 0.6);
        reference.data.set([v, v, v, 255], o);
      }
    const result = tiled(34, (x, y) => (x >= 172 && x < 182 && y >= 40 && y < 50 ? 40 : shadowed(228)(x, y)));
    const done = restoreResultJoints({ capture: reference, joints, mask: mask(), layout, result, frame });
    expect(done.image).toBeDefined();
    const wall = mean(done.image!, 140, 20, 160, 40);
    // The box is gone: its place is as light as the wall beside it, not a dark blur.
    expect(mean(done.image!, 172, 40, 182, 50)).toBeGreaterThan(wall - 15);
    // The shadow stays.
    expect(mean(done.image!, 35, 65, 55, 95)).toBeLessThan(wall - 50);
  });
  it('keeps only a quarter of light the render does not have, and leaves even light and other faces as they were', () => {
    expect(RESTORE_LIGHT_KEEP).toBe(0.25);
    // The model drew a broad shadow band (x 60–120) across the wall the render lights evenly.
    const banded = tiled(24, (x, y) =>
      y < 110 && x >= 60 && x < 120
        ? Math.round((x % 24 < 1.5 || y % 24 < 1.5 ? 160 : 228) * 0.6)
        : undefined,
    );
    const run = (result: Pixels, lightKeep?: number) =>
      restoreResultJoints({ capture: capture(24), joints, mask: mask(), layout, result, frame, lightKeep })
        .image!;
    const band = (image: Pixels) => mean(image, 70, 20, 110, 100) / mean(image, 160, 20, 200, 100);
    // The model's light as it is (1, the rule before 2026-11-15): the band stays at about 0.6.
    expect(band(run(banded, 1))).toBeLessThan(0.7);
    // A quarter of it (in log): 0.6^0.25 ≈ 0.88.
    const softened = run(banded);
    expect(band(softened)).toBeGreaterThan(0.84);
    expect(band(softened)).toBeLessThan(0.95);
    // The floor (not restored) is the model's, pixel for pixel.
    const floor = (image: Pixels) => image.data.slice(image.width * 4 * 2 * 115);
    expect(floor(softened)).toEqual(floor(banded));
    // Even light has next to nothing to soften: a quarter and all of it give almost the same picture
    // (the blurs of the model's and the render's joints differ a little near the wall's rim).
    const even = tiled(24);
    const a = run(even),
      b = run(even, 1);
    let most = 0;
    for (let i = 0; i < a.data.length; i++) most = Math.max(most, Math.abs(a.data[i] - b.data[i]));
    expect(most).toBeLessThanOrEqual(6);
    expect(Math.abs(mean(a, 10, 10, 230, 100) - mean(b, 10, 10, 230, 100))).toBeLessThan(1);
  });
});

describe('the composite with joints', () => {
  it('puts the joints back on the model room and keeps the uncorrected composite as it came', () => {
    // Re-laid at 40 px: no horizontal joint near the floor line, so the floor line is found.
    const n = W * H;
    const empty = capture(24);
    const room = Uint8ClampedArray.from(empty.data);
    const coverage = new Uint8Array(n);
    for (let y = 60; y < 100; y++) for (let x = 100; x < 130; x++) coverage[y * W + x] = 255;
    const full = Uint8ClampedArray.from(room);
    for (let i = 0; i < n; i++) if (coverage[i]) full.set([240, 238, 236, 255], i * 4);
    const layers: RoomLayers = { width: W, height: H, full, shadowed: room, empty: room, coverage };
    const box: [number, number, number, number] = [100 / W, 60 / H, 130 / W, 100 / H];
    const base = { input: empty, layers, mask: mask(true), layout, boxes: [box] };
    const without = composeFluxResult({ ...base, result: tiled(40) });
    const withJoints = composeFluxResult({ ...base, result: tiled(40), joints: capture(24, 3) });
    expect(without.joints).toBeUndefined();
    expect(withJoints.joints?.restored.map((face) => face.key)).toEqual(['face:back']);
    // As it came: the same with or without the widened capture.
    expect(withJoints.raw.data).toEqual(without.raw.data);
    expect(withJoints.corrected).toBeDefined();
    expect(withJoints.corrected!.data).not.toEqual(without.corrected?.data ?? without.raw.data);
  });
});

describe('the joints notice', () => {
  const colors = { status: 'corrected' as const, warnings: [] };
  it('says which faces got the design joints back and their light softened, after the colour line, and that only the products are the model’s', () => {
    const notices = fluxResultNotices({ products: [], colors, corrected: true, showTiles: false, joints: 2 });
    expect(notices.infos.map((info) => info.key)).toEqual(['color', 'joints']);
    expect(notices.infos[0].text).toContain('. 제품·유리는 AI 결과 그대로예요.');
    expect(notices.infos[0].text).not.toContain('빛과');
    expect(notices.infos[1].text).toBe(
      '벽·바닥 2면의 타일 줄눈·무늬를 설계대로 되돌리고, AI가 그린 빛 줄기·그림자는 옅게 했어요. 그 면에 AI가 그린 작은 물건은 지워졌을 수 있어요.',
    );
  });
  it('says the original differs when the model’s own picture is shown, and nothing without restored faces', () => {
    const original = fluxResultNotices({
      products: [],
      colors,
      corrected: false,
      showTiles: false,
      joints: 3,
    });
    expect(original.infos.find((info) => info.key === 'joints')?.text).toBe(
      'AI 원본이에요. 타일 줄눈·무늬는 AI가 그린 그대로라 설계와 다를 수 있어요.',
    );
    const none = fluxResultNotices({ products: [], colors, corrected: true, showTiles: false });
    expect(none.infos.map((info) => info.key)).toEqual(['color']);
    expect(none.infos[0].text).toContain('명암·질감과 제품·유리는 AI 결과 그대로예요.');
  });
  it('words the composite colour line about our products whether or not joints went back', () => {
    for (const joints of [0, 2]) {
      const notices = fluxResultNotices({
        products: [],
        colors,
        corrected: true,
        showTiles: false,
        joints,
        composite: { shifted: false },
      });
      expect(notices.infos[0].text).toContain('제품은 3D 렌더를 제자리에 그대로 올렸어요.');
      expect(notices.infos[0].text).not.toContain('AI 결과 그대로예요');
    }
  });
});
