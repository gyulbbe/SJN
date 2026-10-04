import { describe, expect, it } from 'vitest';
import {
  compareFaces,
  correctFaces,
  deltaE2000,
  FIXTURE_REGION,
  framing,
  isColorShiftWarning,
  isColorWarning,
  LIGHTNESS_BAND,
  LIGHTNESS_RESIDUAL_L,
  LIGHTNESS_RETURN,
  LIGHTNESS_SHARE,
  lightnessReturn,
  lightnessWarning,
  LIGHT_TILE_MAX_L,
  labToRgb,
  MAX_SHIFT_AB,
  MAX_SHIFT_L,
  projectCapture,
  rgbToLab,
  reviewResultColors,
  type Pixels,
  type RegionMask,
} from '../src/lib/ai-export/color';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import { deltaE2000 as referenceDeltaE, type Rgb } from './helpers/delta-e';

/**
 * A 240×160 bathroom: left half wall (region 1), right half wall (region 2), bottom floor (region 3),
 * a white "toilet" block (fixture) and a ceiling strip (unchecked). Tiles have grout lines and a
 * gentle vertical light falloff, so there are edges to align on and texture to keep.
 */
const W = 240,
  H = 160;
function room(colors: { wall: Rgb; floor: Rgb; right?: Rgb }, tint: (rgb: Rgb) => Rgb = (c) => c): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const label = mask.data[y * W + x];
      let rgb: Rgb =
        label === FIXTURE_REGION
          ? [246, 246, 244]
          : label === 3
            ? colors.floor
            : label === 2
              ? (colors.right ?? colors.wall)
              : label === 1
                ? colors.wall
                : [252, 252, 252];
      if (label && label !== FIXTURE_REGION) {
        const grout = x % 20 < 2 || y % 20 < 2 ? 0.86 : 1;
        const light = 1 - (y / H) * 0.12;
        rgb = rgb.map((v) => v * grout * light) as Rgb;
      }
      if (label !== FIXTURE_REGION) rgb = tint(rgb);
      data.set([...rgb, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
}
const mask: RegionMask = (() => {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      data[y * W + x] =
        y < 16
          ? 0
          : x >= 150 && x < 190 && y >= 80 && y < 140
            ? FIXTURE_REGION
            : y >= 110
              ? 3
              : x < 120
                ? 1
                : 2;
  return {
    width: W,
    height: H,
    regions: [
      { key: 'left', kind: 'wall' },
      { key: 'back', kind: 'wall' },
      { key: 'floor', kind: 'floor' },
    ],
    data,
  };
})();
/** A warm cast in Lab: b* up by `amount`, lightness up a little (the model's brighter light). */
const warm =
  (amount: number) =>
  ([r, g, b]: Rgb): Rgb => {
    const [L, a, bb] = rgbToLab(Math.round(r), Math.round(g), Math.round(b));
    return labToRgb(L + 3, a + amount * 0.2, bb + amount);
  };
const WHITE: Rgb = [236, 235, 230],
  GREY: Rgb = [110, 110, 112],
  BEIGE: Rgb = [214, 196, 168];
const meanLab = (image: Pixels, region: number, labels = mask) => {
  let L = 0,
    a = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < labels.data.length; i++)
    if (labels.data[i] === region) {
      const lab = rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]);
      L += lab[0];
      a += lab[1];
      b += lab[2];
      n++;
    }
  return [L / n, a / n, b / n] as [number, number, number];
};

describe('colour maths', () => {
  it('round-trips sRGB through Lab and matches the reference CIEDE2000', () => {
    for (const rgb of [WHITE, GREY, BEIGE, [12, 200, 90] as Rgb]) {
      const back = labToRgb(...rgbToLab(...rgb));
      back.forEach((v, i) => expect(Math.abs(v - rgb[i])).toBeLessThan(0.6));
    }
    const pairs: [Rgb, Rgb][] = [
      [WHITE, BEIGE],
      [GREY, [120, 100, 90]],
      [
        [20, 40, 200],
        [30, 50, 190],
      ],
    ];
    for (const [a, b] of pairs)
      expect(deltaE2000(rgbToLab(...a), rgbToLab(...b))).toBeCloseTo(referenceDeltaE(a, b), 4);
  });
});

