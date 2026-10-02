/** Closed, outward-wound icosphere for product3d geometry tests. */
export function icosphere(subdivisions = 3, radius = 1) {
  const t = (1 + Math.sqrt(5)) / 2;
  const points: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => {
    const length = Math.hypot(p[0], p[1], p[2]);
    return p.map((value) => value / length);
  });
  let faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let level = 0; level < subdivisions; level++) {
    const cache = new Map<string, number>();
    const middle = (a: number, b: number) => {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      const p = points[a].map((value, i) => (value + points[b][i]) / 2);
      const length = Math.hypot(p[0], p[1], p[2]);
      points.push(p.map((value) => value / length));
      cache.set(key, points.length - 1);
      return points.length - 1;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = middle(a, b),
        bc = middle(b, c),
        ca = middle(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  return {
    positions: new Float32Array(points.flat().map((value) => value * radius)),
    indices: new Uint32Array(faces.flat()),
  };
}

/** Points spread over the six faces of an axis-aligned box centred on the origin. */
export function boxSurfacePoints(size: [number, number, number], perFace = 400) {
  const out: number[] = [];
  const [sx, sy, sz] = size.map((value) => value / 2);
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < perFace; i++) {
    const u = random() * 2 - 1,
      v = random() * 2 - 1;
    out.push(sx, u * sy, v * sz, -sx, u * sy, v * sz);
    out.push(u * sx, sy, v * sz, u * sx, -sy, v * sz);
    out.push(u * sx, v * sy, sz, u * sx, v * sy, -sz);
  }
  return new Float32Array(out);
}

/**
 * The surface of an axis-aligned box as a closed, outward-wound triangle mesh with `divisions` cells
 * along every edge, so that it has enough vertices for point-based searches and smoothing.
 */
export function gridBox(
  [x0, y0, z0]: [number, number, number],
  [x1, y1, z1]: [number, number, number],
  divisions = 20,
) {
  const positions: number[] = [];
  const indices: number[] = [];
  const low = [x0, y0, z0],
    high = [x1, y1, z1];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const b = (axis + 1) % 3,
        c = (axis + 2) % 3;
      const base = positions.length / 3;
      for (let i = 0; i <= divisions; i++)
        for (let j = 0; j <= divisions; j++) {
          const p = [0, 0, 0];
          p[axis] = side ? high[axis] : low[axis];
          p[b] = low[b] + ((high[b] - low[b]) * i) / divisions;
          p[c] = low[c] + ((high[c] - low[c]) * j) / divisions;
          positions.push(...p);
        }
      // b × c points along +axis, so the other side is wound the other way.
      for (let i = 0; i < divisions; i++)
        for (let j = 0; j < divisions; j++) {
          const a = base + i * (divisions + 1) + j,
            d = a + divisions + 1;
          if (side) indices.push(a, d, a + 1, d, d + 1, a + 1);
          else indices.push(a, a + 1, d, d, a + 1, d + 1);
        }
    }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Several meshes as one (their vertices and triangles side by side, not merged). */
export function mergeMeshes(...meshes: { positions: Float32Array; indices: Uint32Array }[]) {
  const positions: number[] = [],
    indices: number[] = [];
  for (const mesh of meshes) {
    const offset = positions.length / 3;
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(index + offset);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
