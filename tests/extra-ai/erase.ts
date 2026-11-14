/**
 * O3 of the added-objects trial (docs/extra-ai-trials-20261114.md, no AI call): on each wall and floor
 * face, the places where the model's picture differs from the render in a way light does not explain
 * (much darker or brighter than the face around it, another colour, or new outlines where the render
 * has none) are taken as objects it added, and filled with the render's detail under the model's light
 * from around them, as the joint restore does (src/lib/ai-export/joints.ts). Placed fixtures, glass and
 * mirrors (the mask's fixture region), a margin round them, and the backdrop are never touched.
 * Pure functions on pixels; the trial's post.ts runs them on results.
 */
import { FIXTURE_REGION, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';

/** Cells (result pixels) the search works in. */
export const CELL = 4;
/** The local median's window, in cells each way. */
export const LOCAL_CELLS = 5;
/** Blocks (cells each way) and the wide median's window (blocks each way): objects larger than the local window. */
export const BLOCK = 4;
export const WIDE_BLOCKS = 3;
/** Log-brightness steps (model over render, against the face around) that make a cell an object. */
export const DARKER = Math.log(1 / 0.75);
export const BRIGHTER = Math.log(1.6);
/** The same against the wide median: a large object, or a broad shadow, has to stand out more. */
export const WIDE_DARKER = Math.log(1 / 0.6);
export const WIDE_BRIGHTER = Math.log(1.9);
/** Chromaticity shift (r and b over the luminance) beyond the face's own shift. */
export const COLOUR = 0.14;
/** A cell's new outline: its edge energy over the render's nearby, against the face's median ratio. */
export const EDGE_RATIO = 3;
/** Mean gradient (levels per 2 px) under which a cell has no outline worth judging. */
export const EDGE_MIN = 6;
/** Smallest object (cells) and the largest share of a face one object may take (more is light). */
export const MIN_CELLS = 4;
export const MAX_FACE_SHARE = 0.35;
/** Result pixels round the fixture region and the backdrop that stay the model's. */
export const PROTECT_PX = 6;
/** Result pixels each side of a seam between two faces that stay the model's. */
export const SEAM_PX = 4;
/** The light blur (share of the width) and how far the render's detail may move it, as in joints.ts. */
const LIGHT_BLUR = 0.012;
const DETAIL_RANGE = [0.55, 1.5] as const;
const MIN_COVER = 0.25;

export type EraseCriteria = { dark: boolean; bright: boolean; colour: boolean; edges: boolean };
export const ALL_CRITERIA: EraseCriteria = { dark: true, bright: true, colour: true, edges: true };
export type ErasedObject = {
  label: number;
  cells: number;
  /** Result pixels: x, y, width, height. */
  box: [number, number, number, number];
  reasons: (keyof EraseCriteria)[];
};
export type EraseResult = {
  image: Pixels;
  objects: ErasedObject[];
  /** Per face label: the share of its pixels changed (any amount). */
  changed: Record<number, number>;
  /** Components left alone because they were too large for an object. */
  skipped: number;
};

const luminance = (data: ArrayLike<number>, o: number) =>
  0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];

/** Weighted box blur (two passes each way) of `value` over `weight`; `cover` is the weight's share. */
function blurInside(
  value: Float32Array,
  weight: Float32Array,
  width: number,
  height: number,
  radius: number,
) {
  const pass = (source: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(source.length);
    const lines = horizontal ? height : width,
      length = horizontal ? width : height,
      step = horizontal ? 1 : width;
    for (let line = 0; line < lines; line++) {
      const start = horizontal ? line * width : line;
      let sum = 0;
      for (let i = 0; i < Math.min(length, radius + 1); i++) sum += source[start + i * step];
      for (let i = 0; i < length; i++) {
        out[start + i * step] = sum;
        const enter = i + radius + 1,
          leave = i - radius;
        if (enter < length) sum += source[start + enter * step];
        if (leave >= 0) sum -= source[start + leave * step];
      }
    }
    return out;
  };
  const twice = (source: Float32Array) => pass(pass(pass(pass(source, true), false), true), false);
  const weighted = new Float32Array(value.length);
  for (let i = 0; i < value.length; i++) weighted[i] = value[i] * weight[i];
  const top = twice(weighted),
    bottom = twice(weight);
  const full = (2 * radius + 1) ** 4;
  const mean = new Float32Array(value.length),
    cover = new Float32Array(value.length);
  for (let i = 0; i < value.length; i++) {
    mean[i] = bottom[i] > 0 ? top[i] / bottom[i] : value[i];
    cover[i] = bottom[i] / full;
  }
  return { mean, cover };
}