describe('framing', () => {
  it('finds the model shift and refuses a reframed result', () => {
    const reference = room({ wall: WHITE, floor: GREY });
    expect(framing(reference, reference)).toMatchObject({ dx: 0, dy: 0, aligned: true });
    const shifted = new Uint8ClampedArray(reference.data.length).fill(255);
    for (let y = 0; y < H; y++)
      for (let x = 4; x < W; x++)
        shifted.set(reference.data.subarray((y * W + x - 4) * 4, (y * W + x - 3) * 4), (y * W + x) * 4);
    expect(framing(reference, { width: W, height: H, data: shifted })).toMatchObject({
      dx: 4,
      dy: 0,
      aligned: true,
    });
    // A different picture of the same colours: nothing lines up.
    const other = new Uint8ClampedArray(reference.data.length);
    for (let i = 0; i < other.length; i += 4) {
      const v = 200 + ((i * 2654435761) % 50);
      other.set([v, v, v - 4, 255], i);
    }
    expect(framing(reference, { width: W, height: H, data: other }).aligned).toBe(false);
  });

  it('keeps an in-room result whose busy tile the model re-laid, and still refuses it zoomed in', () => {
    // 480×320: ceiling, left/back/right walls, floor and a white fixture. The render's walls are
    // dense speckles (terrazzo); the model's are smooth, lighter and on another tile grid.
    const w = 480,
      h = 320;
    const draw = (wall: (x: number, y: number, base: number) => number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const fixture = x >= 300 && x < 345 && y >= 190 && y < 275;
          const base =
            y < 40
              ? 245
              : y >= 265
                ? 190
                : x < 110 + (y - 40) * 0.2
                  ? 95
                  : x > 370 - (y - 40) * 0.2
                    ? 110
                    : 120;
          const v = fixture ? 250 : y < 40 || y >= 265 ? base : wall(x, y, base);
          data.set([v, v, v - 3, 255], (y * w + x) * 4);
        }
      return { width: w, height: h, data };
    };
    const speckle = (x: number, y: number) =>
      (((Math.floor(x / 3) * 73856093) ^ (Math.floor(y / 3) * 19349663)) >>> 0) % 7;
    const render = draw((x, y, base) => (speckle(x, y) < 2 ? 225 : base));
    const result = draw((x, y, base) => (x % 37 < 1 || y % 37 < 1 ? base + 25 : base + 40));
    expect(framing(render, result)).toMatchObject({ aligned: true });
    const zoomed = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.floor(w * 0.075 + x * 0.85),
          sy = Math.floor(h * 0.075 + y * 0.85);
        zoomed.set(result.data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * w + x) * 4);
      }
    expect(framing(render, { width: w, height: h, data: zoomed }).aligned).toBe(false);
  });
});

