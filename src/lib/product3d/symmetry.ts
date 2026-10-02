import { neighbours } from './mesh-cleanup';

/**
 * Left-right symmetry of a product (a toilet, a basin, a bath), and from it which way its front
 * points. A photo shows a product from the side (a 3/4 view), so the model's own axes are not the
 * product's axes: its depth runs diagonally and the shape the model guessed is lopsided. The mirror
 * plane of such a product is a vertical plane, so one search over the plane's turn and shift finds
 * it, and the product's front is the direction along that plane.
 *
 * Everything here works in the standing frame: +z up, any turn about z. The functions only look at
 * points and never at triangles, so they are fast on a 290k-vertex mesh. A plane is trusted only when
 * the mirrored surface lies much closer to the surface than for any other turn of the plane
 * (`undefined` otherwise, the rule being that a wrong fix is worse than none).
 */

export interface MirrorPlane {
  /** Turn of the plane's normal about +z, in radians (the normal is (cos, sin, 0)); the left-right axis. */
  normal: number;
  /** Where the plane is along its normal. */
  offset: number;
}

export interface SymmetryEstimate extends MirrorPlane {
  /** Mean distance between the mirrored surface and the surface, as a share of the product's size. */
  error: number;
  /** The best error among planes turned 20° or more away, divided by `error`: how clear the plane is. */
  dominance: number;
  /** The product's size (bounding-box diagonal), the unit of `error`. */
  size: number;
  /**
   * The plane turned a quarter is a mirror plane too (a rectangular bath, an oval basin): which of
   * the two is left-right is then a matter of the product's real proportions, not of the surface.
   */
  twofold: boolean;
  /** The plane a quarter turn from `normal`, when `twofold`. */
  partner?: MirrorPlane;
}

export interface SymmetryOptions {
  /** Largest `error` that still counts as symmetric. */
  maxError?: number;
  /** Smallest `dominance` that still counts as a clear plane. */
  minDominance?: number;
}

/** Points in a grid, for "the nearest one within a short distance". */
class PointGrid {
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  private readonly size: [number, number, number];
  constructor(
    private readonly points: Float32Array,
    private readonly min: [number, number, number],
    max: [number, number, number],
    private readonly cell: number,
  ) {
    this.size = [0, 1, 2].map((k) => Math.floor((max[k] - min[k]) / cell) + 1) as [number, number, number];
    const count = points.length / 3;
    const total = this.size[0] * this.size[1] * this.size[2];
    this.start = new Int32Array(total + 1);
    const ids = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      ids[i] = this.id(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
      this.start[ids[i] + 1]++;
    }
    for (let c = 0; c < total; c++) this.start[c + 1] += this.start[c];
    const fill = this.start.slice(0, total);
    this.items = new Int32Array(count);
    for (let i = 0; i < count; i++) this.items[fill[ids[i]]++] = i;
  }
  private coordinate(value: number, axis: number) {
    return Math.min(this.size[axis] - 1, Math.max(0, Math.floor((value - this.min[axis]) / this.cell)));
  }
  private id(x: number, y: number, z: number) {
    return (
      (this.coordinate(z, 2) * this.size[1] + this.coordinate(y, 1)) * this.size[0] + this.coordinate(x, 0)
    );
  }
  /** The nearest point within `rings` cells, and its squared distance (Infinity, -1 if none). */
  nearest(x: number, y: number, z: number, rings: number): { distance2: number; index: number } {
    const cx = this.coordinate(x, 0),
      cy = this.coordinate(y, 1),
      cz = this.coordinate(z, 2);
    let best = Infinity,
      index = -1;
    for (let iz = Math.max(0, cz - rings); iz <= Math.min(this.size[2] - 1, cz + rings); iz++)
      for (let iy = Math.max(0, cy - rings); iy <= Math.min(this.size[1] - 1, cy + rings); iy++) {
        const row = (iz * this.size[1] + iy) * this.size[0];
        const from = this.start[row + Math.max(0, cx - rings)],
          to = this.start[row + Math.min(this.size[0] - 1, cx + rings) + 1];
        for (let n = from; n < to; n++) {
          const i = this.items[n] * 3;
          const dx = this.points[i] - x,
            dy = this.points[i + 1] - y,
            dz = this.points[i + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < best) {
            best = d;
            index = this.items[n];
          }
        }
      }
    return { distance2: best, index };
  }
}

