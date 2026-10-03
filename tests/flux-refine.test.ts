import { describe, it, expect } from 'vitest';
import type { Pixels } from '../src/lib/ai-export/color';
import type { RegionMask } from '../src/lib/ai-export/color';
import { composeFluxResult, toByte, toLinear, type RoomLayers } from '../src/lib/ai-export/composite';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import {
  alignToSilhouette,
  applyRefined,
  cropModelInput,
  cutoutAlpha,
  ownMask,
  refinedLayer,
  REFINE_MIN_IOU,
  type ProductCrop,
} from '../src/lib/ai-export/refine';
import {
  refineEstimate,
  runRefine,
  type RefineDeps,
  type RefineProduct,
} from '../src/lib/ai-export/refine-run';
import type { FluxProduct } from '../src/lib/ai-export/product-prompt';

/** A product silhouette: an ellipse, or a rectangle, on a grid. */
type Shape = { cx: number; cy: number; rx: number; ry: number; rect?: boolean };
const inside = (shape: Shape, x: number, y: number) =>
  shape.rect
    ? Math.abs(x - shape.cx) <= shape.rx && Math.abs(y - shape.cy) <= shape.ry
    : ((x - shape.cx) / shape.rx) ** 2 + ((y - shape.cy) / shape.ry) ** 2 <= 1;
function alphaOf(shape: Shape, width: number, height: number) {
  const alpha = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) alpha[y * width + x] = inside(shape, x + 0.5, y + 0.5) ? 1 : 0;
  return alpha;
}
function coverageOf(shape: Shape, width: number, height: number) {
  return Uint8Array.from(alphaOf(shape, width, height), (v) => v * 255);
}
/** A close-up of 200 × 300 whose product is an ellipse; `window` places it in the frame. */
function crop(
  id: string,
  shape: Shape = { cx: 100, cy: 150, rx: 70, ry: 115 },
  window: ProductCrop['window'] = [0.25, 0.25, 0.75, 0.75],
): ProductCrop {
  const width = 200,
    height = 300;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (inside(shape, x + 0.5, y + 0.5)) data.set([150, 150, 150, 255], (y * width + x) * 4);
  return { id, width, height, data, coverage: coverageOf(shape, width, height), window, box: window };
}
/** A picture of `shape` in `colour` on white, as a model answer on the close-up's grid. */
function picture(shape: Shape, colour: [number, number, number], width = 200, height = 300): Pixels {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (inside(shape, x + 0.5, y + 0.5)) data.set([...colour, 255], (y * width + x) * 4);
  return { width, height, data };
}

describe('the model input of a close-up', () => {
  it('is on the 16 px grid, at most 496, white padded and never stretched', () => {
    const { pixels, layout } = cropModelInput(crop('a'));
    expect(pixels.width % 16).toBe(0);
    expect(pixels.height % 16).toBe(0);
    expect(Math.max(pixels.width, pixels.height)).toBeLessThanOrEqual(496);
    expect(layout.scale).toBeCloseTo(Math.min(pixels.width / 200, pixels.height / 300), 6);
    const at = (x: number, y: number) => [
      ...pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 3),
    ];
    // The middle is the product's grey, a corner is the white of the close-up or of the padding.
    expect(at(pixels.width >> 1, pixels.height >> 1)).toEqual([150, 150, 150]);
    expect(at(0, 0)).toEqual([255, 255, 255]);
    expect(at(pixels.width - 1, pixels.height - 1)).toEqual([255, 255, 255]);
  });
});

