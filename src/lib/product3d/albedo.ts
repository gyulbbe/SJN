/**
 * TripoSR vertex colors carry the photo's lighting, so turning the product shows the original
 * shadows on the wrong side. Sanitary ware is made of a few flat materials (glazed ceramic, a
 * wooden cabinet, a coloured panel), so each vertex gets its material's base colour and the
 * viewer lights the surface itself. All colours are sRGB in 0–1.
 *
 * Materials are separated by linear-RGB chromaticity, which a shading multiplier does not change.
 * Neutral parts that differ only in lightness (white glaze, chrome, grey) are deliberately kept
 * together: telling a darker part from a shadowed side is exactly what a single photo cannot do,
 * and guessing wrong would bring the shadows back (even camera-facing crevices between parts
 * photograph near-black). "원본 색" remains for such products.
 */
type Lab = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (t * 24389) / 27 / 116 + 16 / 116);
const labInverse = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : ((116 * t - 16) * 27) / 24389);
const WHITE = [0.95047, 1, 1.08883];

export function srgbToLab(r: number, g: number, b: number): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / WHITE[0];
  const y = (0.2126 * lr + 0.7152 * lg + 0.0722 * lb) / WHITE[1];
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / WHITE[2];
  const [fx, fy, fz] = [labF(x), labF(y), labF(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToSrgb([l, a, b]: Lab): [number, number, number] {
  const fy = (l + 16) / 116;
  const x = labInverse(fy + a / 500) * WHITE[0],
    y = labInverse(fy) * WHITE[1],
    z = labInverse(fy - b / 200) * WHITE[2];
  const linear = [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
  return linear.map((c) => Math.min(1, Math.max(0, toSrgb(Math.max(0, c))))) as [number, number, number];
}

/** Area-weighted vertex normals. */
export function vertexNormals(positions: Float32Array, indices: Uint32Array) {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const length = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    normals[v] /= length;
    normals[v + 1] /= length;
    normals[v + 2] /= length;
  }
  return normals;
}

type Point2 = [number, number];
const distance2 = (a: Point2, b: Point2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
function nearest(centers: Point2[], point: Point2) {
  let best = 0;
  for (let i = 1; i < centers.length; i++)
    if (distance2(point, centers[i]) < distance2(point, centers[best])) best = i;
  return best;
}

/** Plain k-means with deterministic farthest-point seeding. */
function kMeans(points: Point2[], k: number, iterations = 20) {
  const centers: Point2[] = [points[0]];
  while (centers.length < k) {
    let far = points[0],
      farthest = -1;
    for (const p of points) {
      const d = Math.min(...centers.map((c) => distance2(p, c)));
      if (d > farthest) {
        farthest = d;
        far = p;
      }
    }
    centers.push([...far]);
  }
  const labels = new Int32Array(points.length);
  for (let round = 0; round < iterations; round++) {
    const sums = centers.map(() => [0, 0, 0]);
    points.forEach((p, n) => {
      const label = nearest(centers, p);
      labels[n] = label;
      sums[label][0] += p[0];
      sums[label][1] += p[1];
      sums[label][2]++;
    });
    sums.forEach(([x, y, count], i) => {
      if (count) centers[i] = [x / count, y / count];
    });
  }
  return { centers, labels };
}

function weightedQuantile(values: number[], weights: number[], q: number) {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((s, w) => s + w, 0);
  let seen = 0;
  for (const i of order) {
    seen += weights[i];
    if (seen >= total * q) return values[i];
  }
  return values[order[order.length - 1]];
}

export function estimateAlbedo(
  positions: Float32Array,
  indices: Uint32Array,
  colors: Float32Array,
  { sourceDirection = [1, 0, 0] as [number, number, number], maxMaterials = 3, sample = 20000 } = {},
): Float32Array {
  const vertices = colors.length / 3;
  if (!vertices) return new Float32Array(0);
  const normals = vertexNormals(positions, indices);
  // Linear-RGB chromaticity is unchanged by a shading multiplier. Dark areas are left out: in
  // real TripoSR output their hue is a colour cast of the shadow (often warm), not the material.
  const chromaticity: (Point2 | undefined)[] = [];
  const facing = new Float32Array(vertices);
  for (let v = 0; v < vertices; v++) {
    const [r, g, b] = [toLinear(colors[v * 3]), toLinear(colors[v * 3 + 1]), toLinear(colors[v * 3 + 2])];
    const sum = r + g + b;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    chromaticity.push(luminance >= 0.03 ? [r / sum, g / sum] : undefined);
    facing[v] = Math.max(
      0,
      normals[v * 3] * sourceDirection[0] +
        normals[v * 3 + 1] * sourceDirection[1] +
        normals[v * 3 + 2] * sourceDirection[2],
    );
  }
  const stride = Math.max(1, Math.ceil(vertices / sample));
  const picked: number[] = [];
  for (let v = 0; v < vertices; v += stride) if (chromaticity[v]) picked.push(v);
  let groups: Point2[] = [[1 / 3, 1 / 3]];
  if (picked.length) {
    groups = [
      kMeans(
        picked.map((v) => chromaticity[v]!),
        1,
      ).centers[0],
    ];
    for (let k = 2; k <= maxMaterials; k++) {
      const next = kMeans(
        picked.map((v) => chromaticity[v]!),
        k,
      );
      const sizes = next.centers.map((_, c) => next.labels.filter((label) => label === c).length);
      const separated = next.centers.every((a, i) =>
        next.centers.every((b, j) => i === j || Math.sqrt(distance2(a, b)) > 0.08),
      );
      if (!separated || sizes.some((size) => size < picked.length * 0.03)) break;
      groups = next.centers;
    }
  }
  // Dark vertices were left out of the grouping. One whose own hue clearly matches a coloured
  // material is that material in shade (the dark side of an amber bottle, wood under an overhang);
  // shadows on white glaze carry only a faint warm cast and do not match. The rest follow their
  // neighbours below.
  const neutral: Point2 = [1 / 3, 1 / 3];
  const assignment = new Int32Array(vertices).fill(-1);
  for (let v = 0; v < vertices; v++) {
    const hue = chromaticity[v];
    if (hue) {
      assignment[v] = nearest(groups, hue);
      continue;
    }
    const [r, g, b] = [toLinear(colors[v * 3]), toLinear(colors[v * 3 + 1]), toLinear(colors[v * 3 + 2])];
    const sum = r + g + b;
    if (sum > 0.01) {
      const own: Point2 = [r / sum, g / sum];
      const match = nearest(groups, own);
      if (distance2(own, groups[match]) <= 0.08 ** 2 && distance2(groups[match], neutral) > 0.04 ** 2)
        assignment[v] = match;
    }
  }
  const materials = groups.length;
  // Dark vertices take the material of the nearest bright vertex along the surface, so a shadowed
  // tank stays glazed white and a shadowed cabinet stays wood.
  const degree = new Uint32Array(vertices + 1);
  for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) degree[indices[t + k] + 1] += 2;
  for (let v = 0; v < vertices; v++) degree[v + 1] += degree[v];
  const adjacent = new Uint32Array(degree[vertices]);
  const fill = degree.slice(0, vertices);
  for (let t = 0; t < indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k];
      adjacent[fill[v]++] = indices[t + ((k + 1) % 3)];
      adjacent[fill[v]++] = indices[t + ((k + 2) % 3)];
    }
  // A vertex outvoted by its neighbours takes their material: glints on a dark bottle or a stray
  // shadow speck should not seed a patch of another colour.
  const vote = (rounds: number) => {
    const tally = new Int32Array(materials);
    for (let round = 0; round < rounds; round++) {
      const previous = assignment.slice();
      for (let v = 0; v < vertices; v++) {
        if (previous[v] < 0) continue;
        tally.fill(0);
        let labelled = 0;
        for (let n = degree[v]; n < degree[v + 1]; n++) {
          const label = previous[adjacent[n]];
          if (label < 0) continue;
          tally[label]++;
          labelled++;
        }
        let best = previous[v];
        for (let m = 0; m < materials; m++) if (tally[m] > tally[best]) best = m;
        if (tally[best] * 2 > labelled) assignment[v] = best;
      }
    }
  };
  vote(3);
  const queue: number[] = [];
  for (let v = 0; v < vertices; v++) if (assignment[v] >= 0) queue.push(v);
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    for (let n = degree[v]; n < degree[v + 1]; n++) {
      const u = adjacent[n];
      if (assignment[u] >= 0) continue;
      assignment[u] = assignment[v];
      queue.push(u);
    }
  }
  // Pieces with no bright vertex at all (e.g. a black product) use the main material.
  const counts = new Array(materials).fill(0);
  for (let v = 0; v < vertices; v++) if (assignment[v] >= 0) counts[assignment[v]]++;
  const main = Math.max(0, counts.indexOf(Math.max(...counts)));
  for (let v = 0; v < vertices; v++) if (assignment[v] < 0) assignment[v] = main;
  vote(2);
  // Base colour per material from its photographed (source-facing) side.
  const base = Array.from({ length: materials }, (_, m) => {
    const members: number[] = [];
    for (let v = 0; v < vertices; v += stride) if (assignment[v] === m) members.push(v);
    if (!members.length) return undefined;
    const lab = members.map((v) => srgbToLab(colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2]));
    let weights = members.map((v) => facing[v]);
    if (weights.reduce((s, w) => s + w, 0) < 1e-6) weights = members.map(() => 1);
    return labToSrgb([
      // Glazed ware photographs darker than it is; a high quantile keeps white looking white.
      weightedQuantile(
        lab.map((c) => c[0]),
        weights,
        0.85,
      ),
      weightedQuantile(
        lab.map((c) => c[1]),
        weights,
        0.5,
      ),
      weightedQuantile(
        lab.map((c) => c[2]),
        weights,
        0.5,
      ),
    ]);
  });
  const albedo = new Float32Array(colors.length);
  for (let v = 0; v < vertices; v++) albedo.set(base[assignment[v]] ?? [1, 1, 1], v * 3);
  return albedo;
}
