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
export function neighbours(vertices: number, indices: Uint32Array) {
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
  return shadingNormalSteps(positions, indices, [iterations])[0];
}

/** `shadingNormals` after each of several numbers of rounds, in one smoothing run (same order as `steps`). */
export function shadingNormalSteps(positions: Float32Array, indices: Uint32Array, steps: number[]) {
  const vertices = positions.length / 3;
  const { offsets, list } = neighbours(vertices, indices);
  let current = vertexNormals(positions, indices),
    next = new Float32Array(current.length);
  const kept = new Map<number, Float32Array>();
  const last = Math.max(...steps);
  if (steps.includes(0)) kept.set(0, current.slice());
  for (let round = 0; round < last; round++) {
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
    if (steps.includes(round + 1)) kept.set(round + 1, round + 1 === last ? current : current.slice());
  }
  return steps.map((step) => kept.get(step)!);
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

/** Mean edge length of a mesh. */
export function meanEdgeLength(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k] * 3,
        b = indices[t + ((k + 1) % 3)] * 3;
      sum += Math.hypot(
        positions[a] - positions[b],
        positions[a + 1] - positions[b + 1],
        positions[a + 2] - positions[b + 2],
      );
    }
  return indices.length ? sum / indices.length : 0;
}

/**
 * Edge-keeping smoothing by bilateral normal filtering (after Zheng et al., 2011): every face's normal
 * becomes the average of the normals of the faces around it, each counting by its area and by how
 * alike its normal is (`sharpness`, the normal difference where its weight falls to 60%), so a flat
 * patch with a hammered pattern is made flat and a crease or a rim, whose faces differ by more than
 * that, is not averaged across. The vertices then move to fit the filtered normals. Taubin smoothing
 * rounds every edge as it flattens; this runs after it to take out the pattern it leaves while the
 * edges stay.
 */
export function bilateralSmooth(
  positions: Float32Array,
  indices: Uint32Array,
  { normalRounds = 6, fitRounds = 20, sharpness = 0.35 } = {},
): Float32Array {
  const triangles = indices.length / 3;
  const vertices = positions.length / 3;
  // Faces around each vertex (compressed rows).
  const start = new Uint32Array(vertices + 1);
  for (let t = 0; t < indices.length; t++) start[indices[t] + 1]++;
  for (let v = 0; v < vertices; v++) start[v + 1] += start[v];
  const faces = new Uint32Array(indices.length);
  const fill = start.slice(0, vertices);
  for (let t = 0; t < indices.length; t++) faces[fill[indices[t]]++] = Math.floor(t / 3);
  const current = new Float32Array(positions);
  const centre = new Float32Array(triangles * 3);
  const normal = new Float32Array(triangles * 3);
  const area = new Float32Array(triangles);
  const measure = () => {
    for (let t = 0; t < triangles; t++) {
      const a = indices[t * 3] * 3,
        b = indices[t * 3 + 1] * 3,
        c = indices[t * 3 + 2] * 3;
      const ux = current[b] - current[a],
        uy = current[b + 1] - current[a + 1],
        uz = current[b + 2] - current[a + 2];
      const vx = current[c] - current[a],
        vy = current[c + 1] - current[a + 1],
        vz = current[c + 2] - current[a + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      area[t] = length / 2;
      normal[t * 3] = length > 0 ? nx / length : 0;
      normal[t * 3 + 1] = length > 0 ? ny / length : 0;
      normal[t * 3 + 2] = length > 0 ? nz / length : 0;
      centre[t * 3] = (current[a] + current[b] + current[c]) / 3;
      centre[t * 3 + 1] = (current[a + 1] + current[b + 1] + current[c + 1]) / 3;
      centre[t * 3 + 2] = (current[a + 2] + current[b + 2] + current[c + 2]) / 3;
    }
  };
  measure();
  // Spatial scale: the distance between the centres of neighbouring faces.
  let spread = 0,
    pairs = 0;
  for (let t = 0; t < triangles; t += 7) {
    const v = indices[t * 3];
    for (let a = start[v]; a < start[v + 1]; a++) {
      const g = faces[a];
      if (g === t) continue;
      spread += Math.hypot(
        centre[t * 3] - centre[g * 3],
        centre[t * 3 + 1] - centre[g * 3 + 1],
        centre[t * 3 + 2] - centre[g * 3 + 2],
      );
      pairs++;
    }
  }
  const sigmaSpace = pairs ? spread / pairs : 1;
  let filtered = new Float32Array(normal),
    scratch = new Float32Array(normal.length);
  const seen = new Int32Array(triangles).fill(-1);
  for (let round = 0; round < normalRounds; round++) {
    for (let t = 0; t < triangles; t++) {
      let x = 0,
        y = 0,
        z = 0;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k];
        for (let a = start[v]; a < start[v + 1]; a++) {
          const g = faces[a];
          if (seen[g] === t + round * triangles) continue;
          seen[g] = t + round * triangles;
          const dx = normal[g * 3] - filtered[t * 3],
            dy = normal[g * 3 + 1] - filtered[t * 3 + 1],
            dz = normal[g * 3 + 2] - filtered[t * 3 + 2];
          const sx = centre[g * 3] - centre[t * 3],
            sy = centre[g * 3 + 1] - centre[t * 3 + 1],
            sz = centre[g * 3 + 2] - centre[t * 3 + 2];
          const weight =
            area[g] *
            Math.exp(-(sx * sx + sy * sy + sz * sz) / (2 * sigmaSpace * sigmaSpace)) *
            Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * sharpness * sharpness));
          x += weight * normal[g * 3];
          y += weight * normal[g * 3 + 1];
          z += weight * normal[g * 3 + 2];
        }
      }
      const length = Math.hypot(x, y, z) || 1;
      scratch[t * 3] = x / length;
      scratch[t * 3 + 1] = y / length;
      scratch[t * 3 + 2] = z / length;
    }
    [filtered, scratch] = [scratch, filtered];
  }
  // Move each vertex to the planes the filtered normals ask for, over its faces.
  const move = new Float32Array(positions.length);
  for (let round = 0; round < fitRounds; round++) {
    for (let v = 0; v < vertices; v++) {
      const count = start[v + 1] - start[v];
      let x = 0,
        y = 0,
        z = 0;
      for (let a = start[v]; a < start[v + 1]; a++) {
        const g = faces[a];
        const nx = filtered[g * 3],
          ny = filtered[g * 3 + 1],
          nz = filtered[g * 3 + 2];
        const gap =
          nx * (centre[g * 3] - current[v * 3]) +
          ny * (centre[g * 3 + 1] - current[v * 3 + 1]) +
          nz * (centre[g * 3 + 2] - current[v * 3 + 2]);
        x += nx * gap;
        y += ny * gap;
        z += nz * gap;
      }
      move[v * 3] = count ? x / count : 0;
      move[v * 3 + 1] = count ? y / count : 0;
      move[v * 3 + 2] = count ? z / count : 0;
    }
    for (let i = 0; i < current.length; i++) current[i] += move[i];
    measure();
  }
  return current;
}