describe('standing the model result on the 3D silhouette', () => {
  const w = 200,
    h = 300;
  const own = coverageOf({ cx: 100, cy: 150, rx: 70, ry: 115 }, w, h);
  it('gives overlap 1 for the same silhouette and says it is the same height', () => {
    const a = alignToSilhouette(alphaOf({ cx: 100, cy: 150, rx: 70, ry: 115 }, w, h), own, w, h);
    if ('failure' in a) throw new Error('failed');
    expect(a.iou).toBeGreaterThan(0.99);
    expect(a.ratio).toBeCloseTo(1, 2);
  });
  it('puts a moved product back on the same ground point: the move costs nothing', () => {
    // 14 px to the right and 9 px up: plainly 80 % overlap, aligned about 100 %.
    const moved = alphaOf({ cx: 114, cy: 141, rx: 70, ry: 115 }, w, h);
    const a = alignToSilhouette(moved, own, w, h);
    if ('failure' in a) throw new Error('failed');
    expect(a.plainIou).toBeLessThan(0.85);
    expect(a.iou).toBeGreaterThan(0.97);
  });
  it('scales a result that is a little larger onto the 3D product height', () => {
    const larger = alphaOf({ cx: 100, cy: 140, rx: 80, ry: 131 }, w, h);
    const a = alignToSilhouette(larger, own, w, h);
    if ('failure' in a) throw new Error('failed');
    expect(a.ratio).toBeCloseTo(131 / 115, 1);
    expect(a.iou).toBeGreaterThan(0.95);
    // Its pixels are read through the same scale: the 3D bottom centre is the result's.
    const [x, y] = a.toResult(100, 265);
    expect(x).toBeCloseTo(100, 0);
    expect(y).toBeCloseTo(271, 0);
  });
  it('refuses a result whose height is far from the product: no placement fixes that', () => {
    const ours = coverageOf({ cx: 100, cy: 150, rx: 40, ry: 60 }, w, h);
    // 115 against 60 is nearly twice the height; 60 against 115 is about half.
    expect(alignToSilhouette(alphaOf({ cx: 100, cy: 150, rx: 70, ry: 115 }, w, h), ours, w, h)).toEqual({
      failure: 'size',
    });
    const short = alphaOf({ cx: 100, cy: 220, rx: 60, ry: 60 }, w, h);
    expect(alignToSilhouette(short, own, w, h)).toEqual({ failure: 'size' });
  });
  it('measures a different shape of the same height below the gate', () => {
    const box = alphaOf({ cx: 100, cy: 150, rx: 50, ry: 115, rect: true }, w, h);
    const a = alignToSilhouette(box, own, w, h);
    if ('failure' in a) throw new Error('failed');
    expect(a.iou).toBeLessThan(REFINE_MIN_IOU);
  });
  it('finds nothing in an empty result or an empty silhouette', () => {
    expect(alignToSilhouette(new Float32Array(w * h), own, w, h)).toEqual({ failure: 'empty' });
    expect(
      alignToSilhouette(alphaOf({ cx: 100, cy: 150, rx: 70, ry: 115 }, w, h), new Uint8Array(w * h), w, h),
    ).toEqual({
      failure: 'empty',
    });
  });
  it('reads the alpha of a cut-out of any size on the close-up grid', () => {
    const cut = picture({ cx: 50, cy: 75, rx: 35, ry: 57 }, [10, 10, 10], 100, 150);
    for (let i = 0; i < 100 * 150; i++) cut.data[i * 4 + 3] = cut.data[i * 4] === 255 ? 0 : 255;
    const alpha = cutoutAlpha(cut, { width: 200, height: 300 });
    expect(alpha[150 * 200 + 100]).toBeCloseTo(1, 2);
    expect(alpha[5 * 200 + 5]).toBe(0);
  });
});