function boundsOf(points: Float32Array) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], points[i + k]);
      max[k] = Math.max(max[k], points[i + k]);
    }
  return { min, max, size: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) };
}

const evenly = (points: Float32Array, count: number) => {
  const total = points.length / 3;
  const stride = Math.max(1, Math.floor(total / count));
  const out: number[] = [];
  for (let i = 0; i < total; i += stride) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
  return new Float32Array(out);
};

/** The point mirrored in a plane, written into `out`. */
function reflect(plane: MirrorPlane, x: number, y: number, z: number, out: number[]) {
  const nx = Math.cos(plane.normal),
    ny = Math.sin(plane.normal);
  const away = 2 * (x * nx + y * ny - plane.offset);
  out[0] = x - away * nx;
  out[1] = y - away * ny;
  out[2] = z;
}

/**
 * Finds the vertical mirror plane of the points (standing frame), or undefined when the product is
 * not clearly symmetric about one (round, lopsided, or too few points).
 */
export function estimateSymmetry(
  positions: Float32Array,
  { maxError = 0.02, minDominance = 1.8 }: SymmetryOptions = {},
): SymmetryEstimate | undefined {
  if (positions.length < 3 * 200) return undefined;
  const { min, max, size } = boundsOf(positions);
  if (!(size > 0)) return undefined;
  const cell = size / 50;
  const rings = 2;
  const cap = cell * rings;
  const reference = evenly(positions, 12000);
  const grid = new PointGrid(reference, min, max, cell);
  const queries = evenly(positions, 600);
  const fine = evenly(positions, 2500);
  const mirrored: number[] = [0, 0, 0];
  const error = (plane: MirrorPlane, samples: Float32Array) => {
    let sum = 0;
    const count = samples.length / 3;
    for (let i = 0; i < count; i++) {
      reflect(plane, samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], mirrored);
      const { distance2 } = grid.nearest(mirrored[0], mirrored[1], mirrored[2], rings);
      sum += Math.min(cap, Math.sqrt(distance2));
    }
    return sum / count / size;
  };
  // The plane's shift is searched around the middle of the product along the normal.
  const middle = (normal: number) => {
    const nx = Math.cos(normal),
      ny = Math.sin(normal);
    let low = Infinity,
      high = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const along = positions[i] * nx + positions[i + 1] * ny;
      low = Math.min(low, along);
      high = Math.max(high, along);
    }
    return { centre: (low + high) / 2, extent: high - low };
  };
  const turns = 36;
  const coarse: { normal: number; offset: number; error: number }[] = [];
  for (let t = 0; t < turns; t++) {
    const normal = (t * Math.PI) / turns;
    const { centre, extent } = middle(normal);
    let best = { normal, offset: centre, error: Infinity };
    for (let s = -4; s <= 4; s++) {
      const offset = centre + (s * extent) / 40;
      const e = error({ normal, offset }, queries);
      if (e < best.error) best = { normal, offset, error: e };
    }
    coarse.push(best);
  }
  coarse.sort((a, b) => a.error - b.error);
  // Refine the leading turns on more samples: the turn, then the shift, in ever smaller steps.
  const refine = (start: { normal: number; offset: number }) => {
    let best = { ...start, error: error(start, fine) };
    for (const [turnStep, shiftStep] of [
      [(2.5 * Math.PI) / 180, size / 200],
      [(0.6 * Math.PI) / 180, size / 600],
      [(0.15 * Math.PI) / 180, size / 2000],
    ]) {
      for (let pass = 0; pass < 2; pass++) {
        for (const dn of [-1, 0, 1])
          for (const ds of [-1, 0, 1]) {
            if (!dn && !ds) continue;
            const candidate = { normal: best.normal + dn * turnStep, offset: best.offset + ds * shiftStep };
            const e = error(candidate, fine);
            if (e < best.error) best = { ...candidate, error: e };
          }
      }
    }
    return best;
  };
  const leading = coarse
    .slice(0, 3)
    .map(refine)
    .sort((a, b) => a.error - b.error);
  const best = leading[0];
  const turnAway = (a: number, b: number) => {
    const d = (((a - b) % Math.PI) + Math.PI) % Math.PI;
    return Math.min(d, Math.PI - d);
  };
  // How much better than the best plane that is turned 20° or more away (not counting the plane a
  // quarter turn from it, which a rectangular product has as well): a round product has a mirror
  // plane at every turn and so no clear one.
  const twenty = (20 * Math.PI) / 180;
  let rival = Infinity,
    quarter = Infinity;
  for (const c of coarse) {
    const away = turnAway(c.normal, best.normal);
    const awayQuarter = turnAway(c.normal, best.normal + Math.PI / 2);
    if (away >= twenty && awayQuarter >= twenty) rival = Math.min(rival, c.error);
    if (awayQuarter < twenty / 2) quarter = Math.min(quarter, c.error);
  }
  if (!Number.isFinite(rival)) return undefined;
  const dominance = rival / Math.max(best.error, 1e-9);
  if (best.error > maxError || dominance < minDominance) return undefined;
  const twofold = quarter <= Math.max(best.error * 1.6, maxError / 2);
  const turned = (value: number) => {
    const n = value % (2 * Math.PI);
    return n < 0 ? n + 2 * Math.PI : n;
  };
  let partner: MirrorPlane | undefined;
  if (twofold) {
    const normal = best.normal + Math.PI / 2;
    const { centre } = middle(normal);
    const found = refine({ normal, offset: centre });
    partner = { normal: turned(found.normal), offset: found.offset };
  }
  return {
    normal: turned(best.normal),
    offset: best.offset,
    error: best.error,
    dominance,
    size,
    twofold,
    ...(partner ? { partner } : {}),
  };
}

