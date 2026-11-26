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
 * - for a ceramic whose cut-out is used, those pixels are first judged per connected piece
 *   (`pieceVerdicts`, 11-17/18): a piece much darker than both sides is the model's shadow (wall); a
 *   piece whose border with the wall is mostly a line the model drew is its fixture (a white tank on a
 *   white wall the cut-out missed); one with hardly any line is wall (the model drew the fixture
 *   elsewhere). Small and thin pieces keep the pixel rule;
 * - a ceramic cut-out that overlaps its render fixture under MIN_IOU (it missed part of the fixture,
 *   say a white tank on a white wall) is not used: that fixture keeps the render's outline, as before;
 * - a thin fitting (a shower rail, a tap; the cut-out rarely holds it) needs no cut-out: its render
 *   pixels that look like the model's wall are wall.
 * - 2026-11-24 (docs/big-fixture-edges-20261124.md): a bath's piece the colour of the model's wall
 *   around (BATH_WALL_LIKE) is wall whatever its lines — the model drew the bath lower or narrower and
 *   a shadow or its wall there; and a render fixture pixel no box holds takes the fixture of the boxes
 *   moved by the model's shift (`movedFixtures`), not none.
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
/**
 * The rescue of a cut-out that fails MIN_IOU (backlog item 10, 2026-11-26, docs/cutout-haze-20261126.md):
 * clipped to CUT_RESCUE.clipCuts px around the render's own fixture (a neighbour the cut-out took along,
 * the bath behind a toilet seen from the side, no longer sinks its overlap), it is used when it reaches
 * `minIou`, covers `recall` of the render's fixture and `top` of its top quarter (a white tank lost on
 * a white wall fails here), and is at most `ratio` times its area. A cut-out that passes as it is stays
 * as it is. Supervisor's blind set 5 / 0 / 7; ceramics on the render's outline 13 → 7 of 58.
 */
export const CUT_RESCUE = {
  clipCuts: 12,
  minIou: 0.5,
  rescueGuard: { recall: 0.75, top: 0.5, ratio: 2.5 },
} as const;
/** A render fixture pixel becomes wall only this near (sRGB distance, a few pixels' mean) the model's wall colour around. */
export const WALL_NEAR = 30;
/**
 * A bath's piece whose mean colour is this near (sRGB) the model's wall colour around is wall, whatever
 * its border lines (2026-11-24: a wedge the model shaded by the rim, the model's wall where the render's
 * rim is higher; blind 5 / 0 / 7 with the moved boxes). Toilets keep the line rule (a white tank on a
 * white wall the cut-out missed).
 */
export const BATH_WALL_LIKE: { kinds: readonly FluxFixture['kind'][]; near: number } = {
  kinds: ['bath'],
  near: 70,
};
/** Each crop is the fixture box grown by this share of its size each way (the model's may be larger). */
export const OUTLINE_PAD = 0.3;
/** A crop smaller than this on either side is not cut out. */
const MIN_CROP = 8;
/** A border step of a piece whose two sides differ this much (sRGB distance) is a line the model drew. */
export const PIECE_LINE = 28;
/** A piece whose border is more than this share of lines is the model's fixture. */
export const PIECE_FIXTURE_SHARE = 0.7;
/** A piece whose border is at most this share of lines is wall; in between, the pixel rule. */
export const PIECE_WALL_SHARE = 0.3;
/** A piece needs this many border steps to be judged by its lines (else the pixel rule). */
const PIECE_MIN_BORDER = 12;
/** A piece thinner than this (pixels ÷ border steps with the wall) is a ring along the outline: the pixel rule. */
const PIECE_MIN_THICK = 3;
/**
 * A piece under this share of the lightness of both the model's wall around and its fixture beside
 * it, and at least SHADOW_GAP darker (0..255), is a shadow the model drew by its fixture: wall,
 * whatever its border (a shadow has a strong edge too) or size.
 */
export const SHADOW_SHARE = 0.5;
const SHADOW_GAP = 12;
const PIECE_WALL = 1,
  PIECE_FIXTURE = -1;

