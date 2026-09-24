import { vertexNormals } from './albedo';
import type { DensityMesh } from './geometry';

/**
 * Drops floating fragments: keeps every connected piece with at least `minShare` of the triangles
 * (a toilet roll whose thin holder arm did not reconstruct is still part of the product; a prop cut
 * off at the photo edge is usually smaller and would also tilt the automatic upright) and the
 * largest one, and remaps positions, optional colors and per-vertex crossing edges so surface
 * refinement still works.
 */
export function removeSmallPieces(mesh: DensityMesh, { minShare = 0.05 } = {}): DensityMesh {
  const vertices = mesh.positions.length / 3;
  const parent = new Uint32Array(vertices);
  for (let i = 0; i < vertices; i++) parent[i] = i;
  const find = (value: number) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== root) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const { indices } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t], indices[t + 1]);
    union(indices[t], indices[t + 2]);
  }
  const triangles = new Map<number, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const root = find(indices[t]);
    triangles.set(root, (triangles.get(root) ?? 0) + 1);
  }
  if (triangles.size <= 1) return mesh;
  let largest = -1,
    most = -1;
  for (const [root, count] of triangles)
    if (count > most) {
      largest = root;
      most = count;
    }
  const keep = new Set<number>();
  let keptTriangles = 0;
  for (const [root, count] of triangles)
    if (root === largest || count >= (indices.length / 3) * minShare) {
      keep.add(root);
      keptTriangles += count;
    }
  if (keep.size === triangles.size) return mesh;
  const remap = new Int32Array(vertices).fill(-1);
  let kept = 0;
  for (let t = 0; t < indices.length; t += 3)
    if (keep.has(find(indices[t])))
      for (let k = 0; k < 3; k++) if (remap[indices[t + k]] < 0) remap[indices[t + k]] = kept++;
  const positions = new Float32Array(kept * 3);
  const crossingEdges = new Uint32Array(kept * 2);
  const colors = mesh.colors ? new Float32Array(kept * 3) : undefined;
  for (let v = 0; v < vertices; v++) {
    const to = remap[v];
    if (to < 0) continue;
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), to * 3);
    crossingEdges.set(mesh.crossingEdges.subarray(v * 2, v * 2 + 2), to * 2);
    if (colors) colors.set(mesh.colors!.subarray(v * 3, v * 3 + 3), to * 3);
  }
  const keptIndices = new Uint32Array(keptTriangles * 3);
  let cursor = 0;
  for (let t = 0; t < indices.length; t += 3)
    if (keep.has(find(indices[t]))) for (let k = 0; k < 3; k++) keptIndices[cursor++] = remap[indices[t + k]];
  return { positions, indices: keptIndices, crossingEdges, ...(colors ? { colors } : {}) };
}

/** Vertex neighbours (compressed rows), counted once per triangle side. */
function neighbours(vertices: number, indices: Uint32Array) {
  const degree = new Uint32Array(vertices + 1);
  for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) degree[indices[t + k] + 1] += 2;
  for (let v = 0; v < vertices; v++) degree[v + 1] += degree[v];
  const list = new Uint32Array(degree[vertices]);
  const fill = degree.slice(0, vertices);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    list[fill[a]++] = b;
    list[fill[a]++] = c;
    list[fill[b]++] = a;
    list[fill[b]++] = c;
    list[fill[c]++] = a;
    list[fill[c]++] = b;
  }
  return { offsets: degree, list };
}

/**
 * Normals for lighting. TripoSR surfaces carry a hammered pattern a few grid cells wide; Taubin
 * smoothing deliberately keeps bumps of that size, so the normals themselves are averaged over
 * the surface instead. The drawn outline and the saved geometry stay exactly as they are.
 */
export function shadingNormals(positions: Float32Array, indices: Uint32Array, { iterations = 40 } = {}) {
  const vertices = positions.length / 3;
  const { offsets, list } = neighbours(vertices, indices);
  let current = vertexNormals(positions, indices),
    next = new Float32Array(current.length);
  for (let round = 0; round < iterations; round++) {
    for (let v = 0; v < vertices; v++) {
      let x = current[v * 3],
        y = current[v * 3 + 1],
        z = current[v * 3 + 2];
      for (let n = offsets[v]; n < offsets[v + 1]; n++) {
        const u = list[n] * 3;
        x += current[u];
        y += current[u + 1];
        z += current[u + 2];
      }
      const length = Math.hypot(x, y, z) || 1;
      next[v * 3] = x / length;
      next[v * 3 + 1] = y / length;
      next[v * 3 + 2] = z / length;
    }
    [current, next] = [next, current];
  }
  return current;
}

/**
 * Taubin λ|μ smoothing: a shrinking step followed by an inflating one, so lumps flatten
 * without the volume loss of plain Laplacian smoothing.
 */
export function taubinSmooth(
  positions: Float32Array,
  indices: Uint32Array,
  { iterations = 4, lambda = 0.5, mu = -0.53 } = {},
): Float32Array {
  const vertices = positions.length / 3;
  const { offsets, list } = neighbours(vertices, indices);
  let current = new Float32Array(positions);
  let next = new Float32Array(positions.length);
  for (let round = 0; round < iterations * 2; round++) {
    const step = round % 2 ? mu : lambda;
    for (let v = 0; v < vertices; v++) {
      const start = offsets[v],
        end = offsets[v + 1];
      if (end === start) {
        next.set(current.subarray(v * 3, v * 3 + 3), v * 3);
        continue;
      }
      let x = 0,
        y = 0,
        z = 0;
      for (let n = start; n < end; n++) {
        const u = list[n] * 3;
        x += current[u];
        y += current[u + 1];
        z += current[u + 2];
      }
      const count = end - start;
      next[v * 3] = current[v * 3] + step * (x / count - current[v * 3]);
      next[v * 3 + 1] = current[v * 3 + 1] + step * (y / count - current[v * 3 + 1]);
      next[v * 3 + 2] = current[v * 3 + 2] + step * (z / count - current[v * 3 + 2]);
    }
    [current, next] = [next, current];
  }
  return current;
}

/** Mean distance from each vertex to its neighbour average, relative to the mean edge length. */
export function surfaceRoughness(positions: Float32Array, indices: Uint32Array): number {
  const vertices = positions.length / 3;
  const { offsets, list } = neighbours(vertices, indices);
  let offset = 0,
    edge = 0,
    edges = 0,
    counted = 0;
  for (let v = 0; v < vertices; v++) {
    const start = offsets[v],
      end = offsets[v + 1];
    if (end === start) continue;
    let x = 0,
      y = 0,
      z = 0;
    for (let n = start; n < end; n++) {
      const u = list[n] * 3;
      x += positions[u];
      y += positions[u + 1];
      z += positions[u + 2];
      edge += Math.hypot(
        positions[u] - positions[v * 3],
        positions[u + 1] - positions[v * 3 + 1],
        positions[u + 2] - positions[v * 3 + 2],
      );
      edges++;
    }
    const count = end - start;
    offset += Math.hypot(
      x / count - positions[v * 3],
      y / count - positions[v * 3 + 1],
      z / count - positions[v * 3 + 2],
    );
    counted++;
  }
  return counted && edge ? offset / counted / (edge / edges) : 0;
}

/** Signed volume of a closed mesh; used to check that smoothing keeps the size. */
export function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3,
      b = indices[t + 1] * 3,
      c = indices[t + 2] * 3;
    volume +=
      (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
        positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
        positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) /
      6;
  }
  return volume;
}
