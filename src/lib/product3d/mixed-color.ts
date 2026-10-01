import { estimateAlbedo, linearToSrgb, srgbToLinear } from './albedo';
import { neighbours, shadingNormalSteps } from './mesh-cleanup';

/**
 * "혼합" colours: what the photo shows keeps its detail, what it does not show is clean product colour.
 *
 * TripoSR rebuilds the product from one photo. The side facing the photo is real information; the
 * sides and the back are the model's guess, and the guess drifts to the shadow and the grey backdrop
 * (a dull grey-brown). The per-material base colours of the lighting correction clean that up but
 * erase every detail that is drawn in colour (a lid seam, a button, a rim). So each vertex mixes two
 * things by how much the photo shows it:
 *  - where it is shown, the base colour times the photo's detail, the colour divided by its own local
 *    average (the broad shading of the photo cancels, a line smaller than `detail` stays);
 *  - where it is not shown, the base colour alone; its form is drawn by the lighting and by darkening
 *    in the grooves and inner corners (`cavity`) instead of by guessed colour.
 * All colours are sRGB in 0–1, like the rest of the product code, and lengths are shares of the
 * product's bounding-box diagonal so a product of any size is treated the same.
 */
export const MIXED = {
  /** Cosine of the angle to the photo's camera where a vertex stops being shown / is fully shown. */
  visible: { none: 0.25, full: 0.65 },
  /** The broad shading of the photo is measured over this length; smaller marks are detail. */
  detail: 0.03,
  /** The detail ratio of a vertex is kept within these bounds. */
  ratio: { darkest: 0.02, brightest: 1.2 },
  /**
   * How much of a mark's own tint is kept (0: only its lightness, 1: its colour as well). The photo's
   * colour fringes along edges are noise; the base colour already carries the material's tint.
   */
  chroma: 0.5,
  /** Grooves and inner corners: smoothing rounds (small, large), dents deeper than `from` darken up to `to`. */
  cavity: {
    iterations: [16, 48],
    from: [0.001, 0.002],
    to: [0.005, 0.012],
    strength: [0.2, 0.25],
  },
  /** Neighbour-averaging rounds of the lighting normals, as in the lighting correction. */
  normalIterations: 40,
};

/** Rounds of normal smoothing the photographed share is read from (the lighting uses more). */
const VISIBILITY_NORMALS = 12;

const smoothstep = (from: number, to: number, x: number) => {
  // Equal limits (a mesh with no size) make it a step instead of 0 / 0.
  const t = to > from ? Math.min(1, Math.max(0, (x - from) / (to - from))) : x > to ? 1 : 0;
  return t * t * (3 - 2 * t);
};

/**
 * How much of each vertex the photo shows, 0–1: from the facing of its normal towards the camera
 * that took the photo, joined by a smooth curve so no edge appears where shown turns into guessed.
 */
export function photographedWeight(
  normals: Float32Array,
  sourceDirection: [number, number, number] = [1, 0, 0],
  { none, full } = MIXED.visible,
): Float32Array {
  const weights = new Float32Array(normals.length / 3);
  for (let v = 0; v < weights.length; v++)
    weights[v] = smoothstep(
      none,
      full,
      normals[v * 3] * sourceDirection[0] +
        normals[v * 3 + 1] * sourceDirection[1] +
        normals[v * 3 + 2] * sourceDirection[2],
    );
  return weights;
}

/** Surface area owned by each vertex (a third of every triangle around it). */
function vertexAreas(positions: Float32Array, indices: Uint32Array) {
  const areas = new Float32Array(positions.length / 3);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const share =
      Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) /
      6; /* half the cross, a third each */
    areas[indices[t]] += share;
    areas[indices[t + 1]] += share;
    areas[indices[t + 2]] += share;
  }
  return areas;
}

function boundsOf(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < positions.length; v += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[v + k]);
      max[k] = Math.max(max[k], positions[v + k]);
    }
  return { min, max, diagonal: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) };
}

const PAD = 3;
const BINS = 6;
const CHANNELS = BINS * 4;

/**
 * The local average of `values` (three numbers per vertex) over the surface around each vertex, each
 * vertex counting by its weight and by how alike its normal is: a side turned away does not leak
 * into a face (so a shaded side face and a lit top stay apart). It is done on a grid with the
 * normals sorted into six axis directions, so it takes time in proportion to the vertex count
 * whatever the radius, and `cell` (about half the radius) sets the length it averages over.
 * A vertex with no weight around it returns its own value, a constant input returns that constant.
 */