/** 1 where a pixel is within `radius` of a set pixel (square reach). */
function dilate(set: Uint8Array, width: number, height: number, radius: number) {
  const across = new Uint8Array(set.length),
    out = new Uint8Array(set.length);
  for (let y = 0; y < height; y++) {
    let last = -Infinity;
    for (let x = 0; x < width; x++) {
      if (set[y * width + x]) last = x;
      if (x - last <= radius) across[y * width + x] = 1;
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (set[y * width + x]) last = x;
      if (last - x <= radius) across[y * width + x] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height; y++) {
      if (across[y * width + x]) last = y;
      if (y - last <= radius) out[y * width + x] = 1;
    }
    last = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (across[y * width + x]) last = y;
      if (last - y <= radius) out[y * width + x] = 1;
    }
  }
  return out;
}

/** Median of the finite values of `grid` in a window round each cell (NaN where too few). */
function windowMedian(grid: Float32Array, gw: number, gh: number, reach: number, least: number) {
  const out = new Float32Array(grid.length).fill(NaN);
  const window = new Float32Array((2 * reach + 1) ** 2);
  for (let cy = 0; cy < gh; cy++)
    for (let cx = 0; cx < gw; cx++) {
      if (Number.isNaN(grid[cy * gw + cx])) continue;
      let k = 0;
      for (let y = Math.max(0, cy - reach); y <= Math.min(gh - 1, cy + reach); y++)
        for (let x = Math.max(0, cx - reach); x <= Math.min(gw - 1, cx + reach); x++) {
          const value = grid[y * gw + x];
          if (!Number.isNaN(value)) window[k++] = value;
        }
      if (k >= least) out[cy * gw + cx] = window.subarray(0, k).sort()[k >> 1];
    }
  return out;
}
/** The wide median: blocks of cells first (their medians), then a median of blocks round each cell. */
function wideMedian(grid: Float32Array, gw: number, gh: number) {
  const bw = Math.ceil(gw / BLOCK),
    bh = Math.ceil(gh / BLOCK);
  const blocks = new Float32Array(bw * bh).fill(NaN);
  const cells = new Float32Array(BLOCK * BLOCK);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let k = 0;
      for (let y = by * BLOCK; y < Math.min(gh, (by + 1) * BLOCK); y++)
        for (let x = bx * BLOCK; x < Math.min(gw, (bx + 1) * BLOCK); x++) {
          const value = grid[y * gw + x];
          if (!Number.isNaN(value)) cells[k++] = value;
        }
      if (k >= (BLOCK * BLOCK) / 2) blocks[by * bw + bx] = cells.subarray(0, k).sort()[k >> 1];
    }
  const wide = windowMedian(blocks, bw, bh, WIDE_BLOCKS, 6);
  const out = new Float32Array(grid.length).fill(NaN);
  for (let cy = 0; cy < gh; cy++)
    for (let cx = 0; cx < gw; cx++)
      if (!Number.isNaN(grid[cy * gw + cx]))
        out[cy * gw + cx] = wide[Math.floor(cy / BLOCK) * bw + Math.floor(cx / BLOCK)];
  return out;
}

/** Gradient magnitude of a luminance plane (central differences). */
function gradient(lum: Float32Array, width: number, height: number) {
  const out = new Float32Array(lum.length);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      out[i] = Math.hypot(lum[i + 1] - lum[i - 1], lum[i + width] - lum[i - width]);
    }
  return out;
}

