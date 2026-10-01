import { Quaternion, Vector3 } from 'three';
import type { OutlineImage } from '../../src/lib/product3d/outline-level';
import type { ProductMesh, ProductPose } from '../../src/lib/product3d/state-types';

/** Samples per pixel side: 4 × 4 gives alpha in 17 steps, enough for the sub-pixel edge reading. */
const SUPER = 4;

type Point = [number, number];

/**
 * A polygon filled into an alpha picture (0–255, top row first) with coverage antialiasing. Points
 * are in pixels, y grows downwards, like the pictures the app reads.
 */
export function drawPolygons(polygons: Point[][], size: number): OutlineImage {
  const alpha = new Uint8Array(size * size);
  const rows = size * SUPER;
  // One sub-row at a time: the spans of every polygon (even-odd) marked on a strip of sub-columns.
  const strip = new Uint8Array(rows);
  const crossings: number[] = [];
  for (let sub = 0; sub < rows; sub++) {
    const y = (sub + 0.5) / SUPER;
    strip.fill(0);
    let any = false;
    for (const polygon of polygons) {
      crossings.length = 0;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i],
          [xj, yj] = polygon[j];
        if (yi > y !== yj > y) crossings.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
      crossings.sort((m, n) => m - n);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil(crossings[k] * SUPER - 0.5)),
          to = Math.min(rows - 1, Math.ceil(crossings[k + 1] * SUPER - 0.5) - 1);
        for (let x = from; x <= to; x++) strip[x] = 1;
        any = true;
      }
    }
    if (!any) continue;
    const row = Math.floor(sub / SUPER) * size;
    for (let x = 0; x < rows; x++) if (strip[x]) alpha[row + Math.floor(x / SUPER)] += 255 / (SUPER * SUPER);
  }
  return { alpha, width: size, height: size };
}

/** Turns points clockwise on the screen (y down) by `degrees` about `centre`. */
export function turnPoints(points: Point[], degrees: number, centre: Point): Point[] {
  const a = (degrees * Math.PI) / 180,
    cos = Math.cos(a),
    sin = Math.sin(a);
  return points.map(([x, y]) => [
    centre[0] + (x - centre[0]) * cos - (y - centre[1]) * sin,
    centre[1] + (x - centre[0]) * sin + (y - centre[1]) * cos,
  ]);
}

export const rectangle = (x: number, y: number, w: number, h: number): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/** A rounded rectangle (corner radius r) as a polygon of many short edges. */
export function roundedRectangle(x: number, y: number, w: number, h: number, r: number): Point[] {
  const points: Point[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 8; i++) {
      const a = ((from + (i * 90) / 8) * Math.PI) / 180;
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x + w - r, y + r, -90);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, 90);
  corner(x + r, y + r, 180);
  return points;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, steps = 96): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

/**
 * The product as an orthographic camera at `pose` sees it, filled triangle by triangle, framed the
 * way the 360° editor's capture frames it (square around the whole product, 8% margin). TripoSR
 * coordinates, so a test can level a mesh without WebGL.
 */
export function rasterizeSilhouette(
  mesh: Pick<ProductMesh, 'positions' | 'indices'>,
  pose: ProductPose,
  size = 256,
) {
  const object = new Quaternion(...pose.objectQuaternion),
    cameraInverse = new Quaternion(...pose.cameraQuaternion).invert();
  const count = mesh.positions.length / 3;
  const screen: Point[] = [];
  const point = new Vector3();
  for (let i = 0; i < count; i++) {
    point
      .set(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2])
      .applyQuaternion(object)
      .applyQuaternion(cameraInverse);
    screen.push([point.x, point.y]);
  }
  const xs = screen.map((p) => p[0]),
    ys = screen.map((p) => p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const half = (Math.max(maxX - minX, maxY - minY) / 2) * 1.16;
  const centre: Point = [(minX + maxX) / 2, (minY + maxY) / 2];
  // Camera x to the right, y up: to picture pixels (y down).
  const pixel = ([x, y]: Point): Point => [
    ((x - centre[0]) / (2 * half) + 0.5) * size,
    (0.5 - (y - centre[1]) / (2 * half)) * size,
  ];
  const triangles: Point[][] = [];
  for (let i = 0; i < mesh.indices.length; i += 3)
    triangles.push([0, 1, 2].map((k) => pixel(screen[mesh.indices[i + k]])));
  return drawPolygons(triangles, size);
}

/** An axis-aligned box in TripoSR coordinates (+z up, photographed from +x) as mesh data. */
export function boxMesh(
  [x0, y0, z0]: [number, number, number],
  [x1, y1, z1]: [number, number, number],
): ProductMesh {
  const positions = new Float32Array([
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y1,
    z0,
    x0,
    y1,
    z0,
    x0,
    y0,
    z1,
    x1,
    y0,
    z1,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4,
    0,
  ]);
  return { positions, indices, colors: new Float32Array(24).fill(0.5) };
}

/** Two meshes as one. */
export function joinMeshes(a: ProductMesh, b: ProductMesh): ProductMesh {
  const offset = a.positions.length / 3;
  return {
    positions: Float32Array.from([...a.positions, ...b.positions]),
    colors: Float32Array.from([...a.colors, ...b.colors]),
    indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + offset)]),
  };
}

/** A UV sphere (a round product) in TripoSR coordinates. */
export function sphereMesh(radius: number, rings = 20, segments = 32): ProductMesh {
  const positions: number[] = [],
    indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * 2 * Math.PI;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      );
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return {
    positions: Float32Array.from(positions),
    colors: new Float32Array(positions.length).fill(0.5),
    indices: Uint32Array.from(indices),
  };
}