export function localAverage(
  positions: Float32Array,
  normals: Float32Array,
  values: Float32Array,
  weights: Float32Array,
  cell: number,
): Float32Array {
  const vertices = weights.length;
  const { min, max } = boundsOf(positions);
  const size = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / cell)) + 1 + PAD * 2);
  const [nx, ny, nz] = size;
  const grid = new Float32Array(nx * ny * nz * CHANNELS);
  // For both the splat and the sample: the eight grid nodes around a point, their weights, and the
  // axis bin the normal falls in (bin = 2·axis + (negative ? 1 : 0), weight = the squared component).
  const node = new Int32Array(8),
    share = new Float32Array(8),
    bin = new Int32Array(3),
    alike = new Float32Array(3);
  const locate = (v: number) => {
    const g = [0, 1, 2].map((k) => (positions[v * 3 + k] - min[k]) / cell + PAD);
    const i = g.map(Math.floor),
      f = g.map((value, k) => value - i[k]);
    for (let corner = 0; corner < 8; corner++) {
      const dx = corner & 1,
        dy = (corner >> 1) & 1,
        dz = (corner >> 2) & 1;
      node[corner] = ((i[2] + dz) * ny + i[1] + dy) * nx + i[0] + dx;
      share[corner] = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    }
    for (let k = 0; k < 3; k++) {
      const n = normals[v * 3 + k];
      bin[k] = k * 2 + (n < 0 ? 1 : 0);
      alike[k] = n * n;
    }
  };
  for (let v = 0; v < vertices; v++) {
    const w = weights[v];
    if (!(w > 0)) continue;
    locate(v);
    for (let corner = 0; corner < 8; corner++)
      for (let k = 0; k < 3; k++) {
        const s = share[corner] * alike[k] * w;
        const at = node[corner] * CHANNELS + bin[k] * 4;
        grid[at] += s * values[v * 3];
        grid[at + 1] += s * values[v * 3 + 1];
        grid[at + 2] += s * values[v * 3 + 2];
        grid[at + 3] += s;
      }
  }
  // Two passes of [1 2 1]/4 along each axis.
  const scratch = new Float32Array(grid.length);
  const strides = [CHANNELS, nx * CHANNELS, nx * ny * CHANNELS];
  for (let pass = 0; pass < 2; pass++)
    for (let axis = 0; axis < 3; axis++) {
      const stride = strides[axis],
        length = size[axis];
      for (let at = 0; at < grid.length; at++) {
        const coordinate = Math.floor(at / stride) % length;
        const before = coordinate > 0 ? grid[at - stride] : 0,
          after = coordinate < length - 1 ? grid[at + stride] : 0;
        scratch[at] = (before + 2 * grid[at] + after) / 4;
      }
      grid.set(scratch);
    }
  const average = new Float32Array(values.length);
  for (let v = 0; v < vertices; v++) {
    locate(v);
    let r = 0,
      g = 0,
      b = 0,
      total = 0;
    for (let corner = 0; corner < 8; corner++)
      for (let k = 0; k < 3; k++) {
        const s = share[corner] * alike[k];
        const at = node[corner] * CHANNELS + bin[k] * 4;
        r += s * grid[at];
        g += s * grid[at + 1];
        b += s * grid[at + 2];
        total += s * grid[at + 3];
      }
    if (total > 1e-6) {
      average[v * 3] = r / total;
      average[v * 3 + 1] = g / total;
      average[v * 3 + 2] = b / total;
    } else average.set(values.subarray(v * 3, v * 3 + 3), v * 3);
  }
  return average;
}

/**
 * How far each vertex lies inside its surroundings along its normal, after `iterations` rounds of
 * rounding the surface (neighbour averaging); positive in a groove or an inner corner. One array
 * per entry of `iterations`, in the model's own units.
 */