/** The mean distance between the mirrored surface and the surface, as a share of the product's size. */
export function mirrorError(positions: Float32Array, plane: MirrorPlane): number {
  const { min, max, size } = boundsOf(positions);
  const cell = size / 50;
  const grid = new PointGrid(evenly(positions, 20000), min, max, cell);
  const samples = evenly(positions, 5000);
  const cap = cell * 2;
  const mirrored: number[] = [0, 0, 0];
  let sum = 0;
  const count = samples.length / 3;
  for (let i = 0; i < count; i++) {
    reflect(plane, samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], mirrored);
    sum += Math.min(cap, Math.sqrt(grid.nearest(mirrored[0], mirrored[1], mirrored[2], 2).distance2));
  }
  return sum / count / size;
}

/**
 * Evens out the lopsidedness of the surface about a plane: each vertex moves, along its own normal, half
 * way to where the mirrored surface is, so the surface and its mirror image meet. Vertices whose
 * mirror image has no surface near it (a tap, a handle on one side) stay where they are, and the
 * change fades out between `near` and `far` (shares of the product's size). Only the normal
 * component moves, so the mesh does not shear. Returns new positions.
 */
export function symmetrize(
  positions: Float32Array,
  indices: Uint32Array,
  normals: Float32Array,
  plane: MirrorPlane,
  { near = 0.008, far = 0.02, spread = 12 } = {},
): Float32Array {
  const out = new Float32Array(positions);
  const count = positions.length / 3;
  const shift = new Float32Array(count),
    trust = new Float32Array(count);
  const { min, max, size } = boundsOf(positions);
  const cell = Math.max(size / 100, 1e-9);
  const grid = new PointGrid(positions, min, max, cell);
  const rings = Math.max(1, Math.ceil((far * size) / cell));
  const mirrored: number[] = [0, 0, 0];
  for (let v = 0; v < count; v++) {
    const x = positions[v * 3],
      y = positions[v * 3 + 1],
      z = positions[v * 3 + 2];
    reflect(plane, x, y, z, mirrored);
    const { distance2, index } = grid.nearest(mirrored[0], mirrored[1], mirrored[2], rings);
    if (index < 0) continue;
    const distance = Math.sqrt(distance2) / size;
    if (distance >= far) continue;
    // Where the counterpart's surface is, mirrored: the plane through its mirror image with its mirrored
    // normal. The vertex's distance to that plane (not to the image point, which is off along the
    // surface by up to a vertex spacing and would read as a height on a slope) is the lopsidedness.
    reflect(plane, positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2], mirrored);
    const px = Math.cos(plane.normal),
      py = Math.sin(plane.normal);
    const un = normals[index * 3] * px + normals[index * 3 + 1] * py;
    const rx = normals[index * 3] - 2 * un * px,
      ry = normals[index * 3 + 1] - 2 * un * py,
      rz = normals[index * 3 + 2];
    const nx = normals[v * 3],
      ny = normals[v * 3 + 1],
      nz = normals[v * 3 + 2];
    const along = nx * rx + ny * ry + nz * rz;
    // Faces turned too far from each other are not the same piece of surface.
    if (along < 0.6) continue;
    const gap = ((mirrored[0] - x) * rx + (mirrored[1] - y) * ry + (mirrored[2] - z) * rz) / along;
    const t = distance <= near ? 1 : 1 - (distance - near) / (far - near);
    const weight = t * t * (3 - 2 * t);
    shift[v] = 0.5 * gap;
    trust[v] = weight;
  }
  // Each vertex's own estimate of the lopsidedness jumps with which vertex happens to be nearest to
  // its mirror image, and ends where no counterpart was found; the surface does neither. Averaging the
  // shifts over the neighbours leaves the broad lopsidedness, and lets it die away gently where
  // there is no counterpart instead of ending in a step.
  const { offsets, list } = neighbours(count, indices);
  let current = new Float32Array(count),
    next = new Float32Array(count);
  for (let v = 0; v < count; v++) current[v] = trust[v] * shift[v];
  for (let round = 0; round < spread; round++) {
    for (let v = 0; v < count; v++) {
      let sum = current[v];
      for (let a = offsets[v]; a < offsets[v + 1]; a++) sum += current[list[a]];
      next[v] = sum / (offsets[v + 1] - offsets[v] + 1);
    }
    [current, next] = [next, current];
  }
  for (let v = 0; v < count; v++) {
    out[v * 3] += current[v] * normals[v * 3];
    out[v * 3 + 1] += current[v] * normals[v * 3 + 1];
    out[v * 3 + 2] += current[v] * normals[v * 3 + 2];
  }
  return out;
}

