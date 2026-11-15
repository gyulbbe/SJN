/**
 * W2 of the fixture-colour trial (docs/fixture-colour-20261115.md): only in the picture sent to the
 * model, each white ceramic (toilet, washbasin, bathtub) is lifted so its mean L* is W2_TARGET_L (its
 * glaze reads white, not grey), by one L* addition so its shading stays. The user's screen is unchanged.
 * A fixture already at least that light is left alone. Its edge pixel takes half the lift.
 */
import {
  FIXTURE_REGION,
  labToRgb,
  projectMask,
  rgbToLab,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import type { FluxFixture } from '../../src/lib/ai-export/scene-contract';
import { CERAMIC_KINDS, fixtureMask } from './w1';

/** The mean L* a white ceramic gets in the model input (the render's #f2f1ec glaze is about 95). */
export const W2_TARGET_L = 93;

export function brightenCeramics(input: {
  /** The model input as the app sends it (layout size, padding included). */
  image: Pixels;
  /** The render's region mask at capture size and the input's layout. */
  mask: RegionMask;
  layout: FluxInputLayout;
  fixtures: readonly FluxFixture[];
}): { image: Pixels; lifted: { kind: FluxFixture['kind']; from: number; add: number }[] } {
  const { width, height } = input.image;
  const { mask, kinds } = fixtureMask(
    projectMask(input.mask, input.layout, { width, height }),
    input.fixtures,
    CERAMIC_KINDS,
  );
  const sums = mask.regions.map(() => ({ L: 0, n: 0 }));
  for (let i = 0; i < mask.data.length; i++) {
    const label = mask.data[i];
    if (!label) continue;
    sums[label - 1].L += rgbToLab(
      input.image.data[i * 4],
      input.image.data[i * 4 + 1],
      input.image.data[i * 4 + 2],
    )[0];
    sums[label - 1].n++;
  }
  const add = sums.map((s) => (s.n >= 30 ? Math.max(0, W2_TARGET_L - s.L / s.n) : 0));
  const out = new Uint8ClampedArray(input.image.data);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const label = mask.data[i];
      if (!label || !add[label - 1]) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        mask.data[i - 1] !== label ||
        mask.data[i + 1] !== label ||
        mask.data[i - width] !== label ||
        mask.data[i + width] !== label;
      const o = i * 4;
      const [L, a, b] = rgbToLab(out[o], out[o + 1], out[o + 2]);
      const [r, g, bl] = labToRgb(Math.min(100, L + add[label - 1] * (edge ? 0.5 : 1)), a, b);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = bl;
    }
  void FIXTURE_REGION;
  return {
    image: { width, height, data: out },
    lifted: sums.map((s, k) => ({
      kind: kinds[k],
      from: s.n ? +(s.L / s.n).toFixed(1) : 0,
      add: +add[k].toFixed(1),
    })),
  };
}
