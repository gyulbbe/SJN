/**
 * Where the model drew each fixture (docs/fixture-haze-20261116.md, F1): today's method lets the model
 * draw the fixtures too, a little larger, smaller or of another shape than the render. The finishing
 * steps (joints, colours, ceramics' lightness) used the render's outline, which left a haze where the
 * render has a fixture and the model drew wall, and a white smear where the model's fixture spilled
 * over the render's outline. Here the app's own cut-out model (BiRefNet, background-removal/) cuts out
 * what stands in front of the wall around each fixture box of the result, and the result's regions are
 * the render's with each fixture where the model drew it:
 *
 * - a pixel the cut-out holds and the render does not is a fixture (the model drew it larger, a tap,
 *   its edge);
 * - a render fixture pixel no cut-out holds becomes the face the render has behind its fixtures (the
 *   render with them hidden) when the model's pixel there also looks like its wall around (WALL_NEAR):
 *   a tap the cut-out left out stays the model's;
 * - a ceramic cut-out that overlaps its render fixture under MIN_IOU (it missed part of the fixture,
 *   say a white tank on a white wall) is not used: that fixture keeps the render's outline, as before;
 * - a thin fitting (a shower rail, a tap; the cut-out rarely holds it) needs no cut-out: its render
 *   pixels that look like the model's wall are wall.
 *
 * `colourMask` also makes every pixel a little like the wall (WALL_NEAR × 2.5) a face for the colour
 * steps only, so it takes the wall's colour change and shows no lighter or darker patch; the joints
 * step keeps the model's pixel there.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from './color';
import { CERAMIC_KINDS, fixtureMask } from './fixture-light';
import { blurInside } from './joints';
import { FLUX_FIXTURE_KINDS, type FluxFixture } from './scene-contract';

export const MIN_IOU = 0.6;
/** A render fixture pixel becomes wall only this near (sRGB distance, a few pixels' mean) the model's wall colour around. */
export const WALL_NEAR = 30;
/** Each crop is the fixture box grown by this share of its size each way (the model's may be larger). */
export const OUTLINE_PAD = 0.3;
/** A crop smaller than this on either side is not cut out. */
const MIN_CROP = 8;

export type OutlineCrop = { fixture: number; left: number; top: number; width: number; height: number };
/** A crop's cut-out alpha (one byte a pixel, top-down, the crop's size). */
export type Cut = OutlineCrop & { alpha: Uint8Array };
export type FixtureVerdict = { fixture: number; iou: number; used: boolean };
export type FixtureOutline = {
  mask: RegionMask;
  colourMask: RegionMask;
  verdicts: FixtureVerdict[];
  /** Pixels that became fixture, and fixture pixels that became wall. */
  added: number;
  removed: number;
};

/** Around every fixture box (fractions of the model's picture), the crop to cut out, in result pixels. */
export function outlineCrops(
  fixtures: readonly FluxFixture[],
  size: { width: number; height: number },
): OutlineCrop[] {
  const crops: OutlineCrop[] = [];
  for (const [fixture, f] of fixtures.entries()) {
    if (!f.box) continue;
    const [l, t, r, b] = f.box;
    const bw = r - l,
      bh = b - t;
    const left = Math.max(0, Math.floor((l - bw * OUTLINE_PAD) * size.width)),
      top = Math.max(0, Math.floor((t - bh * OUTLINE_PAD) * size.height)),
      right = Math.min(size.width, Math.ceil((r + bw * OUTLINE_PAD) * size.width)),
      bottom = Math.min(size.height, Math.ceil((b + bh * OUTLINE_PAD) * size.height));
    if (right - left < MIN_CROP || bottom - top < MIN_CROP) continue;
    crops.push({ fixture, left, top, width: right - left, height: bottom - top });
  }
  return crops;
}

/** A crop of `image` (RGBA, top-down). */
export function cropPixels(image: Pixels, crop: OutlineCrop): Pixels {
  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    const from = ((crop.top + y) * image.width + crop.left) * 4;
    data.set(image.data.subarray(from, from + crop.width * 4), y * crop.width * 4);
  }
  return { width: crop.width, height: crop.height, data };
}