export interface FrontEstimate {
  /** Turn of the front about +z in radians, 0 along +x. */
  front: number;
  /** The two cues disagree, or the end heights are too alike to decide: ask the person. */
  uncertain: boolean;
}

/**
 * Which way along the mirror plane the product's front points. Two cues: the photo was taken
 * from the front side (the end of the product that faces `photo`), and a toilet or basin is lower
 * at its front (bowl) than at its back (tank, wall). The height cue wins when it is clear, and
 * the answer is marked uncertain when the cues disagree.
 * `photo` is the turn about +z of the direction the photo was taken from.
 */
export function estimateFront(positions: Float32Array, plane: MirrorPlane, photo: number): FrontEstimate {
  const along = plane.normal + Math.PI / 2;
  const tx = Math.cos(along),
    ty = Math.sin(along);
  let low = Infinity,
    high = -Infinity;
  const count = positions.length / 3;
  for (let v = 0; v < count; v++) {
    const s = positions[v * 3] * tx + positions[v * 3 + 1] * ty;
    low = Math.min(low, s);
    high = Math.max(high, s);
  }
  const span = high - low;
  // The tallest point within the outer quarter at each end.
  const top = [-Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    const s = (positions[v * 3] * tx + positions[v * 3 + 1] * ty - low) / span;
    if (s < 0.25) top[0] = Math.max(top[0], positions[v * 3 + 2]);
    else if (s > 0.75) top[1] = Math.max(top[1], positions[v * 3 + 2]);
  }
  let zLow = Infinity;
  for (let v = 0; v < count; v++) zLow = Math.min(zLow, positions[v * 3 + 2]);
  const heights = [top[0] - zLow, top[1] - zLow];
  const photoSign = Math.cos(along - photo) >= 0 ? 1 : -1;
  const ratio = Math.min(heights[0], heights[1]) / Math.max(heights[0], heights[1]);
  // The front is the lower end when one end is clearly taller (a tank at the back).
  const lowerSign = heights[1] < heights[0] ? 1 : -1;
  const clear = ratio < 0.8;
  const sign = clear ? lowerSign : photoSign;
  const front = sign === 1 ? along : along + Math.PI;
  const wrapped = ((front + Math.PI) % (2 * Math.PI)) - Math.PI;
  return {
    front: wrapped < -Math.PI ? wrapped + 2 * Math.PI : wrapped,
    uncertain: clear && lowerSign !== photoSign,
  };
}
