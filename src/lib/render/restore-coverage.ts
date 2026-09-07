import type { Mask, Point, Scene, Stroke, Surface } from '../types';
import { pointInPolygon } from './mask';
import { validateQuad } from './math';

export type RestorationRaster = { width: number; height: number; alpha: Uint8Array | Uint8ClampedArray };
type Domain = { surface: Surface; polygon: Point[] };
const EPSILON = 1e-10;

function cross(a: Point, b: Point, p: Point) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter((p, i) => !i || p.x !== sorted[i - 1].x || p.y !== sorted[i - 1].y);
  const half = (items: Point[]) => {
    const result: Point[] = [];
    for (const p of items) {
      while (result.length > 1 && cross(result[result.length - 2], result[result.length - 1], p) <= EPSILON)
        result.pop();
      result.push(p);
    }
    return result;
  };
  if (unique.length < 3) return [];
  const lower = half(unique),
    upper = half([...unique].reverse());
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}
function center(polygon: Point[]): Point {
  return {
    x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length,
    y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length,
  };
}
function clipHalfPlane(polygon: Point[], a: Point, b: Point, interior: Point): Point[] {
  const sign = Math.sign(cross(a, b, interior)) || 1;
  const result: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i],
      q = polygon[(i + 1) % polygon.length];
    const dp = cross(a, b, p) * sign,
      dq = cross(a, b, q) * sign;
    if (dp >= -EPSILON) result.push(p);
    if (dp >= 0 !== dq >= 0) {
      const t = dp / (dp - dq);
      result.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return result;
}
function intersect(polygon: Point[], convex: Point[]): Point[] {
  const inside = center(convex);
  for (let i = 0; i < convex.length && polygon.length; i++)
    polygon = clipHalfPlane(polygon, convex[i], convex[(i + 1) % convex.length], inside);
  return polygon;
}
function area(polygon: Point[]) {
  return (
    Math.abs(
      polygon.reduce((sum, p, i) => {
        const next = polygon[(i + 1) % polygon.length];
        return sum + p.x * next.y - next.x * p.y;
      }, 0),
    ) * 0.5
  );
}
function contains(polygon: Point[], point: Point) {
  return (
    polygon.length >= 3 &&
    (pointInPolygon(point, polygon) ||
      polygon.some((a, i) => {
        const b = polygon[(i + 1) % polygon.length];
        return (
          Math.abs(cross(a, b, point)) <= EPSILON &&
          point.x >= Math.min(a.x, b.x) - EPSILON &&
          point.x <= Math.max(a.x, b.x) + EPSILON &&
          point.y >= Math.min(a.y, b.y) - EPSILON &&
          point.y <= Math.max(a.y, b.y) + EPSILON
        );
      }))
  );
}

/** Holes and erase strokes are deliberately ignored only when estimating the underlying plane domain. */
export function restorationDomain(surface: Surface): Point[] {
  const points = [surface.mask.polygon, ...(surface.mask.polygons ?? [])].flat();
  for (const stroke of surface.mask.strokes) {
    if (stroke.erase) continue;
    if (stroke.radius === 0) points.push(...stroke.points);
  }
  let domain = hull(points);
  if (domain.length < 3 || !validateQuad(surface.quad)) return [];
  if (surface.kind === 'floor') return intersect(domain, surface.quad);
  const q = surface.quad,
    inside = center(q);
  // The side edges are shared wall seams. Extend upwards beyond the texture reference rectangle,
  // but never across its bottom floor junction or into another wall's horizontal plane coordinates.
  for (const [a, b] of [
    [q[0], q[3]],
    [q[1], q[2]],
    [q[3], q[2]],
  ])
    domain = clipHalfPlane(domain, a, b, inside);
  return domain;
}