describe('the product on the frame', () => {
  const frame = { width: 400, height: 300 };
  it('maps the close-up window onto the frame pixels it covers', () => {
    const c = crop('a');
    const mask = ownMask(c, frame);
    // [0.25, 0.25, 0.75, 0.75] of 400 × 300.
    expect(mask.rect).toEqual([100, 75, 300, 225]);
    const w = mask.rect[2] - mask.rect[0];
    const at = (x: number, y: number) => mask.own[(y - mask.rect[1]) * w + (x - mask.rect[0])];
    expect(at(200, 150)).toBeCloseTo(1, 2);
    expect(at(101, 76)).toBe(0);
    // 70/200 of the window's width either side of the centre: frame x 200 ± 70·(200/200).
    expect(at(200 + 66, 150)).toBeGreaterThan(0.9);
    expect(at(200 + 74, 150)).toBeLessThan(0.1);
  });
  it('lays the result through the alignment and takes the white out of its edge', () => {
    const c = crop('a');
    const shape: Shape = { cx: 112, cy: 140, rx: 70, ry: 115 };
    // The model drew it 12 px right and 10 px up, in a warm colour, antialiased against white.
    const ai = picture(shape, [220, 200, 180]);
    const alpha = alphaOf(shape, 200, 300);
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 200; x++) {
        const i = y * 200 + x;
        const edge =
          inside(shape, x + 0.5, y + 0.5) &&
          !inside({ ...shape, rx: shape.rx - 1.5, ry: shape.ry - 1.5 }, x + 0.5, y + 0.5);
        if (edge) {
          alpha[i] = 0.5;
          // The colour on screen is half the product's, half white.
          for (let ch = 0; ch < 3; ch++)
            ai.data[i * 4 + ch] = toByte((toLinear([220, 200, 180][ch]) + 1) / 2);
        }
      }
    const alignment = alignToSilhouette(alpha, c.coverage, 200, 300);
    if ('failure' in alignment) throw new Error('failed');
    const layer = refinedLayer({ crop: c, frame, ai, alpha, alignment });
    const w = layer.rect[2] - layer.rect[0];
    const i = (150 - layer.rect[1]) * w + (200 - layer.rect[0]);
    // The centre of the product is where the 3D product's centre is, in the model's colour.
    expect(layer.alpha[i]).toBeCloseTo(1, 2);
    expect(layer.color[i * 3]).toBeCloseTo(toLinear(220), 2);
    expect(layer.color[i * 3 + 1]).toBeCloseTo(toLinear(200), 2);
    // An edge pixel keeps the product's colour, not the grey-white of its blend with the page.
    let worst = 0;
    for (let k = 0; k < layer.alpha.length; k++)
      if (layer.alpha[k] > 0.3 && layer.alpha[k] < 0.7)
        worst = Math.max(worst, Math.abs(layer.color[k * 3] - toLinear(220)));
    expect(worst).toBeLessThan(0.08);
    expect(layer.iou).toBeGreaterThan(0.95);
  });
});