/**
 * Erases what the model added on the faces `labels` names (mask labels, 1-based; all walls and floors
 * when absent). `reference` (the render) and `mask` are at the result's size, the mask already moved by
 * the model's shift, and `shift` says where the reference's pixel of a result pixel is.
 */
export function eraseAdded(
  reference: Pixels,
  result: Pixels,
  mask: RegionMask,
  options: {
    labels?: ReadonlySet<number>;
    shift?: { dx: number; dy: number };
    criteria?: EraseCriteria;
  } = {},
): EraseResult {
  const { width, height } = result;
  const shift = options.shift ?? { dx: 0, dy: 0 };
  const criteria = options.criteria ?? ALL_CRITERIA;
  const count = width * height;
  const out = new Uint8ClampedArray(result.data);
  const objects: ErasedObject[] = [];
  const changed: Record<number, number> = {};
  let skipped = 0;
  // Fixtures, glass and mirrors, the backdrop and the picture's edge, with a margin, stay the model's.
  const keep = new Uint8Array(count);
  for (let i = 0; i < count; i++)
    if (mask.data[i] === FIXTURE_REGION || mask.data[i] === 0 || mask.outside?.[i]) keep[i] = 1;
  const kept = dilate(keep, width, height, PROTECT_PX);
  // Where two faces meet the model's corner may sit a few pixels off the render's: not an object.
  const seam = new Uint8Array(count);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (
        (x + 1 < width && mask.data[i + 1] !== mask.data[i]) ||
        (y + 1 < height && mask.data[i + width] !== mask.data[i])
      )
        seam[i] = 1;
    }
  const seams = dilate(seam, width, height, SEAM_PX);
  for (let i = 0; i < count; i++) if (seams[i]) kept[i] = 1;
  // The reference under each result pixel, its luminance and the two pictures' outlines.
  const ref = new Float32Array(count * 3),
    refLum = new Float32Array(count),
    aiLum = new Float32Array(count);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rx = Math.max(0, Math.min(width - 1, x - shift.dx)),
        ry = Math.max(0, Math.min(height - 1, y - shift.dy));
      const o = (ry * width + rx) * 4,
        i = y * width + x;
      for (let c = 0; c < 3; c++) ref[i * 3 + c] = reference.data[o + c];
      refLum[i] = luminance(reference.data, o);
      aiLum[i] = luminance(result.data, i * 4);
    }
  const refEdge = criteria.edges ? gradient(refLum, width, height) : undefined;
  const aiEdge = criteria.edges ? gradient(aiLum, width, height) : undefined;
  const gw = Math.ceil(width / CELL),
    gh = Math.ceil(height / CELL);
  const radius = Math.max(2, Math.round(width * LIGHT_BLUR));
  const ones = new Float32Array(count).fill(1);
  const faces = new Set<number>();
  for (let i = 0; i < count; i++) {
    const label = mask.data[i];
    if (label > 0 && label !== FIXTURE_REGION && mask.regions[label - 1]) faces.add(label);
  }
  for (const label of faces) {
    if (options.labels && !options.labels.has(label)) continue;
    const weight = new Float32Array(count);
    let pixels = 0;
    for (let i = 0; i < count; i++)
      if (mask.data[i] === label) {
        weight[i] = 1;
        pixels++;
      }
    // Per cell (only the face's open pixels): the two pictures' colour and outlines.
    const sums = new Float32Array(gw * gh * 9);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!weight[i] || kept[i]) continue;
        const c = (Math.floor(y / CELL) * gw + Math.floor(x / CELL)) * 9;
        for (let k = 0; k < 3; k++) {
          sums[c + k] += result.data[i * 4 + k];
          sums[c + 3 + k] += ref[i * 3 + k];
        }
        if (aiEdge && refEdge) {
          sums[c + 6] += aiEdge[i];
          sums[c + 7] += refEdge[i];
        }
        sums[c + 8]++;
      }
    const cells = gw * gh;
    const logQ = new Float32Array(cells).fill(NaN),
      chromaR = new Float32Array(cells).fill(NaN),
      chromaB = new Float32Array(cells).fill(NaN),
      aiE = new Float32Array(cells),
      refE = new Float32Array(cells).fill(NaN);
    for (let c = 0; c < cells; c++) {
      const n = sums[c * 9 + 8];
      if (n < (CELL * CELL) / 2) continue;
      const [ar, ag, ab, rr, rg, rb] = [0, 1, 2, 3, 4, 5].map((k) => sums[c * 9 + k] / n);
      const al = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab + 1,
        rl = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb + 1;
      logQ[c] = Math.log(al / rl);
      chromaR[c] = ar / al - rr / rl;
      chromaB[c] = ab / al - rb / rl;
      aiE[c] = sums[c * 9 + 6] / n;
      refE[c] = sums[c * 9 + 7] / n;
    }
    const localQ = windowMedian(logQ, gw, gh, LOCAL_CELLS, 10),
      wideQ = wideMedian(logQ, gw, gh);
    const localR = windowMedian(chromaR, gw, gh, LOCAL_CELLS, 10),
      localB = windowMedian(chromaB, gw, gh, LOCAL_CELLS, 10);
    const wideR = wideMedian(chromaR, gw, gh),
      wideB = wideMedian(chromaB, gw, gh);
    // New outlines: a cell's edges over the render's strongest nearby (a moved joint is still near).
    const edgeRatio = new Float32Array(cells).fill(NaN);
    if (criteria.edges)
      for (let cy = 0; cy < gh; cy++)
        for (let cx = 0; cx < gw; cx++) {
          const c = cy * gw + cx;
          if (Number.isNaN(refE[c])) continue;
          let near = 0;
          for (let y = Math.max(0, cy - 1); y <= Math.min(gh - 1, cy + 1); y++)
            for (let x = Math.max(0, cx - 1); x <= Math.min(gw - 1, cx + 1); x++) {
              const value = refE[y * gw + x];
              if (!Number.isNaN(value)) near = Math.max(near, value);
            }
          edgeRatio[c] = (aiE[c] + 1) / (near + 1);
        }
    // The face's usual ratio where the model drew outlines at all (its joints, under its light).
    const finite = [...edgeRatio]
      .filter((value, c) => !Number.isNaN(value) && aiE[c] > EDGE_MIN)
      .sort((a, b) => a - b);
    const edgeMedian = finite.length ? finite[finite.length >> 1] : 1;
    const flag = new Uint8Array(cells),
      why = new Uint8Array(cells);
    let open = 0;
    for (let c = 0; c < cells; c++) {
      if (Number.isNaN(logQ[c])) continue;
      open++;
      const local = Number.isNaN(localQ[c]) ? wideQ[c] : localQ[c];
      if (Number.isNaN(local)) continue;
      const wide = Number.isNaN(wideQ[c]) ? local : wideQ[c];
      let reason = 0;
      if (criteria.dark && (logQ[c] < local - DARKER || logQ[c] < wide - WIDE_DARKER)) reason |= 1;
      if (criteria.bright && (logQ[c] > local + BRIGHTER || logQ[c] > wide + WIDE_BRIGHTER)) reason |= 2;
      if (criteria.colour) {
        const lr = Number.isNaN(localR[c]) ? wideR[c] : localR[c],
          lb = Number.isNaN(localB[c]) ? wideB[c] : localB[c];
        const near = Math.hypot(chromaR[c] - lr, chromaB[c] - lb),
          far = Math.hypot(
            chromaR[c] - (Number.isNaN(wideR[c]) ? lr : wideR[c]),
            chromaB[c] - (Number.isNaN(wideB[c]) ? lb : wideB[c]),
          );
        if (near > COLOUR || far > COLOUR * 1.25) reason |= 4;
      }
      if (criteria.edges && edgeRatio[c] > edgeMedian * EDGE_RATIO && aiE[c] > EDGE_MIN) reason |= 8;
      if (reason) {
        flag[c] = 1;
        why[c] = reason;
      }
    }
    // Objects: 8-connected groups of flagged cells, neither specks nor most of the face.
    const group = new Int32Array(cells).fill(-1);
    const erase = new Uint8Array(cells);
    for (let start = 0; start < cells; start++) {
      if (!flag[start] || group[start] >= 0) continue;
      const members: number[] = [start];
      group[start] = start;
      let reasons = 0;
      for (let k = 0; k < members.length; k++) {
        const c = members[k];
        reasons |= why[c];
        const cx = c % gw,
          cy = Math.floor(c / gw);
        for (let y = Math.max(0, cy - 1); y <= Math.min(gh - 1, cy + 1); y++)
          for (let x = Math.max(0, cx - 1); x <= Math.min(gw - 1, cx + 1); x++) {
            const n = y * gw + x;
            if (flag[n] && group[n] < 0) {
              group[n] = start;
              members.push(n);
            }
          }
      }
      if (members.length < MIN_CELLS) continue;
      if (members.length > open * MAX_FACE_SHARE) {
        skipped++;
        continue;
      }
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const c of members) {
        erase[c] = 1;
        x0 = Math.min(x0, c % gw);
        x1 = Math.max(x1, c % gw);
        y0 = Math.min(y0, Math.floor(c / gw));
        y1 = Math.max(y1, Math.floor(c / gw));
      }
      objects.push({
        label,
        cells: members.length,
        box: [x0 * CELL, y0 * CELL, (x1 - x0 + 1) * CELL, (y1 - y0 + 1) * CELL],
        reasons: (['dark', 'bright', 'colour', 'edges'] as const).filter((_, bit) => reasons & (1 << bit)),
      });
    }
    // One cell round each object (its soft edge and shadow), in pixels, inside the face's open part.
    const area = new Uint8Array(count);
    let any = false;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!weight[i] || kept[i]) continue;
        const cx = Math.floor(x / CELL),
          cy = Math.floor(y / CELL);
        for (let dy = -1; dy <= 1 && !area[i]; dy++)
          for (let dx = -1; dx <= 1 && !area[i]; dx++) {
            const nx = cx + dx,
              ny = cy + dy;
            if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && erase[ny * gw + nx]) area[i] = 1;
          }
        if (area[i]) any = true;
      }
    if (!any) {
      changed[label] = 0;
      continue;
    }
    // The fill: the render's detail under the model's light from the face round the objects.
    const refLight = blurInside(refLum, weight, width, height, radius).mean;
    const lit = new Float32Array(count);
    for (let i = 0; i < count; i++) lit[i] = weight[i] && !area[i] ? 1 : 0;
    const areaF = new Float32Array(count);
    for (let i = 0; i < count; i++) areaF[i] = area[i];
    const alpha = blurInside(areaF, ones, width, height, 2).mean;
    const channels = [0, 1, 2].map((c) => {
      const plane = new Float32Array(count);
      for (let i = 0; i < count; i++) plane[i] = result.data[i * 4 + c];
      const near = blurInside(plane, lit, width, height, radius),
        far = blurInside(plane, lit, width, height, radius * 4);
      return { near, far, plane };
    });
    let touched = 0;
    for (let i = 0; i < count; i++) {
      if (!weight[i] || kept[i]) continue;
      // Inside an object the fill takes over; just outside it fades back to the model's picture.
      const a = area[i] ? 1 : Math.min(1, alpha[i] * 2);
      if (a <= 0) continue;
      touched++;
      const detail = Math.max(
        DETAIL_RANGE[0],
        Math.min(DETAIL_RANGE[1], refLum[i] / Math.max(1, refLight[i])),
      );
      for (let c = 0; c < 3; c++) {
        const { near, far, plane } = channels[c];
        const t = Math.min(1, near.cover[i] / MIN_COVER);
        const light = far.cover[i] > 0 ? near.mean[i] * t + far.mean[i] * (1 - t) : plane[i];
        out[i * 4 + c] = Math.round(result.data[i * 4 + c] * (1 - a) + light * detail * a);
      }
    }
    changed[label] = touched / Math.max(1, pixels);
  }
  return { image: { width, height, data: out }, objects, changed, skipped };
}