function rectangles(owners: Int16Array, width: number, height: number) {
  const completed: { owner: number; left: number; top: number; right: number; bottom: number }[] = [];
  let previous = new Map<string, (typeof completed)[number]>();
  for (let y = 0; y < height; y++) {
    const next = new Map<string, (typeof completed)[number]>();
    for (let x = 0; x < width;) {
      const owner = owners[y * width + x];
      if (owner < 0) {
        x++;
        continue;
      }
      const left = x;
      while (x < width && owners[y * width + x] === owner) x++;
      const key = `${owner}:${left}:${x}`;
      const rectangle = previous.get(key) ?? { owner, left, top: y, right: x, bottom: y };
      rectangle.bottom = y + 1;
      next.set(key, rectangle);
      previous.delete(key);
    }
    completed.push(...previous.values());
    previous = next;
  }
  completed.push(...previous.values());
  return completed;
}
function append(mask: Mask, strokes: Stroke[]): Mask {
  if (!strokes.length) return mask;
  if (mask.strokes.length + strokes.length > 10000)
    throw new Error('복원 경계가 너무 복잡해요. 더 작은 영역으로 나누어 적용해 주세요.');
  return { ...mask, strokes: [...mask.strokes, ...strokes] };
}

/** Pure form: opaque restored pixels only, with every changed mask point clipped to an explicit target. */
export function restoreTileCoverageFromRaster(
  scene: Scene,
  raster: RestorationRaster,
  selectedSurfaceIds: readonly string[],
): Scene {
  const { width, height, alpha } = raster;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    alpha.length !== width * height
  )
    throw new Error('복원 영역 이미지의 크기가 맞지 않아요.');
  const selected = new Set(selectedSurfaceIds);
  if (!selected.size) return scene;
  if ([...selected].some((id) => !scene.surfaces.some((surface) => surface.id === id)))
    throw new Error('타일을 연결할 면을 다시 선택해 주세요.');
  const domains: Domain[] = scene.surfaces
    .map((surface) => ({ surface, polygon: restorationDomain(surface) }))
    .filter((item) => item.polygon.length >= 3);
  const floors = domains.filter((domain) => domain.surface.kind === 'floor');
  const walls = domains.filter((domain) => domain.surface.kind === 'wall');
  const owners = new Int16Array(width * height).fill(-1);
  let assigned = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const position = y * width + x;
      if (alpha[position] !== 255) continue;
      const point = { x: (x + 0.5) / width, y: (y + 0.5) / height };
      // Even an unchecked floor wins ownership below its measured/estimated boundary: a checked
      // wall cannot fill that floor's product hole or release protection in the unselected plane.
      const owner =
        floors.find((domain) => contains(domain.polygon, point)) ??
        walls.find((domain) => contains(domain.polygon, point));
      if (!owner || !selected.has(owner.surface.id)) continue;
      owners[position] = domains.indexOf(owner);
      assigned++;
    }
  if (!assigned) return scene;
  const additions = new Map<string, Stroke[]>();
  const erasures: Stroke[] = [];
  for (const rectangle of rectangles(owners, width, height)) {
    const domain = domains[rectangle.owner];
    const polygon = intersect(
      [
        { x: rectangle.left / width, y: rectangle.top / height },
        { x: rectangle.right / width, y: rectangle.top / height },
        { x: rectangle.right / width, y: rectangle.bottom / height },
        { x: rectangle.left / width, y: rectangle.bottom / height },
      ],
      domain.polygon,
    );
    if (polygon.length < 3 || area(polygon) < EPSILON) continue;
    const stroke: Stroke = { points: polygon, radius: 0, erase: false };
    const list = additions.get(domain.surface.id) ?? [];
    list.push(stroke);
    additions.set(domain.surface.id, list);
    erasures.push({ ...stroke, erase: true });
  }
  if (!erasures.length) return scene;
  return {
    ...scene,
    surfaces: scene.surfaces.map((surface) => {
      const strokes = additions.get(surface.id);
      return strokes?.length ? { ...surface, mask: append(surface.mask, strokes) } : surface;
    }),
    protection: append(scene.protection, erasures),
  };
}

/** DOM entry point used after the clone/import operation confirms which background pixels were restored. */
export async function restoreTileCoverage(
  scene: Scene,
  canvas: HTMLCanvasElement,
  selectedSurfaceIds: readonly string[],
): Promise<Scene> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('복원 영역을 읽지 못했어요.');
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const alpha = new Uint8Array(canvas.width * canvas.height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = image.data[p * 4 + 3];
  return restoreTileCoverageFromRaster(
    scene,
    { width: canvas.width, height: canvas.height, alpha },
    selectedSurfaceIds,
  );
}
