import type { ProductMesh } from './state-types';
import type { ProductPhoto } from './photo-color';

/**
 * Where the photo has fine detail (a face drawn in thin lines, a seam, an outline), the mesh's
 * triangles are about two photo pixels wide, so colours read at their corners cannot hold a line
 * thinner than that. The photographed triangles with a strong photo gradient are split in two to
 * four until their edges are about a pixel, and the new corners read the photo as well.
 *
 * This does not change the shape: a new corner sits in the middle of an edge. The result is a mesh
 * of its own (more vertices and triangles, the colours of the new ones averaged from their edge), made
 * every time the product is loaded and never saved, so the saved mesh and its 25 MB limit are as before.
 */
export const REFINE = {
  /** A triangle's edges are split when the photo changes by more than this per pixel (0–255 lightness) near it. */
  gradient: 18,
  /** Edges shorter than this many photo pixels (on screen) are not split, so a split edge ends up at least half of it. */
  edge: 1.7,
  /** Splitting rounds: each at most halves the edges. */
  rounds: 2,
  /** At most this many vertices are added (share of the mesh, and an absolute limit). */
  share: 0.35,
  limit: 80_000,
  /** Corners must show the photo at least this much for their triangles to be split. */
  shown: 0.15,
  /** The gradient is spread by this many pixels, so a thin line's triangles are all reached. */
  spread: 2,
};

/** Stored mesh size the page's renderer accepts (positions, colours, indices), with room to spare. */
const MESH_BYTE_LIMIT = 24 * 1024 * 1024;

/** Lightness change per pixel, 0–255, widened by `spread` pixels. */
export function photoGradient(photo: ProductPhoto, spread = REFINE.spread): Float32Array {
  const { size, data } = photo;
  const lightness = new Float32Array(size * size);
  for (let i = 0; i < lightness.length; i++)
    lightness[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const gradient = new Float32Array(size * size);
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      // Only where both sides are the product: the cut-out's own edge is not detail.
      if (data[i * 4 + 3] < 250 || data[(i - 1) * 4 + 3] < 250 || data[(i + 1) * 4 + 3] < 250) continue;
      if (data[(i - size) * 4 + 3] < 250 || data[(i + size) * 4 + 3] < 250) continue;
      gradient[i] =
        (Math.abs(lightness[i + 1] - lightness[i - 1]) +
          Math.abs(lightness[i + size] - lightness[i - size])) /
        2;
    }
  if (spread <= 0) return gradient;
  const wide = new Float32Array(gradient.length);
  const pass = (from: Float32Array, to: Float32Array, step: number, lines: number, length: number) => {
    for (let line = 0; line < lines; line++)
      for (let k = 0; k < length; k++) {
        let best = 0;
        for (let o = -spread; o <= spread; o++) {
          const j = k + o;
          if (j < 0 || j >= length) continue;
          const value = from[step === 1 ? line * size + j : j * size + line];
          if (value > best) best = value;
        }
        to[step === 1 ? line * size + k : k * size + line] = best;
      }
  };
  pass(gradient, wide, 1, size, size);
  pass(wide, gradient, size, size, size);
  return gradient;
}

interface Refined {
  mesh: ProductMesh;
  /** How many vertices were added. */
  added: number;
}

/**
 * Splits the edges of photographed triangles that sit on detail (see above). `x`, `y` are the
 * vertices' picture positions, `weight` how much each shows the photo (0 where it does not).
 */
