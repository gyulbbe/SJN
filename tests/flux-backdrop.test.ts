import { describe, expect, it } from 'vitest';
import { backdropAtResult, restoreBackdrop } from '../src/lib/ai-export/backdrop';
import type { Pixels, RegionMask } from '../src/lib/ai-export/color';
import { fluxInputLayout } from '../src/lib/ai-export/contract';

/**
 * A 200 × 120 capture: the room is the rectangle x 40–159, y 20–109 on a white backdrop, with a
 * hole (x 120–159, y 40–79) where a cut-away wall leaves the backdrop showing through.
 */
const W = 200,
  H = 120;
const inRoom = (x: number, y: number) =>
  x >= 40 && x < 160 && y >= 20 && y < 110 && !(x >= 120 && y >= 40 && y < 80);
function capture(): { pixels: Pixels; mask: RegionMask } {
  const data = new Uint8ClampedArray(W * H * 4);
  const labels = new Uint8Array(W * H),
    outside = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const room = inRoom(x, y);
      data.set(room ? [120, 110, 100, 255] : [255, 255, 255, 255], i * 4);
      labels[i] = room ? 1 : 0;
      outside[i] = room ? 0 : 1;
    }
  return {
    pixels: { width: W, height: H, data },
    mask: { width: W, height: H, data: labels, regions: [{ key: 'face:back', kind: 'wall' }], outside },
  };
}
/** The model's answer at twice the padded input: noise everywhere, a dark fake wall in the margin. */
function modelResult(layout: ReturnType<typeof fluxInputLayout>): Pixels {
  const width = layout.width * 2,
    height = layout.height * 2;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = seed % 60;
    data.set([90 + n, 80 + n, 70 + n, 255], i * 4);
  }
  return { width, height, data };
}
/** Result pixel → capture pixel (centre) through the layout, as the restore maps it. */
const toCapture = (layout: ReturnType<typeof fluxInputLayout>, u: number, v: number) => ({
  x: Math.round(((u + 0.5) / 2 - layout.x) / layout.scale - 0.5),
  y: Math.round(((v + 0.5) / 2 - layout.y) / layout.scale - 0.5),
});

describe('putting the white backdrop back into a result', () => {
  it('makes backdrop pixels the input again and leaves room pixels the model’s; the border is soft for a pixel', () => {
    const { pixels, mask } = capture();
    const layout = fluxInputLayout(W, H);
    const result = modelResult(layout);
    const restored = restoreBackdrop({ result, capture: pixels, mask, layout })!;
    expect(restored.width).toBe(result.width);
    let backdrop = 0,
      room = 0,
      soft = 0;
    for (let v = 0; v < restored.height; v++)
      for (let u = 0; u < restored.width; u++) {
        const o = (v * restored.width + u) * 4;
        // Only pixels at least 2 result pixels from any room/backdrop border are judged exactly.
        const roomAt = (du: number, dv: number) => {
          const c = toCapture(layout, u + du, v + dv);
          return c.x >= 0 && c.y >= 0 && c.x < W && c.y < H && inRoom(c.x, c.y);
        };
        const near = [-2, 0, 2].some((dv) => [-2, 0, 2].some((du) => roomAt(du, dv) !== roomAt(0, 0)));
        const pixel = [...restored.data.slice(o, o + 3)];
        if (near) {
          soft++;
          continue;
        }
        if (roomAt(0, 0)) {
          room++;
          expect(pixel).toEqual([...result.data.slice(o, o + 3)]);
        } else {
          backdrop++;
          // The margin, the hole through the cut-away wall and the input's padding: white again.
          expect(pixel).toEqual([255, 255, 255]);
        }
      }
    expect(room).toBeGreaterThan(20000);
    expect(backdrop).toBeGreaterThan(20000);
    // The soft band is a few result pixels wide along the borders.
    expect(soft).toBeLessThan((room + backdrop) * 0.05);
  });

  it('the hole through a cut-away wall is restored too', () => {
    const { mask } = capture();
    const layout = fluxInputLayout(W, H);
    const map = backdropAtResult(mask, layout, { width: layout.width * 2, height: layout.height * 2 })!;
    const width = layout.width * 2;
    const at = (x: number, y: number) => {
      // Capture (x, y) centre → result pixel.
      const u = Math.floor(((x + 0.5) * layout.scale + layout.x) * 2),
        v = Math.floor(((y + 0.5) * layout.scale + layout.y) * 2);
      return map[v * width + u];
    };
    expect(at(140, 60)).toBe(1); // the hole
    expect(at(80, 60)).toBe(0); // the room
    expect(at(10, 60)).toBe(1); // the margin
  });

  it('follows a small shift of the model: the backdrop moves with the room', () => {
    const { pixels, mask } = capture();
    const layout = fluxInputLayout(W, H);
    const size = { width: layout.width * 2, height: layout.height * 2 };
    const still = backdropAtResult(mask, layout, size)!;
    const moved = backdropAtResult(mask, layout, size, { dx: 8, dy: -6 })!;
    let differ = 0;
    for (let v = 10; v < size.height - 10; v++)
      for (let u = 10; u < size.width - 10; u++) {
        expect(moved[v * size.width + u]).toBe(still[(v + 6) * size.width + u - 8]);
        if (moved[v * size.width + u] !== still[v * size.width + u]) differ++;
      }
    expect(differ).toBeGreaterThan(1000);
    const restored = restoreBackdrop({
      result: modelResult(layout),
      capture: pixels,
      mask,
      layout,
      shift: { dx: 8, dy: -6 },
    })!;
    // A backdrop pixel of the shifted map far from the border is white.
    const u = 30,
      v = 30;
    expect(moved[v * size.width + u]).toBe(1);
    expect([...restored.data.slice((v * size.width + u) * 4, (v * size.width + u) * 4 + 3)]).toEqual([
      255, 255, 255,
    ]);
  });

  it('does nothing when the capture has no backdrop (nothing to restore)', () => {
    const { pixels, mask } = capture();
    const layout = fluxInputLayout(W, H);
    const none = { ...mask, outside: new Uint8Array(W * H) };
    expect(
      restoreBackdrop({ result: modelResult(layout), capture: pixels, mask: none, layout }),
    ).toBeUndefined();
    const older = { ...mask, outside: undefined };
    expect(
      restoreBackdrop({ result: modelResult(layout), capture: pixels, mask: older, layout }),
    ).toBeUndefined();
  });
});