/** A 400 × 300 room: grey; the products' silhouettes (frame coordinates) are the render's fixture layer. */
function room(...shapes: Shape[]): RoomLayers {
  const width = 400,
    height = 300,
    n = width * height;
  const empty = new Uint8ClampedArray(n * 4),
    full = new Uint8ClampedArray(n * 4),
    coverage = new Uint8Array(n);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const on = shapes.some((shape) => inside(shape, x + 0.5, y + 0.5));
      coverage[i] = on ? 255 : 0;
      empty.set([120, 120, 120, 255], i * 4);
      full.set(on ? [200, 200, 200, 255] : [120, 120, 120, 255], i * 4);
    }
  return { width, height, full, shadowed: empty, empty, coverage };
}
describe('putting the repainted products into the render', () => {
  const frame = { width: 400, height: 300 };
  const WHOLE: ProductCrop['window'] = [0.25, 0.25, 0.75, 0.75];
  /**
   * A product standing at `at` (frame coordinates) whose close-up window is `window`: the crop's 3D
   * silhouette is that shape seen through the window, and the model's picture is `ai` (default the
   * same shape) in `colour`.
   */
  function placed(
    id: string,
    at: Shape,
    window: ProductCrop['window'],
    colour: [number, number, number],
    ai: Shape = at,
  ) {
    const ww = (window[2] - window[0]) * frame.width,
      wh = (window[3] - window[1]) * frame.height;
    const toCrop = (s: Shape): Shape => ({
      cx: ((s.cx - window[0] * frame.width) * 200) / ww,
      cy: ((s.cy - window[1] * frame.height) * 300) / wh,
      rx: (s.rx * 200) / ww,
      ry: (s.ry * 300) / wh,
    });
    const c = crop(id, toCrop(at), window);
    const alpha = alphaOf(toCrop(ai), 200, 300);
    const alignment = alignToSilhouette(alpha, c.coverage, 200, 300);
    if ('failure' in alignment) throw new Error('failed');
    return { c, layer: refinedLayer({ crop: c, frame, ai: picture(toCrop(ai), colour), alpha, alignment }) };
  }
  const at = (fixtures: ReturnType<typeof applyRefined>, x: number, y: number) => ({
    alpha: fixtures.alpha[y * fixtures.width + x],
    color: [0, 1, 2].map((ch) => fixtures.color[(y * fixtures.width + x) * 3 + ch]),
  });
  const ALONE: Shape = { cx: 200, cy: 150, rx: 70, ry: 57.5 };

  it("replaces the 3D pixels of a product that stands alone, in the 3D product's light", () => {
    const { layer } = placed('a', ALONE, WHOLE, [225, 225, 225]);
    const fixtures = applyRefined(room(ALONE), [layer], []);
    const centre = at(fixtures, 200, 150);
    expect(centre.alpha).toBeCloseTo(1, 2);
    // The model drew it brighter (225) than the render (200): it is brought to the render's light.
    expect(centre.color[0]).toBeGreaterThan(toLinear(200) * 0.95);
    expect(centre.color[0]).toBeLessThan(toLinear(200) * 1.05);
    expect(at(fixtures, 10, 10).alpha).toBe(0);
  });

  it("keeps the repainted colour where it differs (the product's own tint follows the model, a little)", () => {
    const { layer } = placed('a', ALONE, WHOLE, [230, 215, 200]);
    const centre = at(applyRefined(room(ALONE), [layer], []), 200, 150);
    // Warmer than the neutral 3D product, as drawn.
    expect(centre.color[0] - centre.color[2]).toBeGreaterThan(0.02);
  });

  it("clears 3D pixels the repainted product no longer covers: the model's room shows there", () => {
    // The model's product is narrower than the render's: the rim pixels would otherwise stay 3D.
    const { layer } = placed('a', ALONE, WHOLE, [200, 200, 200], { ...ALONE, rx: 60 });
    const fixtures = applyRefined(room(ALONE), [layer], []);
    // Frame x 200 + 65 is inside the 3D ellipse (70) and outside the narrower repainted one (60).
    expect(at(fixtures, 265, 150).alpha).toBe(0);
    expect(at(fixtures, 200, 150).alpha).toBeCloseTo(1, 2);
  });

  it('leaves a product that stays the 3D render, and the overlap of two products, as rendered', () => {
    // A (repainted) and B (kept) side by side, overlapping in frame x 190–240.
    const shapeA: Shape = { cx: 180, cy: 150, rx: 60, ry: 57.5 };
    const shapeB: Shape = { cx: 250, cy: 150, rx: 60, ry: 57.5 };
    const a = placed('a', shapeA, [0.25, 0.25, 0.65, 0.75], [230, 215, 200]);
    const b = placed('b', shapeB, [0.45, 0.25, 0.85, 0.75], [200, 200, 200]);
    const base = applyRefined(room(shapeA, shapeB), [], []);
    const fixtures = applyRefined(
      room(shapeA, shapeB),
      [a.layer],
      [ownMask(a.c, frame), ownMask(b.c, frame)],
    );
    // B's far side: the render.
    expect(at(fixtures, 295, 150)).toEqual(at(base, 295, 150));
    // The overlap strip: the render, colour and alpha.
    expect(at(fixtures, 215, 150)).toEqual(at(base, 215, 150));
    // A's own side: repainted (warmer than the neutral render).
    const own = at(fixtures, 140, 150);
    expect(own.alpha).toBeCloseTo(1, 2);
    expect(own.color[0] - own.color[2]).toBeGreaterThan(0.02);
    expect(at(base, 140, 150).color[0] - at(base, 140, 150).color[2]).toBeCloseTo(0, 6);
  });

  it('keeps every pixel of a product that is not repainted, whatever the others do', () => {
    const shapeA: Shape = { cx: 120, cy: 150, rx: 50, ry: 57.5 };
    const shapeB: Shape = { cx: 290, cy: 150, rx: 50, ry: 57.5 };
    const a = placed('a', shapeA, [0.1, 0.25, 0.5, 0.75], [230, 215, 200]);
    const b = placed('b', shapeB, [0.55, 0.25, 0.95, 0.75], [200, 200, 200]);
    const base = applyRefined(room(shapeA, shapeB), [], []);
    const fixtures = applyRefined(room(shapeA, shapeB), [a.layer], [ownMask(b.c, frame)]);
    for (let x = 240; x < 340; x += 5) expect(at(fixtures, x, 150)).toEqual(at(base, x, 150));
  });
});