describe('face colours', () => {
  it('measures a warm cast on white walls but not the brighter light alone', () => {
    const reference = room({ wall: WHITE, floor: GREY });
    const cast = compareFaces(reference, room({ wall: WHITE, floor: GREY }, warm(10)), mask, mask);
    expect(cast.map((c) => c.region)).toEqual([1, 2, 3]);
    for (const change of cast.filter((c) => c.kind === 'wall')) {
      expect(change.colorDeltaE).toBeGreaterThan(6);
      expect(change.shift).toBe('warmer');
    }
    const brighter = compareFaces(reference, room({ wall: WHITE, floor: GREY }, warm(0)), mask, mask);
    for (const change of brighter) {
      expect(change.deltaE).toBeGreaterThan(1);
      expect(change.colorDeltaE).toBeLessThan(1);
    }
  });

  it('moves each face back to the render colour, keeps lightness and texture, and never touches fixtures', () => {
    const reference = room({ wall: WHITE, floor: GREY });
    const result = room({ wall: WHITE, floor: GREY }, warm(12));
    const changes = compareFaces(reference, result, mask, mask);
    const corrected = correctFaces(result, mask, changes);
    for (const region of [1, 2, 3]) {
      const target = meanLab(reference, region),
        before = meanLab(result, region),
        after = meanLab(corrected, region);
      // Faded edges keep a little of the cast; the face as a whole is back within ~1 ΔE.
      expect(deltaE2000(target, [target[0], after[1], after[2]])).toBeLessThan(1.5);
      expect(Math.abs(after[0] - before[0])).toBeLessThan(0.6);
    }
    for (let i = 0; i < mask.data.length; i++)
      if (mask.data[i] === 0 || mask.data[i] === FIXTURE_REGION)
        expect([...corrected.data.subarray(i * 4, i * 4 + 4)]).toEqual([
          ...result.data.subarray(i * 4, i * 4 + 4),
        ]);
    // Grout lines survive: the texture's contrast is the model's.
    const row = 60,
      tile = (row * W + 30) * 4,
      grout = (row * W + 40) * 4;
    expect(corrected.data[tile] - corrected.data[grout]).toBeCloseTo(
      result.data[tile] - result.data[grout],
      -1,
    );
  });

  it('keeps a coloured tile coloured: restores lost colour, never bleaches it', () => {
    const reference = room({ wall: BEIGE, floor: GREY });
    // The model kept the beige: almost nothing moves.
    const kept = room({ wall: BEIGE, floor: GREY }, warm(0));
    const keptCorrected = correctFaces(kept, mask, compareFaces(reference, kept, mask, mask));
    expect(deltaE2000(meanLab(kept, 1), meanLab(keptCorrected, 1))).toBeLessThan(0.5);
    // The model whitened it: the colour comes back.
    const whitened = room({ wall: [226, 222, 214], floor: GREY });
    const restored = correctFaces(whitened, mask, compareFaces(reference, whitened, mask, mask));
    const chroma = (lab: number[]) => Math.hypot(lab[1], lab[2]);
    expect(chroma(meanLab(restored, 1))).toBeGreaterThan(chroma(meanLab(whitened, 1)) + 8);
    expect(Math.abs(chroma(meanLab(restored, 1)) - chroma(meanLab(reference, 1)))).toBeLessThan(2);
  });

  it(`stops at ${MAX_SHIFT_AB} a*b* units when the model painted another material`, () => {
    const reference = room({ wall: WHITE, floor: GREY });
    const green = room({ wall: [40, 170, 60], floor: GREY });
    const changes = compareFaces(reference, green, mask, mask);
    const corrected = correctFaces(green, mask, changes);
    const moved = Math.hypot(
      meanLab(corrected, 1)[1] - meanLab(green, 1)[1],
      meanLab(corrected, 1)[2] - meanLab(green, 1)[2],
    );
    expect(moved).toBeLessThanOrEqual(MAX_SHIFT_AB + 0.5);
  });
});

