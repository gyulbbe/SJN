/**
 * W1 of the fixture-colour trial (docs/fixture-colour-20261115.md, no AI call): the white ceramics
 * (toilet, washbasin, bathtub) the model drew much darker than the render get their lightness back,
 * by the walls' own rule (color.ts `lightnessReturn`: nothing inside LIGHTNESS_BAND, 90% of the rest,
 * a light ceramic at least half), as one L* addition per fixture so the model's shading and gloss on it
 * stay. Only darker: a fixture the render had in shade and the model drew white is left alone.
 *
 * Each fixture's pixels are the render's fixture pixels (mask FIXTURE_REGION) inside its box, the
 * smallest box where boxes overlap, moved by the model's shift. The change fades in over FADE_L_PX
 * from the fixture's edge (color.ts `correctFaces`), so the wall beside it never changes.
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
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import type { FluxFixture } from '../../src/lib/ai-export/scene-contract';

export const CERAMIC_KINDS: readonly FluxFixture['kind'][] = ['toilet', 'basin', 'bath'];
/** A fixture smaller than this many pixels inside its edge is not judged. */
export const MIN_FIXTURE_PIXELS = 300;

export type FixtureChange = {
  kind: FluxFixture['kind'];
  pixels: number;
  reference: Lab;
  result: Lab;
  /** L* added (0 when nothing changed). */
  added: number;
};

/** One label per ceramic fixture over the render's fixture pixels (result size, not shifted). */
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
function means(image: Pixels, mask: RegionMask) {
  const { width, height, data } = mask;
  const sums = mask.regions.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
  for (let y = STATS_INSET; y < height - STATS_INSET; y++)
    for (let x = STATS_INSET; x < width - STATS_INSET; x++) {
      const i = y * width + x;
      const label = data[i];
      if (!label) continue;
      if (
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

export function restoreFixtureLightness(input: {
  capture: Pixels;
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
  /** The picture to correct (the app's shown result) and the model's shift on it (result pixels). */
  result: Pixels;
  frame: { dx: number; dy: number };
}): { image?: Pixels; changes: FixtureChange[] } {
  const size = { width: input.result.width, height: input.result.height };
  const reference = projectCapture(input.capture, input.layout, size);
  const { mask, kinds } = fixtureMask(projectMask(input.mask, input.layout, size), input.fixtures);
  if (!mask.regions.length) return { changes: [] };
  const moved = shiftMask(mask, input.frame.dx, input.frame.dy);
  const before = means(reference, mask),
    after = means(input.result, moved);
  const changes: FixtureChange[] = [];
  const faceChanges: FaceChange[] = [];
  for (let k = 0; k < mask.regions.length; k++) {
    const ref = before[k],
      res = after[k];
    if (!ref || !res || ref.n < MIN_FIXTURE_PIXELS || res.n < MIN_FIXTURE_PIXELS) continue;
    const back = Math.max(0, lightnessReturn(ref.lab, res.lab));
    changes.push({ kind: kinds[k], pixels: res.n, reference: ref.lab, result: res.lab, added: back });
    if (back <= 0) continue;
    // Lightness only: the reference's a*, b* are set to the result's so the colour stays the model's.
    faceChanges.push({
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
  if (!faceChanges.length) return { changes };
  return { image: correctFaces(input.result, moved, faceChanges), changes };
}
