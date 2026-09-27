import { describe, expect, it } from 'vitest';
import {
  compareFaces,
  correctFaces,
  deltaE2000,
  FIXTURE_REGION,
  framing,
  isColorWarning,
  LIGHTNESS_SHARE,
  labToRgb,
  MAX_SHIFT_AB,
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
  it('gives a dimmed light tile half its lightness back, and never darkens a brighter result', () => {
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
    // The dark floor (below the light-tile line) keeps the model's lightness.
    expect(Math.abs(meanLab(corrected, 3)[0] - meanLab(dimmed, 3)[0])).toBeLessThan(0.6);
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
