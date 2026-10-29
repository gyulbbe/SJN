import { homography, inverseHomography, transformPoint } from './render/math';
import { createRoomSurfaces, ROOM_FACE_NAMES, roomFaceSizeMm } from './room-geometry';
import type { RoomFace } from './room-types';
import { roomDefinitionSchema } from './room-validation';
import { DEFAULT_COLOR, type Scene, type Surface, type SurfaceRegion, type TileSettings } from './types';

/** Smallest side of a wall or floor region; a smaller drag makes none. */
export const REGION_MIN_MM = 50;
/** Edges snap to this grid where no base grout line can be followed. */
export const REGION_GRID_MM = 10;
const EPSILON_MM = 1e-6;

export type RegionIssue = { surfaceId: string; path: (string | number)[]; message: string };
export type RegionBounds = { left: number; top: number; right: number; bottom: number };

/** The region as face UV (0–1), top=0, matching roomFacePoint and the wall features' opening. */
export function regionUv(region: SurfaceRegion, size: { width: number; height: number }): RegionBounds {
  return {
    left: region.leftMm / size.width,
    top: region.topMm / size.height,
    right: (region.leftMm + region.widthMm) / size.width,
    bottom: (region.topMm + region.heightMm) / size.height,
  };
}

/** What is wrong with one region on a face of this size, or null. */
export function regionShapeIssue(
  region: SurfaceRegion,
  size: { width: number; height: number },
): string | null {
  const values = [region.leftMm, region.topMm, region.widthMm, region.heightMm];
  if (!values.every(Number.isFinite)) return '부분 타일의 위치와 크기는 숫자여야 해요.';
  if (region.widthMm < REGION_MIN_MM - EPSILON_MM || region.heightMm < REGION_MIN_MM - EPSILON_MM)
    return `부분 타일은 가로·세로 ${REGION_MIN_MM}mm 이상이어야 해요.`;
  if (
    region.leftMm < -EPSILON_MM ||
    region.topMm < -EPSILON_MM ||
    region.leftMm + region.widthMm > size.width + EPSILON_MM ||
    region.topMm + region.heightMm > size.height + EPSILON_MM
  )
    return '부분 타일은 면 안에 있어야 해요.';
  return null;
}

export function regionsOverlap(a: SurfaceRegion, b: SurfaceRegion): boolean {
  return (
    Math.min(a.leftMm + a.widthMm, b.leftMm + b.widthMm) - Math.max(a.leftMm, b.leftMm) > EPSILON_MM &&
    Math.min(a.topMm + a.heightMm, b.topMm + b.heightMm) - Math.max(a.topMm, b.topMm) > EPSILON_MM
  );
}

/**
 * The region's surface: the whole face's quad and size (the 2D compositor's tile plane), with the
 * rectangle as its photo mask, as applyRoomSurfaceBand does for a height band.
 */
export function applyRoomSurfaceRegion(surface: Surface, region: SurfaceRegion): Surface {
  const size = { width: surface.widthMm, height: surface.heightMm };
  const issue =
    !surface.roomFace || surface.reconstructionBand
      ? '부분 타일은 방의 벽·바닥 전체 면에만 둘 수 있어요.'
      : regionShapeIssue(region, size);
  if (issue) throw new Error(issue);
  const uv = regionUv(region, size);
  const forward = inverseHomography(homography(surface.quad));
  return {
    ...surface,
    region: { ...region },
    mask: {
      polygon: [
        { x: uv.left, y: uv.top },
        { x: uv.right, y: uv.top },
        { x: uv.right, y: uv.bottom },
        { x: uv.left, y: uv.bottom },
      ].map((p) => transformPoint(forward, p)),
      strokes: [],
    },
  };
}

/**
 * Every region rule of a scene, read before saving: a room face of a room, inside the face, at
 * least REGION_MIN_MM, not with a height band, not overlapping another region of the face.
 */