/**
 * `renderMask` and `behindMask` are the render's regions with and without its fixtures at the result's
 * size, moved by the model's shift; `model` the result; `fixtures` the facts (their boxes); `cuts` the
 * cut-outs in result pixels. Without a usable cut-out every fixture keeps the render's outline (thin
 * fittings still lose the render pixels that look like wall).
 */
export function cutoutMask(input: {
  model: Pixels;
  renderMask: RegionMask;
  behindMask: RegionMask;
  fixtures: readonly FluxFixture[];
  cuts: readonly Cut[];
}): FixtureOutline {
  const { renderMask, behindMask, fixtures, cuts } = input;
  const { width, height } = renderMask;
  const n = width * height;
  // Each render fixture pixel's own fixture (the smallest box holding it), 1-based over `fixtures`.
  const own = fixtureMask(renderMask, fixtures, FLUX_FIXTURE_KINDS).mask.data;
  const chosen = fixtures.filter((f) => f.box && FLUX_FIXTURE_KINDS.includes(f.kind));
  const ownIndex = (label: number) => (label ? fixtures.indexOf(chosen[label - 1]) : -1);
  const claimed = new Uint8Array(n),
    reliable = new Set<number>();
  const verdicts: FixtureVerdict[] = [];
  for (const cut of cuts) {
    let both = 0,
      either = 0;
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++) {
        const i = (cut.top + y) * width + cut.left + x;
        const c = cut.alpha[y * cut.width + x] >= 128,
          r = ownIndex(own[i]) === cut.fixture;
        if (c && r) both++;
        if (c || r) either++;
      }
    const iou = either ? both / either : 0;
    const used = iou >= MIN_IOU;
    verdicts.push({ fixture: cut.fixture, iou: +iou.toFixed(3), used });
    if (!used) continue;
    reliable.add(cut.fixture);
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++)
        if (cut.alpha[y * cut.width + x] >= 128) claimed[(cut.top + y) * width + cut.left + x] = 1;
  }
  // The model's wall colour around (its faces outside every fixture, the render's and the cut-outs').
  const wall = new Float32Array(n),
    candidate = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const label = renderMask.data[i];
    if (label && label !== FIXTURE_REGION && !claimed[i]) wall[i] = 1;
    const index = ownIndex(own[i]);
    if (
      label === FIXTURE_REGION &&
      !claimed[i] &&
      index >= 0 &&
      (reliable.has(index) || !CERAMIC_KINDS.includes(fixtures[index].kind))
    )
      candidate[i] = 1;
  }
  const radius = Math.max(4, Math.round(width * 0.02));
  const planes = [0, 1, 2].map((c) => {
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i++) plane[i] = input.model.data[i * 4 + c];
    return plane;
  });
  const wallColour = planes.map((p) => blurInside(p, wall, width, height, radius));
  const apart = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!candidate[i]) continue;
    let d = 0;
    for (let c = 0; c < 3; c++) d += (planes[c][i] - wallColour[c].mean[i]) ** 2;
    apart[i] = wallColour[0].cover[i] > 0 ? Math.sqrt(d) : 255;
  }
  const apartSmooth = blurInside(apart, candidate, width, height, 1).mean;
  const data = Uint8Array.from(renderMask.data);
  const colour = Uint8Array.from(renderMask.data);
  let added = 0,
    removed = 0;
  for (let i = 0; i < n; i++) {
    const render = renderMask.data[i] === FIXTURE_REGION;
    if (candidate[i] && apartSmooth[i] < WALL_NEAR * 2.5) {
      const face = behindMask.data[i];
      if (face && face !== FIXTURE_REGION) colour[i] = face;
    }
    if (claimed[i] && !render && renderMask.data[i]) {
      data[i] = FIXTURE_REGION;
      colour[i] = FIXTURE_REGION;
      added++;
    } else if (candidate[i] && apartSmooth[i] < WALL_NEAR && apart[i] < WALL_NEAR * 1.5) {
      const face = behindMask.data[i];
      if (face && face !== FIXTURE_REGION) {
        data[i] = face;
        removed++;
      }
    }
  }
  return {
    mask: { ...renderMask, data },
    colourMask: { ...renderMask, data: colour },
    verdicts,
    added,
    removed,
  };
}