describe('white tiles', () => {
  it('gives a dimmed light tile half its lightness back, and keeps a slightly brighter result as it is', () => {
    const reference = room({ wall: WHITE, floor: GREY });
    const dim = ([r, g, b]: Rgb): Rgb => {
      const [L, a, bb] = rgbToLab(Math.round(r), Math.round(g), Math.round(b));
      return labToRgb(L - 12, a + 0.4, bb + 2);
    };
    const dimmed = room({ wall: WHITE, floor: GREY }, dim);
    const corrected = correctFaces(dimmed, mask, compareFaces(reference, dimmed, mask, mask));
    const lifted = meanLab(corrected, 1)[0] - meanLab(dimmed, 1)[0];
    expect(lifted).toBeGreaterThan(12 * LIGHTNESS_SHARE * 0.85);
    expect(lifted).toBeLessThan(12 * LIGHTNESS_SHARE * 1.05);
    // The mid grey floor (below the light-tile line) dimmed by the same 12 gets only what lies beyond
    // the photograph band: (12 − LIGHTNESS_BAND) × LIGHTNESS_RETURN.
    expect(meanLab(corrected, 3)[0] - meanLab(dimmed, 3)[0]).toBeCloseTo(
      (12 - LIGHTNESS_BAND) * LIGHTNESS_RETURN,
      0,
    );
    const brighter = room({ wall: WHITE, floor: GREY }, warm(0));
    const kept = correctFaces(brighter, mask, compareFaces(reference, brighter, mask, mask));
    expect(Math.abs(meanLab(kept, 1)[0] - meanLab(brighter, 1)[0])).toBeLessThan(0.3);
  });

  it('warns about a white wall turning warm (stage 3), not about a stone wall losing warmth (2026-09-25)', () => {
    const change = (reference: [number, number, number], result: [number, number, number]) => ({
      region: 1,
      kind: 'wall' as const,
      reference,
      result,
      deltaE: deltaE2000(reference, result),
      colorDeltaE: deltaE2000(reference, [reference[0], result[1], result[2]]),
      lightnessDelta: result[0] - reference[0],
      shift: 'warmer' as const,
    });
    // Measured faces: stage-3 white walls, and a 2026-09-25 stone wall.
    expect(isColorWarning(change([87.7, -0.5, 2.5], [72.5, 0.9, 4.3]))).toBe(true);
    expect(isColorWarning(change([77.7, -0.5, 2.3], [77, 0.2, 4.4]))).toBe(true);
    expect(isColorWarning(change([72.4, 0.3, 6.1], [53.8, 1.5, 4.5]))).toBe(false);
    expect(isColorWarning(change([42.2, 0, 3.6], [49.1, 0.8, -1.5]))).toBe(false);
    // Any tile whose colour moved far.
    expect(isColorWarning(change([60, 10, 20], [60, -5, 5]))).toBe(true);
  });

  it("warns about a tile drawn much lighter or darker, not about the photograph's light", () => {
    const change = (reference: [number, number, number], result: [number, number, number]) => ({
      region: 1,
      kind: 'wall' as const,
      reference,
      result,
      deltaE: deltaE2000(reference, result),
      colorDeltaE: deltaE2000(reference, [reference[0], result[1], result[2]]),
      lightnessDelta: result[0] - reference[0],
      shift: 'warmer' as const,
    });
    // Measured faces (2026-09-27 saved results, the 2026-10-04 charcoal room): charcoal and
    // terrazzo walls lit up to mid grey by 24–44; a mid grey floor lit by 11–17; a light wall by ±7.
    const charcoal = change([34, -0.9, -2.6], [62.5, -0.8, -2.4]);
    expect(lightnessWarning(charcoal)).toBe('lighter');
    expect(isColorWarning(charcoal)).toBe(true);
    expect(isColorShiftWarning(charcoal)).toBe(false);
    expect(lightnessWarning(change([39.8, 0, 3.6], [64, 0.1, 3.8]))).toBe('lighter');
    expect(lightnessWarning(change([75, 0, 2], [52, 0, 2]))).toBe('darker');
    for (const [from, to] of [
      [53.4, 68.3],
      [53.6, 70.2],
      [47.7, 61.9],
      [84.4, 79],
      [75.2, 82.3],
      // The 2026-09-25 stone wall that went from 72.4 to 53.8 and the stage-3 white wall (87.7 → 72.5).
      [72.4, 53.8],
      [87.7, 72.5],
    ])
      expect(lightnessWarning(change([from, 0, 2], [to, 0, 2]))).toBeUndefined();
  });
});

