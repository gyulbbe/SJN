/**
 * The result's regions with the fixtures where the model drew them (docs/fixture-haze-20261116.md, F1):
 * the render's regions, with each fixture's cut-out (cutout.ts) put in its place. A pixel the cut-out
 * holds and the render does not is a fixture (the model drew it larger, a tap, its edge); a render
 * fixture pixel no cut-out holds is the face the render has behind its fixtures (the model drew wall
 * there) when the model's pixel there also looks like its wall around (WALL_NEAR: a tap the cut-out left
 * out stays the model's). A cut-out that overlaps its render fixture under MIN_IOU (it missed part of the fixture, say a
 * white tank on a white wall) is not used for a ceramic: it keeps the render's outline, as today. A
 * thin fitting (a shower rail, a tap; the cut-out rarely holds it) needs no cut-out: its render pixels
 * that look like the model's wall are wall. `colourMask` makes every such pixel left (one that does not look
 * like the wall: maybe a tap, maybe a lighter patch of wall) a face for the colour steps only, so it
 * takes the wall's colour change and shows no lighter or darker patch; the joints step keeps it.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import { blurInside } from '../../src/lib/ai-export/joints';
import { CERAMIC_KINDS, fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { FLUX_FIXTURE_KINDS, type FluxFixture } from '../../src/lib/ai-export/scene-contract';

export const MIN_IOU = 0.6;
/** A render fixture pixel becomes wall only this near (sRGB distance, a few pixels' mean) the model's wall colour around. */
export const WALL_NEAR = 30;
export type Cut = {
  fixture: number;
  left: number;
  top: number;
  width: number;
  height: number;
  alpha: Uint8Array;
};
export type FixtureVerdict = { fixture: number; iou: number; used: boolean };

/**
 * `renderMask` and `behindMask` are the render's regions with and without its fixtures at the result's
 * size, moved by the model's shift; `fixtures` the facts (their boxes); `cuts` the cut-outs in result
 * pixels, one per fixture index.
 */
export function cutoutMask(input: {
  model: Pixels;
  renderMask: RegionMask;
  behindMask: RegionMask;
  fixtures: readonly FluxFixture[];
  cuts: readonly Cut[];
}): {
  mask: RegionMask;
  colourMask: RegionMask;
  verdicts: FixtureVerdict[];
  added: number;
  removed: number;
} {
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