export function cavityDepths(
  positions: Float32Array,
  normals: Float32Array,
  rows: { offsets: Uint32Array; list: Uint32Array },
  iterations: number[],
) {
  const vertices = positions.length / 3;
  let current = new Float32Array(positions),
    next = new Float32Array(positions.length);
  const depths: Float32Array[] = [];
  for (let round = 1; round <= Math.max(...iterations); round++) {
    for (let v = 0; v < vertices; v++) {
      let x = current[v * 3],
        y = current[v * 3 + 1],
        z = current[v * 3 + 2];
      for (let n = rows.offsets[v]; n < rows.offsets[v + 1]; n++) {
        const u = rows.list[n] * 3;
        x += current[u];
        y += current[u + 1];
        z += current[u + 2];
      }
      const count = rows.offsets[v + 1] - rows.offsets[v] + 1;
      next[v * 3] = x / count;
      next[v * 3 + 1] = y / count;
      next[v * 3 + 2] = z / count;
    }
    [current, next] = [next, current];
    if (iterations.includes(round)) {
      const depth = new Float32Array(vertices);
      for (let v = 0; v < vertices; v++)
        depth[v] =
          (current[v * 3] - positions[v * 3]) * normals[v * 3] +
          (current[v * 3 + 1] - positions[v * 3 + 1]) * normals[v * 3 + 1] +
          (current[v * 3 + 2] - positions[v * 3 + 2]) * normals[v * 3 + 2];
      depths.push(depth);
    }
  }
  return depths;
}

export interface MixedSurface {
  /** sRGB 0–1, three per vertex. */
  colors: Float32Array;
  /** Normals for the lighting, in the mesh's own frame (`MIXED.normalIterations` rounds of smoothing). */
  normals: Float32Array;
}

export function mixedSurface(
  positions: Float32Array,
  indices: Uint32Array,
  colors: Float32Array,
  { sourceDirection = [1, 0, 0] as [number, number, number], tuning = MIXED } = {},
): MixedSurface {
  const vertices = colors.length / 3;
  if (!vertices) return { colors: new Float32Array(0), normals: new Float32Array(0) };
  // The lighting normals, and on the way to them the lighter smoothing the photographed share is read from.
  const [seen, normals] = shadingNormalSteps(positions, indices, [
    VISIBILITY_NORMALS,
    tuning.normalIterations,
  ]);
  const shown = photographedWeight(seen, sourceDirection, tuning.visible);
  const base = estimateAlbedo(positions, indices, colors, { sourceDirection, visibility: shown });
  const { diagonal } = boundsOf(positions);
  // The photo's colour, linear, and its broad shading: the average over the photographed surface.
  const linear = new Float32Array(colors.length);
  for (let i = 0; i < colors.length; i++) linear[i] = srgbToLinear(colors[i]);
  const areas = vertexAreas(positions, indices);
  const meanArea = areas.reduce((sum, a) => sum + a, 0) / vertices || 1;
  const weights = new Float32Array(vertices);
  for (let v = 0; v < vertices; v++) weights[v] = shown[v] * (areas[v] / meanArea);
  const broad = localAverage(
    positions,
    normals,
    linear,
    weights,
    Math.max((tuning.detail * diagonal) / 2, 1e-9),
  );
  const depths = cavityDepths(positions, normals, neighbours(vertices, indices), tuning.cavity.iterations);
  const out = new Float32Array(colors.length);
  for (let v = 0; v < vertices; v++) {
    let darkening = 1;
    for (let scale = 0; scale < depths.length; scale++)
      darkening *=
        1 -
        tuning.cavity.strength[scale] *
          smoothstep(
            tuning.cavity.from[scale] * diagonal,
            tuning.cavity.to[scale] * diagonal,
            depths[scale][v],
          );
    const lightness = (a: Float32Array) => 0.2126 * a[v * 3] + 0.7152 * a[v * 3 + 1] + 0.0722 * a[v * 3 + 2];
    const grey = lightness(linear) / Math.max(lightness(broad), 1e-4);
    for (let c = 0; c < 3; c++) {
      const i = v * 3 + c;
      let ratio = linear[i] / Math.max(broad[i], 1e-4);
      if (tuning.chroma < 1 && grey > 0) ratio = grey * (ratio / grey) ** tuning.chroma;
      ratio = Math.min(tuning.ratio.brightest, Math.max(tuning.ratio.darkest, ratio));
      out[i] = linearToSrgb(Math.min(1, srgbToLinear(base[i]) * (1 + shown[v] * (ratio - 1)) * darkening));
    }
  }
  return { colors: out, normals };
}