export function validateSurfaceRegions(scene: Pick<Scene, 'room' | 'surfaces'>): RegionIssue[] {
  const issues: RegionIssue[] = [];
  const room = scene.room && roomDefinitionSchema.safeParse(scene.room).success ? scene.room : undefined;
  const placed: { index: number; surface: Surface }[] = [];
  scene.surfaces.forEach((surface, index) => {
    const region = surface.region;
    if (!region) return;
    const issue = (message: string) =>
      issues.push({ surfaceId: surface.id, path: ['surfaces', index, 'region'], message });
    if (!room || !surface.roomFace)
      return issue('부분 타일은 방 치수가 있는 공간의 벽·바닥에만 둘 수 있어요.');
    if (surface.reconstructionBand) return issue('부분 타일은 높이 구간 면에 둘 수 없어요.');
    if ((surface.roomFace === 'floor') !== (surface.kind === 'floor'))
      return issue('부분 타일의 벽·바닥 종류가 면과 맞지 않아요.');
    const shape = regionShapeIssue(region, roomFaceSizeMm(room, surface.roomFace));
    if (shape) return issue(shape);
    for (const other of placed)
      if (other.surface.roomFace === surface.roomFace && regionsOverlap(other.surface.region!, region))
        return issue('같은 면의 부분 타일끼리 겹칠 수 없어요.');
    placed.push({ index, surface });
  });
  return issues;
}

/** Room resize keeps millimetres: the part outside the new face is cut, a region left too small goes. */
export function clipRegionToFace(
  region: SurfaceRegion,
  size: { width: number; height: number },
): SurfaceRegion | null {
  const left = Math.max(0, region.leftMm),
    top = Math.max(0, region.topMm);
  const right = Math.min(size.width, region.leftMm + region.widthMm),
    bottom = Math.min(size.height, region.topMm + region.heightMm);
  const clipped = { leftMm: left, topMm: top, widthMm: right - left, heightMm: bottom - top };
  return regionShapeIssue(clipped, size) ? null : clipped;
}

/** The tile grid's origin in face millimetres: a region's tiles start at its own corner. */
export function surfaceTileOffset(surface: Pick<Surface, 'tile' | 'region'>): { x: number; y: number } {
  return {
    x: surface.tile.offsetX + (surface.region?.leftMm ?? 0),
    y: surface.tile.offsetY + (surface.region?.topMm ?? 0),
  };
}

/**
 * Grout lines along one face axis of a base tile, as the shaders draw them (`mm = uv × plane −
 * offset`, rotated, tile then grout in each period): each joint spans [phase + k·period, … + grout).
 * Undefined where the joints are not straight lines across the face (a brick layout's shifted
 * columns, a rotation other than a multiple of 90°).
 */
export function groutJoints(
  tile: Pick<TileSettings, 'rotation' | 'offsetX' | 'offsetY' | 'groutWidth' | 'pattern'>,
  tileMm: { width: number; height: number },
  axis: 'u' | 'v',
): { phase: number; period: number; grout: number } | undefined {
  const turns = tile.rotation / 90;
  if (!Number.isFinite(turns) || Math.abs(turns - Math.round(turns)) > 1e-9) return undefined;
  const quarter = ((Math.round(turns) % 4) + 4) % 4;
  const grout = Math.max(0, tile.groutWidth);
  const columns = tileMm.width + grout,
    rows = tileMm.height + grout;
  if (!(columns > 0 && rows > 0)) return undefined;
  const offset = axis === 'u' ? tile.offsetX : tile.offsetY;
  // Which tile axis runs along this face axis, and whether it is mirrored (see the rotation).
  const alongColumns = (quarter % 2 === 0) === (axis === 'u');
  const mirrored = axis === 'u' ? quarter === 1 || quarter === 2 : quarter === 2 || quarter === 3;
  if (alongColumns && tile.pattern === 'brick') return undefined;
  return { phase: mirrored ? offset : offset - grout, period: alongColumns ? columns : rows, grout };
}

export type RegionSnapBase = {
  tile: TileSettings;
  tileMm?: { width: number; height: number };
};

/**
 * Q3 edge snapping: the left/top edge goes to the end of a base grout line and the right/bottom
 * edge to the start of one, so each boundary shows the base's one joint (never two, never half).
 * Without a usable base grid, edges go to REGION_GRID_MM. Face edges are candidates unless `inset`
 * is given: then every edge stays that far inside the face (a wall feature never meets a corner).
 */