/**
 * How bumpy the surface is at the scale of two rings: the mean height of a vertex above the average
 * of the vertices around it, along the smoothed normal, in mean edge lengths.
 */
export function bumpiness(positions: Float32Array, indices: Uint32Array): number {
  const vertices = positions.length / 3;
  const { offsets, list } = neighbours(vertices, indices);
  const normals = shadingNormals(positions, indices, { iterations: 8 });
  const edge = meanEdgeLength(positions, indices) || 1;
  const stamp = new Int32Array(vertices).fill(-1);
  let sum = 0,
    counted = 0;
  for (let v = 0; v < vertices; v++) {
    let x = 0,
      y = 0,
      z = 0,
      n = 0;
    stamp[v] = v;
    for (let a = offsets[v]; a < offsets[v + 1]; a++) {
      const u = list[a];
      for (let b = offsets[u]; b < offsets[u + 1]; b++) {
        const w = list[b];
        if (stamp[w] === v) continue;
        stamp[w] = v;
        x += positions[w * 3];
        y += positions[w * 3 + 1];
        z += positions[w * 3 + 2];
        n++;
      }
    }
    if (!n) continue;
    sum += Math.abs(
      (x / n - positions[v * 3]) * normals[v * 3] +
        (y / n - positions[v * 3 + 1]) * normals[v * 3 + 1] +
        (z / n - positions[v * 3 + 2]) * normals[v * 3 + 2],
    );
    counted++;
  }
  return counted ? sum / counted / edge : 0;
}

/** Vertices on an edge where the two faces meet at more than `degrees` (a crease, a rim, a seam). */
export function sharpVertexCount(positions: Float32Array, indices: Uint32Array, degrees = 40): number {
  const triangles = indices.length / 3;
  const normals = new Float32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3];
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / length;
    normals[t * 3 + 1] = ny / length;
    normals[t * 3 + 2] = nz / length;
  }
  const vertices = positions.length / 3;
  const first = new Map<number, number>();
  const sharp = new Uint8Array(vertices);
  const limit = Math.cos((degrees * Math.PI) / 180);
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k],
        b = indices[t * 3 + ((k + 1) % 3)];
      const key = a < b ? a * vertices + b : b * vertices + a;
      const other = first.get(key);
      if (other === undefined) {
        first.set(key, t);
        continue;
      }
      const dot =
        normals[t * 3] * normals[other * 3] +
        normals[t * 3 + 1] * normals[other * 3 + 1] +
        normals[t * 3 + 2] * normals[other * 3 + 2];
      if (dot < limit) sharp[a] = sharp[b] = 1;
    }
  let count = 0;
  for (const s of sharp) count += s;
  return count;
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