export function refineByPhoto(
  mesh: ProductMesh,
  projected: { x: Float32Array; y: Float32Array },
  weight: Float32Array,
  gradient: Float32Array,
  size: number,
  tuning = REFINE,
): Refined {
  let { positions, indices, colors } = mesh;
  let sx = projected.x,
    sy = projected.y,
    shown = weight;
  const vertices0 = positions.length / 3;
  const bytes = (v: number, t: number) => v * 24 + t * 4;
  const budgetVertices = Math.min(tuning.limit, Math.floor(vertices0 * tuning.share));
  let added = 0;
  for (let round = 0; round < tuning.rounds; round++) {
    const vertices = positions.length / 3,
      triangles = indices.length / 3;
    // Score every edge of an interesting triangle by the strongest gradient in the triangle.
    const scores = new Map<number, number>();
    const edgeKey = (a: number, b: number) => (a < b ? a * vertices + b : b * vertices + a);
    for (let t = 0; t < triangles; t++) {
      const a = indices[t * 3],
        b = indices[t * 3 + 1],
        c = indices[t * 3 + 2];
      if (shown[a] < tuning.shown || shown[b] < tuning.shown || shown[c] < tuning.shown) continue;
      const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))),
        x1 = Math.min(size - 1, Math.floor(Math.max(sx[a], sx[b], sx[c]))),
        y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))),
        y1 = Math.min(size - 1, Math.floor(Math.max(sy[a], sy[b], sy[c])));
      let strongest = 0;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) strongest = Math.max(strongest, gradient[y * size + x]);
      if (strongest < tuning.gradient) continue;
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        if (Math.hypot(sx[p] - sx[q], sy[p] - sy[q]) < tuning.edge) continue;
        const key = edgeKey(p, q);
        if ((scores.get(key) ?? 0) < strongest) scores.set(key, strongest);
      }
    }
    if (!scores.size) break;
    const room = Math.min(
      budgetVertices - added,
      Math.floor((MESH_BYTE_LIMIT - bytes(vertices, triangles)) / 60),
    );
    if (room <= 0) break;
    let chosen = [...scores.entries()];
    if (chosen.length > room) chosen = chosen.sort((p, q) => q[1] - p[1]).slice(0, room);
    const middle = new Map<number, number>();
    const nextPositions = new Float32Array((vertices + chosen.length) * 3),
      nextColors = new Float32Array((vertices + chosen.length) * 3),
      nextX = new Float32Array(vertices + chosen.length),
      nextY = new Float32Array(vertices + chosen.length),
      nextShown = new Float32Array(vertices + chosen.length);
    nextPositions.set(positions);
    nextColors.set(colors);
    nextX.set(sx);
    nextY.set(sy);
    nextShown.set(shown);
    chosen.forEach(([key], n) => {
      const a = Math.floor(key / vertices),
        b = key - a * vertices,
        m = vertices + n;
      middle.set(key, m);
      for (let k = 0; k < 3; k++) {
        nextPositions[m * 3 + k] = (positions[a * 3 + k] + positions[b * 3 + k]) / 2;
        nextColors[m * 3 + k] = (colors[a * 3 + k] + colors[b * 3 + k]) / 2;
      }
      nextX[m] = (sx[a] + sx[b]) / 2;
      nextY[m] = (sy[a] + sy[b]) / 2;
      nextShown[m] = Math.min(shown[a], shown[b]);
    });
    const out: number[] = [];
    const push = (a: number, b: number, c: number) => out.push(a, b, c);
    const length = (p: number, q: number) =>
      Math.hypot(
        nextPositions[p * 3] - nextPositions[q * 3],
        nextPositions[p * 3 + 1] - nextPositions[q * 3 + 1],
        nextPositions[p * 3 + 2] - nextPositions[q * 3 + 2],
      );
    for (let t = 0; t < triangles; t++) {
      let v = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      let m = [
        middle.get(edgeKey(v[0], v[1])),
        middle.get(edgeKey(v[1], v[2])),
        middle.get(edgeKey(v[2], v[0])),
      ];
      const count = m.filter((value) => value !== undefined).length;
      if (!count) {
        push(v[0], v[1], v[2]);
        continue;
      }
      // Turn the triangle so the pattern is the same: with one split, the split edge first; with
      // two, the edge left whole last.
      const turn = (by: number) => {
        v = [v[by % 3], v[(by + 1) % 3], v[(by + 2) % 3]];
        m = [m[by % 3], m[(by + 1) % 3], m[(by + 2) % 3]];
      };
      if (count === 1) {
        while (m[0] === undefined) turn(1);
        push(v[0], m[0]!, v[2]);
        push(m[0]!, v[1], v[2]);
      } else if (count === 2) {
        while (m[2] !== undefined) turn(1);
        // a = v0, b = v1, c = v2, m[0] on ab, m[1] on bc
        push(m[0]!, v[1], m[1]!);
        if (length(v[0], m[1]!) <= length(m[0]!, v[2])) {
          push(v[0], m[0]!, m[1]!);
          push(v[0], m[1]!, v[2]);
        } else {
          push(v[0], m[0]!, v[2]);
          push(m[0]!, m[1]!, v[2]);
        }
      } else {
        push(v[0], m[0]!, m[2]!);
        push(m[0]!, v[1], m[1]!);
        push(m[2]!, m[1]!, v[2]);
        push(m[0]!, m[1]!, m[2]!);
      }
    }
    positions = nextPositions;
    colors = nextColors;
    indices = Uint32Array.from(out);
    sx = nextX;
    sy = nextY;
    shown = nextShown;
    added += chosen.length;
    if (added >= budgetVertices) break;
  }
  return { mesh: added ? { positions, indices, colors } : mesh, added };
}