describe('lightness', () => {
  it('returns nothing inside the photograph band and most of what lies beyond it, either way', () => {
    const ref = (L: number): [number, number, number] => [L, 0, 2];
    // Inside the band the model's light stays; dark tiles lit and mid tiles darkened both come back.
    expect(lightnessReturn(ref(40), ref(40 + LIGHTNESS_BAND))).toBeCloseTo(0, 9);
    expect(lightnessReturn(ref(40), ref(40 - LIGHTNESS_BAND))).toBeCloseTo(0, 9);
    expect(lightnessReturn(ref(40), ref(40 + 5))).toBeCloseTo(0, 9);
    expect(lightnessReturn(ref(40), ref(40 + 46))).toBeCloseTo(-(46 - LIGHTNESS_BAND) * LIGHTNESS_RETURN, 6);
    expect(lightnessReturn(ref(60), ref(60 - 20))).toBeCloseTo((20 - LIGHTNESS_BAND) * LIGHTNESS_RETURN, 6);
    // Never more than MAX_SHIFT_L: farther than that the model drew another material.
    expect(lightnessReturn(ref(20), ref(95))).toBe(-MAX_SHIFT_L);
    // The stage-3 rule is kept: a light tile the model dimmed gets half back (at most LIGHT_TILE_MAX_L) even inside the band.
    expect(lightnessReturn(ref(87.7), ref(87.7 - 15.2))).toBeCloseTo(
      Math.max((15.2 - LIGHTNESS_BAND) * LIGHTNESS_RETURN, 15.2 * LIGHTNESS_SHARE),
      6,
    );
    expect(lightnessReturn(ref(84), ref(84 - 5))).toBeCloseTo(5 * LIGHTNESS_SHARE, 6);
    expect(lightnessReturn(ref(84), ref(84 - 14))).toBeCloseTo(LIGHT_TILE_MAX_L * 0.7, 6);
  });

  const dark: Rgb = [48, 49, 52],
    mid: Rgb = [146, 147, 150];
  /** Lightness set by a Lab addition: the model's brighter (or darker) light on a whole face. */
  const lit =
    (amount: number) =>
    ([r, g, b]: Rgb): Rgb => {
      const [L, a, bb] = rgbToLab(Math.round(r), Math.round(g), Math.round(b));
      return labToRgb(L + amount, a, bb);
    };

  it('puts a charcoal wall the model lit by 46 back near charcoal, keeps its light, texture and fixtures', () => {
    const reference = room({ wall: dark, floor: GREY });
    const result = room({ wall: dark, floor: GREY }, lit(46));
    const changes = compareFaces(reference, result, mask, mask);
    expect(changes.find((c) => c.region === 1)!.lightnessDelta).toBeGreaterThan(40);
    const corrected = correctFaces(result, mask, changes);
    for (const region of [1, 2]) {
      const target = meanLab(reference, region)[0],
        before = meanLab(result, region)[0],
        after = meanLab(corrected, region)[0];
      expect(before - target).toBeGreaterThan(40);
      // What is left is the band and what the return keeps: about LIGHTNESS_BAND + 10% of the rest,
      // and a little more over this small face, where the 4 px fade next to the ceiling strip and the
      // face edges keeps part of the model's light (the whole face is averaged here, not its interior).
      expect(after - target).toBeGreaterThan(LIGHTNESS_BAND - 2);
      expect(after - target).toBeLessThan(
        LIGHTNESS_BAND + (46 - LIGHTNESS_BAND) * (1 - LIGHTNESS_RETURN) + 5,
      );
    }
    // The floor, lit by the same 46, comes back the same way.
    expect(meanLab(result, 3)[0] - meanLab(corrected, 3)[0]).toBeGreaterThan(25);
    for (let i = 0; i < mask.data.length; i++)
      if (mask.data[i] === 0 || mask.data[i] === FIXTURE_REGION)
        expect([...corrected.data.subarray(i * 4, i * 4 + 4)]).toEqual([
          ...result.data.subarray(i * 4, i * 4 + 4),
        ]);
    // Grout lines survive: the texture's contrast (and the light's own gradient) are the model's.
    const tile = (60 * W + 30) * 4,
      grout = (60 * W + 40) * 4;
    const contrast = (image: Pixels) =>
      rgbToLab(image.data[tile], image.data[tile + 1], image.data[tile + 2])[0] -
      rgbToLab(image.data[grout], image.data[grout + 1], image.data[grout + 2])[0];
    expect(contrast(corrected)).toBeCloseTo(contrast(result), 0);
  });

  it("puts back a mid wall the model darkened a lot, and leaves a few L* of the photograph's light alone", () => {
    const reference = room({ wall: mid, floor: GREY });
    const darker = room({ wall: mid, floor: GREY }, lit(-30));
    const back = correctFaces(darker, mask, compareFaces(reference, darker, mask, mask));
    expect(meanLab(back, 1)[0] - meanLab(darker, 1)[0]).toBeGreaterThan(
      (30 - LIGHTNESS_BAND) * LIGHTNESS_RETURN - 1.5,
    );
    for (const amount of [5, -5]) {
      const alike = room({ wall: mid, floor: GREY }, lit(amount));
      const same = correctFaces(alike, mask, compareFaces(reference, alike, mask, mask));
      expect(Math.abs(meanLab(same, 1)[0] - meanLab(alike, 1)[0])).toBeLessThan(0.5);
      expect(Math.abs(meanLab(same, 2)[0] - meanLab(alike, 2)[0])).toBeLessThan(0.5);
    }
  });

  it("corrects the model's empty room under the fixtures when the fixtures are put on afterwards", () => {
    const reference = room({ wall: dark, floor: GREY });
    const result = room({ wall: dark, floor: GREY }, lit(40));
    const changes = compareFaces(reference, result, mask, mask);
    const around = correctFaces(result, mask, changes);
    const under = correctFaces(result, mask, changes, { underFixtures: true });
    const at = (image: Pixels, x: number, y: number) =>
      rgbToLab(...(image.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 3) as unknown as Rgb))[0];
    // A wall pixel two px beside the fixture (x 150..189, y 80..139): the fade leaves it nearly alone.
    expect(at(result, 148, 100) - at(around, 148, 100)).toBeLessThan(12);
    expect(at(result, 148, 100) - at(under, 148, 100)).toBeGreaterThan(25);
    // Inside the fixture: only the empty-room correction touches it. Unchecked pixels never change.
    expect(at(around, 170, 100)).toBe(at(result, 170, 100));
    expect(at(result, 170, 100) - at(under, 170, 100)).toBeGreaterThan(25);
    for (let i = 0; i < mask.data.length; i++)
      if (mask.data[i] === 0)
        expect([...under.data.subarray(i * 4, i * 4 + 4)]).toEqual([
          ...result.data.subarray(i * 4, i * 4 + 4),
        ]);
  });

  it("reports a face the correction cannot bring close to the render's lightness", () => {
    const capture = room({ wall: dark, floor: GREY });
    const layout = fluxInputLayout(W, H);
    const size = { width: layout.width * 2, height: layout.height * 2 };
    const asked = (amount: number) =>
      reviewResultColors({
        capture,
        mask,
        layout,
        result: projectCapture(room({ wall: dark, floor: GREY }, lit(amount)), layout, size),
      });
    const lit46 = asked(46);
    expect(lit46.warnings.map((w) => w.kind)).toContain('wall');
    expect(lit46.unmatched).toEqual([]);
    for (const face of lit46.residual!)
      expect(Math.abs(face.lightnessDelta)).toBeLessThanOrEqual(LIGHTNESS_RESIDUAL_L);
    // Far past MAX_SHIFT_L: the part the correction cannot take back stays.
    const lit90 = asked(90);
    expect(lit90.unmatched.map((w) => w.kind)).toContain('wall');
    for (const face of lit90.unmatched) expect(face.lightnessDelta).toBeGreaterThan(LIGHTNESS_RESIDUAL_L);
    // A result lit like a photograph is neither warned about nor reported.
    const gentle = asked(6);
    expect(gentle.warnings).toEqual([]);
    expect(gentle.unmatched).toEqual([]);
  });
});

describe('reviewResultColors', () => {
  it('reads the result through the padded model input, warns and corrects an aligned result', () => {
    const capture = room({ wall: WHITE, floor: GREY });
    const layout = fluxInputLayout(W, H);
    const size = { width: layout.width * 2, height: layout.height * 2 };
    // The model's answer: the render at result size, with a warm cast on the room (not the padding).
    const drawn = projectCapture(capture, layout, size);
    const tinted = projectCapture(room({ wall: WHITE, floor: GREY }, warm(12)), layout, size);
    const review = reviewResultColors({ capture, mask, layout, result: tinted });
    expect(review.framing.aligned).toBe(true);
    expect(review.warnings.map((w) => w.kind)).toContain('wall');
    expect(review.corrected).toBeDefined();
    for (const face of review.residual!) expect(face.colorDeltaE).toBeLessThan(1.5);
    // An unchanged result is left as it is.
    const clean = reviewResultColors({ capture, mask, layout, result: drawn });
    expect(clean.warnings).toEqual([]);
    for (const face of clean.changes) expect(face.colorDeltaE).toBeLessThan(0.5);
  });
});