export type OutlineCrop = { fixture: number; left: number; top: number; width: number; height: number };
/** A crop's cut-out alpha (one byte a pixel, top-down, the crop's size). */
export type Cut = OutlineCrop & { alpha: Uint8Array };
export type FixtureVerdict = {
  fixture: number;
  iou: number;
  used: boolean;
  /** Trial rescue (clipCuts): the clipped cut-out's scores, when the plain one did not pass. */
  rescue?: { iou: number; recall: number; top: number; ratio: number; used: boolean };
};
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
  /**
   * For these kinds, a piece whose mean colour is this near (sRGB) the model's wall colour around is
   * wall whatever its border lines (BATH_WALL_LIKE; absent: no such rule).
   */
  wallLike?: { kinds: readonly FluxFixture['kind'][]; near: number };
  /**
   * The same fixtures with their boxes moved by the model's shift (as `renderMask` is).
   * A render fixture pixel outside every box of `fixtures` takes its fixture from these instead of
   * belonging to none (a band of a moved fixture otherwise keeps the model's pixels).
   */
  movedFixtures?: readonly FluxFixture[];
  /**
   * Trial (backlog item 10, default off): before a cut-out is scored, keep only its pixels within this
   * many pixels of the render's own fixture, so a neighbour the cut-out took along (a bath behind a
   * toilet seen from the side) does not sink its overlap.
   */
  clipCuts?: number;
  /** Trial (item 10): the overlap a clipped cut-out needs to be used instead of MIN_IOU. */
  minIou?: number;
  /**
   * Trial (item 10, step 44): with clipCuts, only a cut-out that fails MIN_IOU as it is gets clipped, and
   * the clipped one is used only if it also covers this share of the render's fixture (`recall`), of the
   * render fixture's top quarter (`top`, a white tank the cut-out lost), and is at most `ratio` times
   * the render fixture's area (a thin basin it bloated). Absent: no such checks.
   */
  rescueGuard?: { recall: number; top: number; ratio: number };
}): FixtureOutline {
  const { renderMask, behindMask, fixtures, cuts } = input;
  const { width, height } = renderMask;
  const n = width * height;
  // Each render fixture pixel's own fixture (the smallest box holding it), 1-based over `fixtures`.
  const own = fixtureMask(renderMask, fixtures, FLUX_FIXTURE_KINDS).mask.data;
  if (input.movedFixtures) {
    const moved = fixtureMask(renderMask, input.movedFixtures, FLUX_FIXTURE_KINDS).mask.data;
    for (let i = 0; i < own.length; i++) if (!own[i]) own[i] = moved[i];
  }
  const chosen = fixtures.filter((f) => f.box && FLUX_FIXTURE_KINDS.includes(f.kind));
  const ownIndex = (label: number) => (label ? fixtures.indexOf(chosen[label - 1]) : -1);
  const claimed = new Uint8Array(n),
    reliable = new Set<number>();
  const verdicts: FixtureVerdict[] = [];
  // A cut-out's overlap with its render fixture, the share of that fixture (and of its top quarter) it
  // covers, and its area against the fixture's.
  const score = (cut: Cut) => {
    let both = 0,
      either = 0,
      mine = 0,
      cutArea = 0,
      top = Infinity,
      bottom = -1;
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++) {
        const i = (cut.top + y) * width + cut.left + x;
        const c = cut.alpha[y * cut.width + x] >= 128,
          r = ownIndex(own[i]) === cut.fixture;
        if (c && r) both++;
        if (c || r) either++;
        if (c) cutArea++;
        if (r) {
          mine++;
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    let topMine = 0,
      topBoth = 0;
    const limit = top + (bottom - top + 1) / 4;
    for (let y = top; y < limit && y < cut.height; y++)
      for (let x = 0; x < cut.width; x++) {
        if (ownIndex(own[(cut.top + y) * width + cut.left + x]) !== cut.fixture) continue;
        topMine++;
        if (cut.alpha[y * cut.width + x] >= 128) topBoth++;
      }
    return {
      iou: either ? both / either : 0,
      recall: mine ? both / mine : 0,
      top: topMine ? topBoth / topMine : 0,
      ratio: mine ? cutArea / mine : Infinity,
    };
  };
  const round = (v: number) => +v.toFixed(3);
  for (const original of cuts) {
    let cut = original;
    let iou: number;
    let used: boolean;
    let rescue: FixtureVerdict['rescue'];
    if (input.rescueGuard && input.clipCuts) {
      // Step-44 rescue: a cut-out that passes as it is stays as it is (today's rule).
      iou = score(original).iou;
      used = iou >= MIN_IOU;
      if (!used) {
        const clipped = clipCut(original, own, (label) => ownIndex(label), width, input.clipCuts);
        const s = score(clipped);
        const g = input.rescueGuard;
        const ok =
          s.iou >= (input.minIou ?? MIN_IOU) && s.recall >= g.recall && s.top >= g.top && s.ratio <= g.ratio;
        rescue = {
          iou: round(s.iou),
          recall: round(s.recall),
          top: round(s.top),
          ratio: round(s.ratio),
          used: ok,
        };
        if (ok) {
          cut = clipped;
          used = true;
        }
      }
    } else {
      cut = input.clipCuts
        ? clipCut(original, own, (label) => ownIndex(label), width, input.clipCuts)
        : original;
      iou = score(cut).iou;
      used = iou >= (input.minIou ?? MIN_IOU);
    }
    verdicts.push({ fixture: cut.fixture, iou: round(iou), used, ...(rescue ? { rescue } : {}) });
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
  const piece = pieceVerdicts({
    planes,
    wallColour,
    wall,
    candidate,
    claimed,
    reliable,
    own,
    ownIndex,
    fixtures,
    width,
    height,
    wallLike: input.wallLike,
  });
  const data = Uint8Array.from(renderMask.data);
  const colour = Uint8Array.from(renderMask.data);
  let added = 0,
    removed = 0;
  for (let i = 0; i < n; i++) {
    const render = renderMask.data[i] === FIXTURE_REGION;
    if (piece[i] === PIECE_WALL) {
      const face = behindMask.data[i];
      if (face && face !== FIXTURE_REGION) {
        data[i] = face;
        colour[i] = face;
        removed++;
      }
      continue;
    }
    if (piece[i] === PIECE_FIXTURE) continue;
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

/**
 * Per connected piece of a reliable ceramic's render pixels the cut-out does not hold (11-17/18,
 * docs/fixture-streaks-20261117.md section 12, docs/fixture-shadows-20261118.md): all wall
 * (PIECE_WALL), all the model's fixture (PIECE_FIXTURE) or the pixel rule (0). A piece much darker
 * than both the model's wall around and its fixture beside it is a shadow, so wall. Otherwise a piece
 * whose border with the wall is mostly a line the model drew (its fixture's outline) is fixture, one
 * with hardly any line (the wall goes on) is wall; small and thin pieces keep the pixel rule.
 */
/**
 * A cut-out with only the pixels within `grow` px (chessboard distance) of the render's own fixture
 * (`own` labels mapped to fixture indices by `index`); the rest of its alpha is cleared.
 */
function clipCut(
  cut: Cut,
  own: Uint8Array,
  index: (label: number) => number,
  width: number,
  grow: number,
): Cut {
  const { width: w, height: h } = cut;
  // Mark the render's own fixture inside the crop, then grow it with two separable max passes.
  const mine = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (index(own[(cut.top + y) * width + cut.left + x]) === cut.fixture) mine[y * w + x] = 1;
  const across = new Uint8Array(w * h),
    near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (mine[y * w + x]) last = x;
      if (x - last <= grow) across[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mine[y * w + x]) last = x;
      if (last - x <= grow) across[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (across[y * w + x]) last = y;
      if (y - last <= grow) near[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (across[y * w + x]) last = y;
      if (last - y <= grow) near[y * w + x] = 1;
    }
  }
  const alpha = new Uint8Array(cut.alpha.length);
  for (let i = 0; i < alpha.length; i++) alpha[i] = near[i] ? cut.alpha[i] : 0;
  return { ...cut, alpha };
}

function pieceVerdicts(input: {
  planes: Float32Array[];
  wallColour: { mean: Float32Array }[];
  wall: Float32Array;
  candidate: Float32Array;
  claimed: Uint8Array;
  reliable: ReadonlySet<number>;
  own: Uint8Array;
  ownIndex: (label: number) => number;
  fixtures: readonly FluxFixture[];
  width: number;
  height: number;
  wallLike?: { kinds: readonly FluxFixture['kind'][]; near: number };
}): Int8Array {
  const { planes, wallColour, wall, candidate, claimed, reliable, own, ownIndex, fixtures, width, height } =
    input;
  const n = width * height;
  const piece = new Int8Array(n);
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const lum = (i: number) => 0.299 * planes[0][i] + 0.587 * planes[1][i] + 0.114 * planes[2][i];
  const apart = (i: number, j: number) =>
    Math.hypot(planes[0][i] - planes[0][j], planes[1][i] - planes[1][j], planes[2][i] - planes[2][j]);
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let s = 0; s < n; s++) {
    if (!candidate[s] || seen[s]) continue;
    const index = ownIndex(own[s]);
    if (!CERAMIC_KINDS.includes(fixtures[index].kind) || !reliable.has(index)) continue;
    const members: number[] = [];
    stack.push(s);
    seen[s] = 1;
    const pieceRgb = [0, 0, 0],
      wallRgb = [0, 0, 0];
    let border = 0,
      lines = 0,
      pieceLum = 0,
      wallLum = 0,
      fixLum = 0,
      fixSteps = 0;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      pieceLum += lum(i);
      for (let c = 0; c < 3; c++) {
        pieceRgb[c] += planes[c][i];
        wallRgb[c] += wallColour[c].mean[i];
      }
      // The model's wall around (blurred over its faces, so a shadow by the fixture weighs little).
      wallLum +=
        0.299 * wallColour[0].mean[i] + 0.587 * wallColour[1].mean[i] + 0.114 * wallColour[2].mean[i];
      const x = i % width,
        y = (i - x) / width;
      for (const [dx, dy] of steps) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (candidate[j] && !seen[j] && ownIndex(own[j]) === index) {
          seen[j] = 1;
          stack.push(j);
        } else if (wall[j]) {
          // A step across the border: up to 2 px inside (no deeper than the piece goes, a thin
          // piece's far side is the fixture) against 2 px outside.
          let inside = i;
          for (let d = 1; d <= 2; d++) {
            const tx = x - d * dx,
              ty = y - d * dy;
            if (tx < 0 || ty < 0 || tx >= width || ty >= height) break;
            const t = ty * width + tx;
            if (!candidate[t] || ownIndex(own[t]) !== index) break;
            inside = t;
          }
          const ox = nx + 2 * dx,
            oy = ny + 2 * dy;
          if (ox < 0 || oy < 0 || ox >= width || oy >= height) continue;
          border++;
          if (apart(inside, oy * width + ox) > PIECE_LINE) lines++;
        } else if (claimed[j]) {
          // The model's fixture beside the piece, 2 px into it.
          const fx = nx + 2 * dx,
            fy = ny + 2 * dy;
          fixLum += lum(
            fx >= 0 && fy >= 0 && fx < width && fy < height && claimed[fy * width + fx] ? fy * width + fx : j,
          );
          fixSteps++;
        }
      }
    }
    if (border >= 3 && fixSteps >= 3) {
      const mean = pieceLum / members.length;
      const beside = Math.min(wallLum / members.length, fixLum / fixSteps);
      if (mean < beside * SHADOW_SHARE && beside - mean >= SHADOW_GAP) {
        for (const i of members) piece[i] = PIECE_WALL;
        continue;
      }
    }
    const like = input.wallLike;
    if (like && like.kinds.includes(fixtures[index].kind)) {
      const near = Math.hypot(...pieceRgb.map((v, c) => (v - wallRgb[c]) / members.length));
      if (near < like.near) {
        for (const i of members) piece[i] = PIECE_WALL;
        continue;
      }
    }
    if (border < PIECE_MIN_BORDER || members.length / border < PIECE_MIN_THICK) continue;
    const share = lines / border;
    const verdict = share > PIECE_FIXTURE_SHARE ? PIECE_FIXTURE : share <= PIECE_WALL_SHARE ? PIECE_WALL : 0;
    if (verdict) for (const i of members) piece[i] = verdict;
  }
  return piece;
}
