/**
 * Putting back the lightness of the white ceramics (toilet, washbasin, bathtub) the model drew much
 * darker than the render (no AI call; docs/fixture-colour-20261115.md, adopted 2026-11-15). The
 * render's wall-hung basin shows a wide flat front a little darker than the walls, and the model often
 * paints it as grey ceramic (L* 83 → 45–67). After the walls' and floors' colours are put back, each
 * ceramic fixture gets the walls' own rule (color.ts `lightnessReturn`: nothing inside LIGHTNESS_BAND,
 * 90% of the rest, a light one at least half of its dimming), as one L* addition so the model's shading
 * and gloss on it stay, faded in over FADE_L_PX from its edge (`correctFaces`). Only darker: a fixture
 * the render had in shade and the model drew white is left alone. Other fixtures (metal, glass,
 * cabinets) and every pixel outside the ceramics stay as they are.
 *
 * A fixture's pixels are the render's fixture pixels (mask FIXTURE_REGION) inside its box (the smallest
 * box where boxes overlap), moved by the model's shift.
 */
import {
  correctFaces,
  FIXTURE_REGION,
  lightnessReturn,
  projectCapture,
  projectMask,
  rgbToLab,
  shiftMask,
  STATS_INSET,
  type FaceChange,
  type Lab,
  type Pixels,
  type RegionMask,
} from './color';
import type { FluxInputLayout } from './contract';
import type { FluxFixture } from './scene-contract';

export const CERAMIC_KINDS: readonly FluxFixture['kind'][] = ['toilet', 'basin', 'bath'];
/** A fixture with fewer pixels than this inside its edge is not judged. */
export const MIN_FIXTURE_PIXELS = 300;

export type FixtureLight = {
  kind: FluxFixture['kind'];
  pixels: number;
  /** Mean Lab of the render and of the result over the fixture. */
  reference: Lab;
  result: Lab;
  /** L* added (0 when the fixture was left as it was). */
  added: number;
};

/** One label per fixture of `kinds` over the render's fixture pixels (the mask's size, not shifted). */
export function fixtureMask(
  mask: RegionMask,
  fixtures: readonly FluxFixture[],
  kinds: readonly FluxFixture['kind'][] = CERAMIC_KINDS,
): { mask: RegionMask; kinds: FluxFixture['kind'][] } {
  const { width, height } = mask;
  const chosen = fixtures.filter((f) => f.box && kinds.includes(f.kind));
  const data = new Uint8Array(width * height);
  const area = (f: FluxFixture) => (f.box![2] - f.box![0]) * (f.box![3] - f.box![1]);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask.data[i] !== FIXTURE_REGION) continue;
      const u = (x + 0.5) / width,
        v = (y + 0.5) / height;
      let best = -1;
      for (let k = 0; k < chosen.length; k++) {
        const [l, t, r, b] = chosen[k].box!;
        if (u < l || u > r || v < t || v > b) continue;
        if (best < 0 || area(chosen[k]) < area(chosen[best])) best = k;
      }
      if (best >= 0) data[i] = best + 1;
    }
  return {
    mask: {
      width,
      height,
      data,
      regions: chosen.map((_, k) => ({ key: `fixture:${k}`, kind: 'wall' as const })),
    },
    kinds: chosen.map((f) => f.kind),
  };
}

/** Mean Lab inside each label, STATS_INSET pixels from its edge. */
function fixtureMeans(image: Pixels, mask: RegionMask) {
  const { width, height, data } = mask;
  const sums = mask.regions.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
  for (let y = STATS_INSET; y < height - STATS_INSET; y++)
    for (let x = STATS_INSET; x < width - STATS_INSET; x++) {
      const i = y * width + x;
      const label = data[i];
      if (
        !label ||
        data[i - STATS_INSET] !== label ||
        data[i + STATS_INSET] !== label ||
        data[i - STATS_INSET * width] !== label ||
        data[i + STATS_INSET * width] !== label
      )
        continue;
      const [L, a, b] = rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]);
      const s = sums[label - 1];
      s.L += L;
      s.a += a;
      s.b += b;
      s.n++;
    }
  return sums.map((s) => (s.n ? { lab: [s.L / s.n, s.a / s.n, s.b / s.n] as Lab, n: s.n } : undefined));
}

/**
 * The step for one result that kept the framing. `capture`, `mask` and `layout` as for
 * reviewResultColors, `fixtures` the facts sent with the conversion (their boxes), `result` the picture
 * to correct (the colour-corrected result) and `frame` the model's shift on it.
 */
export function restoreFixtureLightness(input: {
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  result: Pixels;
  frame: { dx: number; dy: number };
  /** The result's regions where the model drew its fixtures (fixture-outline.ts), moved by its shift. */
  resultMask?: RegionMask;
  /** How much of the lightness the walls' rule gives back a ceramic gets (1 by default). */
  share?: number;
}): { image?: Pixels; fixtures: FixtureLight[] } {
  const size = { width: input.result.width, height: input.result.height };
  const { mask, kinds } = fixtureMask(projectMask(input.mask, input.layout, size), input.fixtures);
  if (!mask.regions.length) return { fixtures: [] };
  const moved = input.resultMask
    ? fixtureMask(input.resultMask, input.fixtures).mask
    : shiftMask(mask, input.frame.dx, input.frame.dy);
  const before = fixtureMeans(projectCapture(input.capture, input.layout, size), mask),
    after = fixtureMeans(input.result, moved);
  const fixtures: FixtureLight[] = [];
  const changes: FaceChange[] = [];
  for (let k = 0; k < mask.regions.length; k++) {
    const ref = before[k],
      res = after[k];
    if (!ref || !res || ref.n < MIN_FIXTURE_PIXELS || res.n < MIN_FIXTURE_PIXELS) continue;
    const added = Math.max(0, lightnessReturn(ref.lab, res.lab)) * (input.share ?? 1);
    fixtures.push({ kind: kinds[k], pixels: res.n, reference: ref.lab, result: res.lab, added });
    if (added <= 0) continue;
    // Lightness only: the reference's a*, b* are the result's, so the colour stays the model's.
    changes.push({
      region: k + 1,
      kind: 'wall',
      reference: [ref.lab[0], res.lab[1], res.lab[2]],
      result: res.lab,
      deltaE: 0,
      colorDeltaE: 0,
      lightnessDelta: res.lab[0] - ref.lab[0],
      shift: 'hue',
    });
  }
  if (!changes.length) return { fixtures };
  return { image: correctFaces(input.result, moved, changes), fixtures };
}
