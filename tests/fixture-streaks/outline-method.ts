/**
 * Trial copy of the app's cutoutMask (src/lib/ai-export/fixture-outline.ts) with candidate O1
 * (docs/fixture-streaks-20261117.md section 12): a reliable ceramic's render pixels the cut-out does not
 * hold are decided per connected piece by whether the model drew a line where the piece meets its wall.
 * With `pieces` off it is the app's rule, pixel for pixel.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import { CERAMIC_KINDS, fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { MIN_IOU, WALL_NEAR, type Cut, type FixtureOutline, type FixtureVerdict } from '../../src/lib/ai-export/fixture-outline';
import { blurInside } from '../../src/lib/ai-export/joints';
import { FLUX_FIXTURE_KINDS, type FluxFixture } from '../../src/lib/ai-export/scene-contract';

/** A border step whose two sides differ this much (sRGB distance) is a line. */
export let PIECE_LINE = 28;
/** A piece whose border is more than this share of lines is the model's fixture. */
export let PIECE_LINE_SHARE = 0.7;
/** A piece whose border is at most this share of lines is wall; in between, the pixel rule. */
export let PIECE_WALL_SHARE = 0.3;
/** A piece needs this many border steps to be judged (else the pixel rule). */
const PIECE_MIN_BORDER = 12;
/** A piece thinner than this (pixels ÷ border steps with the wall) is a ring along the outline: the pixel rule. */
const PIECE_MIN_THICK = 3;
/** Every judged piece of the last calls (for the trial's numbers). */
export const PIECE_LOG: { fixture: number; kind: string; pixels: number; border: number; share: number; wall: boolean }[] = [];
export function setPieceRule(line: number, share: number, wall: number) {
  PIECE_LINE = line;
  PIECE_LINE_SHARE = share;
  PIECE_WALL_SHARE = wall;
}

export function cutoutMaskTrial(input: {
  /** O1: decide the render-only pixels of a reliable ceramic per connected piece (section 12). */
  pieces?: boolean;
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
  // O1: per connected piece of a reliable ceramic's unclaimed render pixels, all wall or all fixture.
  const piece = new Int8Array(n); // 1 wall, -1 fixture, 0 the pixel rule
  if (input.pieces) {
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    const sample = (i: number) => [planes[0][i], planes[1][i], planes[2][i]];
    for (let s = 0; s < n; s++) {
      if (!candidate[s] || seen[s]) continue;
      const index = ownIndex(own[s]);
      if (!CERAMIC_KINDS.includes(fixtures[index].kind) || !reliable.has(index)) continue;
      const members: number[] = [];
      stack.push(s);
      seen[s] = 1;
      let border = 0,
        lines = 0;
      while (stack.length) {
        const i = stack.pop()!;
        members.push(i);
        const x = i % width,
          y = (i - x) / width;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
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
            let ix = x,
              iy = y;
            for (let d = 1; d <= 2; d++) {
              const tx = x - d * dx,
                ty = y - d * dy;
              if (tx < 0 || ty < 0 || tx >= width || ty >= height) break;
              const t = ty * width + tx;
              if (!candidate[t] || ownIndex(own[t]) !== index) break;
              ix = tx;
              iy = ty;
            }
            const ox = nx + 2 * dx,
              oy = ny + 2 * dy;
            if (ox < 0 || oy < 0 || ox >= width || oy >= height) continue;
            const a = sample(iy * width + ix),
              b = sample(oy * width + ox);
            border++;
            if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > PIECE_LINE) lines++;
          }
        }
      }
      if (border < PIECE_MIN_BORDER || members.length / border < PIECE_MIN_THICK) continue;
      const share = lines / border;
      const verdict = share > PIECE_LINE_SHARE ? -1 : share <= PIECE_WALL_SHARE ? 1 : 0;
      PIECE_LOG.push({ fixture: index, kind: fixtures[index].kind, pixels: members.length, border, share: +share.toFixed(2), wall: verdict === 1 });
      if (!verdict) continue;
      for (const i of members) piece[i] = verdict;
    }
  }
  const data = Uint8Array.from(renderMask.data);
  const colour = Uint8Array.from(renderMask.data);
  let added = 0,
    removed = 0;
  for (let i = 0; i < n; i++) {
    const render = renderMask.data[i] === FIXTURE_REGION;
    if (piece[i] === 1) {
      const face = behindMask.data[i];
      if (face && face !== FIXTURE_REGION) {
        data[i] = face;
        colour[i] = face;
        removed++;
      }
      continue;
    }
    if (piece[i] === -1) continue;
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
