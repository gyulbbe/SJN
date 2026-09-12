/** A single reconstructed object, in TripoSR's x/y/z coordinates (z is up). */
export interface ReconstructedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Model RGB in sRGB space, one RGB triple per vertex. */
  colors?: Float32Array;
}

/** Grid edge endpoints for each shared vertex; used only inside the worker. */
export interface DensityMesh extends ReconstructedMesh {
  crossingEdges: Uint32Array;
}

const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;

// Every cell uses the same body diagonal and face diagonals, including shared
// faces. Unlike a thresholded voxel shell, the interpolated surface is continuous.
const TETRAHEDRA = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
] as const;

/**
 * Marching tetrahedra on an activated density grid. The caller supplies
 * exp(rawDensity - 1), matching TripoSR's released config and threshold 25.
 * Grid order is (x * resolution + y) * resolution + z, as in torch meshgrid(ij).
 * Grid colors are optional: querying the model at returned vertices is better.
 * This CPU operation belongs in the inference worker, not the React render path.
 */
export function extractMesh(
  density: Float32Array,
  colors: Float32Array | undefined,
  resolution: number,
  bound: number,
  threshold: number,
): DensityMesh {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 256) {
    throw new Error('형상 격자 해상도는 2~256 사이의 정수여야 합니다.');
  }
  if (!Number.isFinite(bound) || bound <= 0 || !Number.isFinite(threshold)) {
    throw new Error('형상 추출 범위 또는 밀도 기준이 올바르지 않습니다.');
  }
  const count = resolution ** 3;
  if (density.length !== count || (colors && colors.length !== count * 3)) {
    throw new Error('AI 형상 격자 데이터의 크기가 올바르지 않습니다.');
  }
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(density[i])) throw new Error('AI 형상 밀도에 유효하지 않은 값이 있습니다.');
  }
  if (colors) {
    for (let i = 0; i < colors.length; i++) {
      if (!Number.isFinite(colors[i])) throw new Error('AI 형상 색상에 유효하지 않은 값이 있습니다.');
    }
  }

  const positions: number[] = [];
  const crossingEdges: number[] = [];
  const vertexColors: number[] | undefined = colors ? [] : undefined;
  const indices: number[] = [];
  const edgeVertices = new Map<number, number>();
  const ids = new Int32Array(8);
  const values = new Float32Array(8);
  const step = (2 * bound) / (resolution - 1);
  const plane = resolution * resolution;

  function edgeVertex(cornerA: number, cornerB: number) {
    const originalA = ids[cornerA];
    const originalB = ids[cornerB];
    const t = Math.max(0, Math.min(1, (threshold - values[cornerA]) / (values[cornerB] - values[cornerA])));
    // Exact threshold samples share one vertex even when reached by other edges.
    const a = t === 1 ? originalB : originalA;
    const b = t === 0 ? originalA : originalB;
    const key = Math.min(a, b) * count + Math.max(a, b);
    const existing = edgeVertices.get(key);
    if (existing !== undefined) return existing;
    const vertex = positions.length / 3;
    edgeVertices.set(key, vertex);
    crossingEdges.push(a, b);
    const ax = Math.floor(originalA / plane);
    const ay = Math.floor((originalA % plane) / resolution);
    const az = originalA % resolution;
    const bx = Math.floor(originalB / plane);
    const by = Math.floor((originalB % plane) / resolution);
    const bz = originalB % resolution;
    positions.push(
      -bound + (ax + (bx - ax) * t) * step,
      -bound + (ay + (by - ay) * t) * step,
      -bound + (az + (bz - az) * t) * step,
    );
    if (colors && vertexColors) {
      for (let channel = 0; channel < 3; channel++) {
        const left = colors[originalA * 3 + channel];
        vertexColors.push(left + (colors[originalB * 3 + channel] - left) * t);
      }
    }
    return vertex;
  }

  function triangle(a: number, b: number, c: number, outward: readonly number[]) {
    if (a === b || b === c || a === c) return;
    const ax = positions[b * 3] - positions[a * 3];
    const ay = positions[b * 3 + 1] - positions[a * 3 + 1];
    const az = positions[b * 3 + 2] - positions[a * 3 + 2];
    const bx = positions[c * 3] - positions[a * 3];
    const by = positions[c * 3 + 1] - positions[a * 3 + 1];
    const bz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    if (nx * nx + ny * ny + nz * nz < 1e-24) return;
    if (nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) {
      indices.push(a, c, b);
    } else {
      indices.push(a, b, c);
    }
  }

  for (let x = 0; x < resolution - 1; x++) {
    for (let y = 0; y < resolution - 1; y++) {
      for (let z = 0; z < resolution - 1; z++) {
        let min = Infinity;
        let max = -Infinity;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          const id = ((x + dx) * resolution + y + dy) * resolution + z + dz;
          ids[c] = id;
          values[c] = density[id];
          min = Math.min(min, values[c]);
          max = Math.max(max, values[c]);
        }
        if (min >= threshold || max < threshold) continue;
        for (const tetra of TETRAHEDRA) {
          const inside: number[] = [];
          const outside: number[] = [];
          for (const c of tetra) (values[c] >= threshold ? inside : outside).push(c);
          if (!inside.length || !outside.length) continue;
          const outward = [0, 0, 0];
          for (let axis = 0; axis < 3; axis++) {
            for (const c of outside) outward[axis] += CORNERS[c][axis] / outside.length;
            for (const c of inside) outward[axis] -= CORNERS[c][axis] / inside.length;
          }
          if (inside.length === 1 || outside.length === 1) {
            const single = inside.length === 1 ? inside[0] : outside[0];
            const rest = inside.length === 1 ? outside : inside;
            triangle(
              edgeVertex(single, rest[0]),
              edgeVertex(single, rest[1]),
              edgeVertex(single, rest[2]),
              outward,
            );
          } else {
            const a = edgeVertex(inside[0], outside[0]);
            const b = edgeVertex(inside[0], outside[1]);
            const c = edgeVertex(inside[1], outside[1]);
            const d = edgeVertex(inside[1], outside[0]);
            triangle(a, b, c, outward);
            triangle(a, c, d, outward);
          }
        }
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    crossingEdges: new Uint32Array(crossingEdges),
    ...(vertexColors ? { colors: new Float32Array(vertexColors) } : {}),
  };
}