export function snapRegion(
  region: SurfaceRegion,
  size: { width: number; height: number },
  base?: RegionSnapBase,
  options: { inset?: number } = {},
): SurfaceRegion {
  const { inset } = options;
  const inside = (extent: number, value: number) =>
    inset === undefined
      ? Math.max(0, Math.min(extent, value))
      : Math.max(inset, Math.min(extent - inset, value));
  // The end edge takes the nearest line at least REGION_MIN_MM past the snapped start edge, so a
  // region shorter than a tile grows to the next joint instead of collapsing.
  const along = (axis: 'u' | 'v', value: number, edge: 'start' | 'end', start?: number) => {
    const extent = axis === 'u' ? size.width : size.height;
    const joints = base?.tileMm ? groutJoints(base.tile, base.tileMm, axis) : undefined;
    // A region's start follows a joint's end; its end stops at the next joint's start.
    const phase = joints ? joints.phase + (edge === 'start' ? joints.grout : 0) : 0,
      period = joints ? joints.period : REGION_GRID_MM;
    let step = Math.round((value - phase) / period);
    if (start !== undefined) while (phase + step * period < start + REGION_MIN_MM) step++;
    const lines = [phase + step * period, ...(inset === undefined ? [0, extent] : [])].filter(
      (line) => start === undefined || line >= start + REGION_MIN_MM,
    );
    const best = lines.length
      ? lines.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a))
      : extent;
    return inside(extent, best);
  };
  const make = (snap: typeof along): SurfaceRegion => {
    const left = snap('u', region.leftMm, 'start'),
      top = snap('v', region.topMm, 'start');
    const right = snap('u', region.leftMm + region.widthMm, 'end', left),
      bottom = snap('v', region.topMm + region.heightMm, 'end', top);
    return { leftMm: left, topMm: top, widthMm: right - left, heightMm: bottom - top };
  };
  const snapped = make(along);
  if (!regionShapeIssue(snapped, size)) return snapped;
  // Near the face's far edge the joints may leave no room: keep the request on the 10 mm grid.
  const grid = make((axis, value, _edge, start) => {
    const extent = axis === 'u' ? size.width : size.height;
    let line = Math.round(value / REGION_GRID_MM) * REGION_GRID_MM;
    if (start !== undefined) line = Math.max(line, start + REGION_MIN_MM);
    return inside(extent, line);
  });
  return regionShapeIssue(grid, size) ? region : grid;
}

/** The base surface (a whole face or its height band, never a region) under a face point. */
export function baseSurfaceAt(
  scene: Pick<Scene, 'surfaces'>,
  face: RoomFace,
  v: number,
): Surface | undefined {
  const base = scene.surfaces.filter((s) => s.roomFace === face && s.geometryMode === 'room' && !s.region);
  return (
    base.find(
      (s) => s.reconstructionBand && s.reconstructionBand.from <= v && v <= s.reconstructionBand.to,
    ) ?? base.find((s) => !s.reconstructionBand)
  );
}

export function regionName(scene: Pick<Scene, 'surfaces'>, face: RoomFace): string {
  const prefix = `${ROOM_FACE_NAMES[face]} · 부분 타일 `;
  const used = new Set(
    scene.surfaces
      .filter((s) => s.region && s.name.startsWith(prefix))
      .map((s) => s.name.slice(prefix.length)),
  );
  let number = 1;
  while (used.has(String(number))) number++;
  return prefix + number;
}

/** A new region of a room face without a tile: the base keeps showing until one is chosen. */
export function createRegionSurface(scene: Scene, face: RoomFace, region: SurfaceRegion): Surface {
  if (!scene.room) throw new Error('부분 타일은 방 치수가 있는 공간의 벽·바닥에만 둘 수 있어요.');
  const canonical = createRoomSurfaces(scene.room, scene.imageWidth / scene.imageHeight).find(
    (surface) => surface.roomFace === face,
  )!;
  return applyRoomSurfaceRegion(
    {
      ...canonical,
      id: crypto.randomUUID(),
      name: regionName(scene, face),
      color: { ...DEFAULT_COLOR },
    },
    region,
  );
}