describe('repainting the products one by one', () => {
  const frame = { width: 400, height: 300 };
  const fact: FluxProduct = {
    kind: 'toilet',
    forms: ['floor-standing'],
    color: '#f2f1ec',
    finish: 'glossy',
    sizeMm: [400, 760, 700],
  };
  const products: RefineProduct[] = ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    label: id.toUpperCase(),
    crop: crop(id),
    fact,
  }));
  const { layout } = cropModelInput(crop('a'));
  /** The model's answer: `shape` (in the close-up's own pixels) in grey on white, twice the input's size. */
  function answerWith(shape: Shape): Pixels {
    const width = layout.width * 2,
      height = layout.height * 2;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let v = 0; v < height; v++)
      for (let u = 0; u < width; u++) {
        const x = ((u + 0.5) / 2 - layout.x) / layout.scale,
          y = ((v + 0.5) / 2 - layout.y) / layout.scale;
        if (inside(shape, x, y)) data.set([150, 150, 150, 255], (v * width + u) * 4);
      }
    return { width, height, data };
  }
  const SAME: Shape = { cx: 100, cy: 150, rx: 70, ry: 115 };
  /** PNG coding by reference: a Blob carries the pixels it stands for. */
  function harness(options: {
    /** The answer to the n-th request: a shape, or the failure to throw (default: the same shape). */
    answer?: (n: number) => Shape | Error;
    /** Whether the cut-out after the n-th request fails. */
    cutoutFails?: (n: number) => boolean;
  }) {
    const store = new WeakMap<Blob, Pixels>();
    const blobOf = (pixels: Pixels) => {
      const blob = new Blob(['x']);
      store.set(blob, pixels);
      return blob;
    };
    let requests = 0,
      cutouts = 0,
      inFlight = 0,
      peak = 0,
      cutting = 0,
      cutPeak = 0;
    const log: string[] = [];
    const deps: RefineDeps = {
      encode: async (pixels) => blobOf(pixels),
      decode: async (blob) => store.get(blob)!,
      request: async (_image, reference, seed, product) => {
        const n = requests++;
        log.push(`${reference ? 'photo' : 'no-photo'} ${seed} ${product.kind}`);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const made = options.answer?.(n) ?? SAME;
        if (made instanceof Error) throw made;
        return blobOf(answerWith(made));
      },
      cutout: async (image) => {
        const n = cutouts++;
        cutting++;
        cutPeak = Math.max(cutPeak, cutting);
        await new Promise((resolve) => setTimeout(resolve, 2));
        cutting--;
        if (options.cutoutFails?.(n)) throw new Error('model');
        const pixels = store.get(image)!;
        const out = new Uint8ClampedArray(pixels.data);
        for (let i = 0; i < pixels.width * pixels.height; i++)
          out[i * 4 + 3] = pixels.data[i * 4] > 245 ? 0 : 255;
        return blobOf({ ...pixels, data: out });
      },
    };
    return { deps, log, peak: () => peak, cutPeak: () => cutPeak, requests: () => requests };
  }
  const run = (
    h: ReturnType<typeof harness>,
    extra: Partial<Parameters<typeof runRefine>[0]> = {},
    list: readonly RefineProduct[] = products,
  ) =>
    runRefine({
      products: list,
      frame,
      deps: h.deps,
      seed: 7,
      signal: new AbortController().signal,
      ...extra,
    });

  it('repaints every product and sends one request each, with the same seed, at most two at a time', async () => {
    const h = harness({});
    const progress: number[] = [];
    const outcomes = await run(h, { onProgress: (done, total) => progress.push(done * 10 + total) });
    expect(outcomes.map((o) => o.status)).toEqual(['refined', 'refined', 'refined', 'refined']);
    expect(h.requests()).toBe(4);
    expect(h.log.every((line) => line === 'no-photo 7 toilet')).toBe(true);
    expect(h.peak()).toBeLessThanOrEqual(2);
    expect(h.cutPeak()).toBe(1);
    expect(progress).toEqual([14, 24, 34, 44]);
    for (const o of outcomes) if (o.status === 'refined') expect(o.iou).toBeGreaterThan(0.95);
  });

  it('sends the product photo as the reference when it has one', async () => {
    const h = harness({});
    await run(h, {}, [{ ...products[0], reference: new Blob(['photo']) }]);
    expect(h.log).toEqual(['photo 7 toilet']);
  });

  it('keeps only the product whose request failed and goes on with the others, without retrying', async () => {
    const h = harness({ answer: (n) => (n === 1 ? new Error('AI 요청이 늦었어요') : SAME) });
    const outcomes = await run(h, { concurrency: 1 });
    expect(outcomes.map((o) => o.status)).toEqual(['refined', 'kept', 'refined', 'refined']);
    expect(outcomes[1]).toMatchObject({ status: 'kept', reason: 'request', message: 'AI 요청이 늦었어요' });
    expect(h.requests()).toBe(4);
  });

  it('stops asking once a limit is spent or the login is refused: the rest are kept with that reason', async () => {
    const limit = Object.assign(new Error('오늘 한도 소진'), { status: 429 });
    const h = harness({ answer: (n) => (n === 1 ? limit : SAME) });
    const outcomes = await run(h, { concurrency: 1 });
    expect(outcomes.map((o) => o.status)).toEqual(['refined', 'kept', 'kept', 'kept']);
    expect(outcomes[3]).toMatchObject({ reason: 'request', message: '오늘 한도 소진' });
    // One request per product that was asked: the two after the limit were never sent.
    expect(h.requests()).toBe(2);
  });

  it('keeps a product whose cut-out failed, whose result changed height, or whose shape changed', async () => {
    const shapes: Record<number, Shape> = {
      2: { cx: 100, cy: 150, rx: 40, ry: 60 },
      3: { cx: 100, cy: 150, rx: 50, ry: 115, rect: true },
    };
    const h = harness({ answer: (n) => shapes[n] ?? SAME, cutoutFails: (n) => n === 1 });
    const outcomes = await run(h, { concurrency: 1 });
    expect(outcomes[0].status).toBe('refined');
    expect(outcomes[1]).toMatchObject({ status: 'kept', reason: 'cutout' });
    expect(outcomes[2]).toMatchObject({ status: 'kept', reason: 'size' });
    expect(outcomes[3]).toMatchObject({ status: 'kept', reason: 'shape' });
    const shape = outcomes[3];
    if (shape.status === 'kept') {
      expect(shape.iou).toBeLessThan(REFINE_MIN_IOU);
      expect(shape.message).toContain('윤곽 겹침');
      expect(shape.message).toMatch(/\d+%/);
    }
    // Each reason reads as a sentence for the dialog.
    for (const o of outcomes) if (o.status === 'kept') expect(o.message.length).toBeGreaterThan(8);
  });

  it('ends the whole run with the abort, not with a kept product', async () => {
    const controller = new AbortController();
    const h = harness({});
    const pending = run(h, { signal: controller.signal, concurrency: 1 });
    setTimeout(() => controller.abort(), 3);
    await expect(pending).rejects.toThrow();
  });

  it('says what a click costs before it is made: one request per product and one for the room', () => {
    expect(refineEstimate(0)).toEqual({ calls: 1, neurons: 110 });
    expect(refineEstimate(3)).toEqual({ calls: 4, neurons: 455 });
  });
});