type SurfaceQuery = (paddedPoints: Float32Array) => Promise<Float32Array>;
interface SurfaceSamplingOptions {
  chunkSize?: number;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Linear interpolation of exp(raw density) does not lie on the actual model
 * surface. Refine each original crossing edge against the decoder itself before
 * querying colors. This keeps the shared topology and does not filter model RGB.
 */
export async function refineMeshSurface(
  mesh: DensityMesh,
  density: Float32Array,
  resolution: number,
  bound: number,
  threshold: number,
  queryDensity: SurfaceQuery,
  { iterations = 7, chunkSize = 8192, onProgress }: SurfaceSamplingOptions & { iterations?: number } = {},
): Promise<Float32Array> {
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 16 ||
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    !Number.isInteger(resolution) ||
    resolution < 2 ||
    resolution > 256 ||
    density.length !== resolution ** 3 ||
    !Number.isFinite(bound) ||
    bound <= 0 ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    mesh.positions.length % 3 ||
    mesh.crossingEdges.length !== (mesh.positions.length / 3) * 2
  ) {
    throw new Error('제품 표면 정밀화 데이터 또는 설정이 올바르지 않아요.');
  }
  const vertices = mesh.positions.length / 3;
  const outside = new Float32Array(mesh.positions.length);
  const inside = new Float32Array(mesh.positions.length);
  const plane = resolution * resolution;
  const coordinate = (sample: number) => (sample / (resolution - 1)) * 2 * bound - bound;
  const endpoint = (id: number, target: Float32Array, offset: number) => {
    target[offset] = coordinate(Math.floor(id / plane));
    target[offset + 1] = coordinate(Math.floor(id / resolution) % resolution);
    target[offset + 2] = coordinate(id % resolution);
  };
  for (let i = 0; i < vertices; i++) {
    let a = mesh.crossingEdges[i * 2],
      b = mesh.crossingEdges[i * 2 + 1];
    if (
      a >= density.length ||
      b >= density.length ||
      !Number.isFinite(density[a]) ||
      !Number.isFinite(density[b]) ||
      (a === b ? density[a] !== threshold : density[a] < threshold === density[b] < threshold)
    ) {
      throw new Error('제품 표면을 좁혀 찾을 수 있는 격자 경계가 없어요.');
    }
    if (density[a] >= threshold) [a, b] = [b, a];
    endpoint(a, outside, i * 3);
    endpoint(b, inside, i * 3);
  }
  for (let round = 0; round < iterations; round++) {
    for (let offset = 0; offset < vertices; offset += chunkSize) {
      // The ONNX graph uses fixed batches. Unused points stay finite zeroes.
      const points = new Float32Array(chunkSize * 3);
      const count = Math.min(chunkSize, vertices - offset);
      for (let i = 0; i < count * 3; i++) {
        points[i] = (outside[offset * 3 + i] + inside[offset * 3 + i]) / 2;
      }
      const values = await queryDensity(points);
      if (values.length !== chunkSize) throw new Error('제품 표면 밀도 출력의 크기가 맞지 않아요.');
      for (let i = 0; i < count; i++) {
        const value = values[i];
        // Activated FP16 density may overflow inside a solid. Positive Infinity
        // still identifies the inside correctly; NaN/negative values do not.
        if (Number.isNaN(value) || value < 0) {
          throw new Error('제품 표면 정밀화에서 유효하지 않은 밀도가 나왔어요.');
        }
        const start = (offset + i) * 3;
        if (value === threshold) {
          outside.set(points.subarray(i * 3, i * 3 + 3), start);
          inside.set(points.subarray(i * 3, i * 3 + 3), start);
        } else {
          (value < threshold ? outside : inside).set(points.subarray(i * 3, i * 3 + 3), start);
        }
      }
      onProgress?.(round * vertices + offset + count, iterations * vertices);
    }
  }
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = (outside[i] + inside[i]) / 2;
  return positions;
}

/** Sample only the final surface coordinates; never reuse pre-refinement RGB. */
export async function sampleSurfaceColors(
  positions: Float32Array,
  queryColor: SurfaceQuery,
  { chunkSize = 8192, onProgress }: SurfaceSamplingOptions = {},
): Promise<Float32Array> {
  if (
    positions.length % 3 ||
    !Number.isInteger(chunkSize) ||
    chunkSize < 1 ||
    positions.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('제품 표면 색상 좌표가 올바르지 않아요.');
  }
  const colors = new Float32Array(positions.length);
  const vertices = positions.length / 3;
  for (let offset = 0; offset < vertices; offset += chunkSize) {
    const count = Math.min(chunkSize, vertices - offset);
    const points = new Float32Array(chunkSize * 3);
    points.set(positions.subarray(offset * 3, (offset + count) * 3));
    const values = await queryColor(points);
    if (values.length !== chunkSize * 3) throw new Error('제품 표면 색상 출력의 크기가 맞지 않아요.');
    for (let i = 0; i < count * 3; i++) {
      if (!Number.isFinite(values[i])) throw new Error('제품 표면에서 유효하지 않은 색상이 나왔어요.');
      colors[offset * 3 + i] = values[i];
    }
    onProgress?.(offset + count, vertices);
  }
  return colors;
}