describe('one composed result with repainted products', () => {
  it('puts the repainted product where the render had it, and changes nothing else in the picture', () => {
    const width = 1024,
      height = 683,
      n = width * height;
    const empty = new Uint8ClampedArray(n * 4),
      coverage = new Uint8Array(n),
      labels = new Uint8Array(n);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const v = y >= 400 ? 190 : 100;
        empty.set([v, v, v, 255], i * 4);
        labels[i] = y >= 400 ? 2 : 1;
        if (x >= 480 && x < 560 && y >= 300 && y < 420) {
          coverage[i] = 255;
          labels[i] = 255;
        }
      }
    const full = Uint8ClampedArray.from(empty);
    for (let i = 0; i < n; i++) if (coverage[i]) full.set([240, 238, 236, 255], i * 4);
    const layers: RoomLayers = { width, height, full, shadowed: empty, empty, coverage };
    const mask: RegionMask = {
      width,
      height,
      regions: [
        { key: 'face:back', kind: 'wall' },
        { key: 'face:floor', kind: 'floor' },
      ],
      data: labels,
    };
    const layout = fluxInputLayout(width, height);
    const w = layout.width * 2,
      h = layout.height * 2;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let v = 0; v < h; v++)
      for (let u = 0; u < w; u++) {
        const y = ((v + 0.5) / 2 - layout.y) / layout.scale;
        const value = y >= 400 ? 190 : 100;
        data.set([value, value, value, 255], (v * w + u) * 4);
      }
    const result: Pixels = { width: w, height: h, data };
    // The product's close-up: the frame's [440, 280, 600, 440] window at 2×, the fixture a rectangle.
    const window: ProductCrop['window'] = [440 / width, 280 / height, 600 / width, 440 / height];
    const cropGrid = { width: 320, height: 320 };
    const box: Shape = { cx: 160, cy: 160, rx: 80, ry: 120, rect: true };
    const product: ProductCrop = {
      id: 'toilet',
      ...cropGrid,
      data: new Uint8ClampedArray(320 * 320 * 4).fill(255),
      coverage: coverageOf(box, 320, 320),
      window,
      box: [480 / width, 300 / height, 560 / width, 420 / height],
    };
    const ai = picture(box, [250, 235, 215], 320, 320);
    const alpha = alphaOf(box, 320, 320);
    const alignment = alignToSilhouette(alpha, product.coverage, 320, 320);
    if ('failure' in alignment) throw new Error('failed');
    const refine = {
      layers: [refinedLayer({ crop: product, frame: { width, height }, ai, alpha, alignment })],
      owns: [ownMask(product, { width, height })],
    };
    const input = { width, height, data: empty };
    const boxes: [number, number, number, number][] = [product.box];
    const plain = composeFluxResult({ result, input, layers, mask, layout, boxes });
    const refined = composeFluxResult({ result, input, layers, mask, layout, boxes, refine });
    const o = (360 * width + 520) * 4;
    // The render's neutral light grey became the model's warmer product, in the render's brightness.
    expect([...plain.raw.data.slice(o, o + 3)]).toEqual([240, 238, 236]);
    const [r, g, b] = refined.raw.data.slice(o, o + 3);
    expect(r - b).toBeGreaterThan(6);
    expect(g).toBeGreaterThan(215);
    expect(r).toBeLessThan(256);
    // Everything outside the product's frame pixels is identical: the room, its shadow, its checks.
    let differing = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (x >= 478 && x < 562 && y >= 298 && y < 422) continue;
        if (plain.raw.data[i] !== refined.raw.data[i] || plain.raw.data[i + 1] !== refined.raw.data[i + 1])
          differing++;
      }
    expect(differing).toBe(0);
    expect(refined.shifted).toBe(plain.shifted);
    // No repainted products: exactly the composite that was there before.
    const none = composeFluxResult({
      result,
      input,
      layers,
      mask,
      layout,
      boxes,
      refine: { layers: [], owns: [] },
    });
    expect([...none.raw.data]).toEqual([...plain.raw.data]);
    // Four full-size composites: seconds on a loaded machine.
  }, 60_000);
});
