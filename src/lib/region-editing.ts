import { roomFaceSizeMm } from './room-geometry';
import {
  applyRoomSurfaceRegion,
  baseSurfaceAt,
  REGION_MIN_MM,
  regionShapeIssue,
  regionsOverlap,
  regionUv,
  snapRegion,
  type RegionBounds,
  type RegionSnapBase,
} from './room-surface-regions';
import type { RoomFace } from './room-types';
import type { MaterialVersion, Scene, Surface, SurfaceRegion } from './types';

/** A point of a room face in face UV (see roomFacePoint). */
export type FacePoint = { u: number; v: number };
/** A drag shorter than this many screen pixels is a click, never a region. */
export const REGION_DRAG_PX = 5;
/** Height of the band "띠로 추가" puts at the foot of a wall. */
export const REGION_BAND_MM = 300;
export const MAX_SURFACES = 100;

/** Why the region tool cannot be used on this scene, or null. */
export function regionToolIssue(input: {
  scene?: Pick<Scene, 'room' | 'surfaces'>;
  editing: 'before' | 'after';
  writable: boolean;
}): string | null {
  if (!input.scene?.room) return '부분 타일은 방 치수가 있는 공간에서만 쓸 수 있어요.';
  if (input.editing === 'before') return '부분 타일은 After 시안에서만 써요.';
  if (!input.writable) return '읽기 전용이라 부분 타일을 만들 수 없어요.';
  if (input.scene.surfaces.length >= MAX_SURFACES)
    return `벽·바닥 면은 ${MAX_SURFACES}개까지 만들 수 있어요.`;
  return null;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** The rectangle between two dragged face points, cut to the face; null when smaller than allowed. */
export function regionFromDrag(
  size: { width: number; height: number },
  from: FacePoint,
  to: FacePoint,
): SurfaceRegion | null {
  const left = Math.min(clamp01(from.u), clamp01(to.u)) * size.width,
    right = Math.max(clamp01(from.u), clamp01(to.u)) * size.width;
  const top = Math.min(clamp01(from.v), clamp01(to.v)) * size.height,
    bottom = Math.max(clamp01(from.v), clamp01(to.v)) * size.height;
  const region = { leftMm: left, topMm: top, widthMm: right - left, heightMm: bottom - top };
  return region.widthMm >= REGION_MIN_MM && region.heightMm >= REGION_MIN_MM ? region : null;
}

/** The base tile under a region's middle, for snapping its edges to the base's grout lines. */
export function regionSnapBase(
  scene: Scene,
  face: RoomFace,
  region: SurfaceRegion,
  materials: Record<string, MaterialVersion>,
): RegionSnapBase | undefined {
  if (!scene.room) return undefined;
  const size = roomFaceSizeMm(scene.room, face);
  const base = baseSurfaceAt(scene, face, (region.topMm + region.heightMm / 2) / size.height);
  if (!base) return undefined;
  const material = base.materialVersionId ? materials[base.materialVersionId] : undefined;
  return {
    tile: base.tile,
    ...(material && material.widthMm > 0 && material.heightMm > 0
      ? { tileMm: { width: material.widthMm, height: material.heightMm } }
      : {}),
  };
}

/** A region snapped (when asked) to the base under it. */
export function snappedRegion(
  scene: Scene,
  face: RoomFace,
  region: SurfaceRegion,
  materials: Record<string, MaterialVersion>,
): SurfaceRegion {
  return snapRegion(
    region,
    roomFaceSizeMm(scene.room!, face),
    regionSnapBase(scene, face, region, materials),
  );
}

/**
 * The rectangle a drag would make if let go now, as face UV for its preview: snapped when asked,
 * so the outline shows the region that will be created; the plain drag while still too small.
 */
export function draftRegionUv(
  scene: Scene,
  face: RoomFace,
  from: FacePoint,
  to: FacePoint,
  snap: boolean,
  materials: Record<string, MaterialVersion>,
): RegionBounds {
  const size = roomFaceSizeMm(scene.room!, face);
  const drawn = regionFromDrag(size, from, to);
  if (!drawn)
    return {
      left: clamp01(Math.min(from.u, to.u)),
      right: clamp01(Math.max(from.u, to.u)),
      top: clamp01(Math.min(from.v, to.v)),
      bottom: clamp01(Math.max(from.v, to.v)),
    };
  return regionUv(snap ? snappedRegion(scene, face, drawn, materials) : drawn, size);
}

/** Why this rectangle cannot be a region of the face (ignoring the region being edited), or null. */
export function regionPlacementIssue(
  scene: Pick<Scene, 'room' | 'surfaces'>,
  face: RoomFace,
  region: SurfaceRegion,
  ignoreId?: string,
): string | null {
  if (!scene.room) return '부분 타일은 방 치수가 있는 공간에서만 쓸 수 있어요.';
  const shape = regionShapeIssue(region, roomFaceSizeMm(scene.room, face));
  if (shape) return shape;
  if (
    scene.surfaces.some(
      (s) => s.id !== ignoreId && s.region && s.roomFace === face && regionsOverlap(s.region, region),
    )
  )
    return '같은 면의 부분 타일끼리 겹칠 수 없어요.';
  return null;
}

/** A region moved by a face-UV distance, kept inside its face. */
export function movedRegion(
  region: SurfaceRegion,
  size: { width: number; height: number },
  du: number,
  dv: number,
): SurfaceRegion {
  return {
    ...region,
    leftMm: Math.max(0, Math.min(size.width - region.widthMm, region.leftMm + du * size.width)),
    topMm: Math.max(0, Math.min(size.height - region.heightMm, region.topMm + dv * size.height)),
  };
}

/** Writes a region's rectangle into its surface with the matching photo mask. */
export function setSurfaceRegion(surface: Surface, region: SurfaceRegion): void {
  Object.assign(surface, applyRoomSurfaceRegion(surface, region));
}

/**
 * Where the inspector's buttons put a new region: a third of the face in its middle, or for a wall
 * band its whole width at the floor; null when that place is taken.
 */
export function suggestedRegion(
  scene: Scene,
  face: RoomFace,
  shape: 'area' | 'band',
  materials: Record<string, MaterialVersion>,
): SurfaceRegion | null {
  if (!scene.room) return null;
  const size = roomFaceSizeMm(scene.room, face);
  const region =
    shape === 'band'
      ? { leftMm: 0, topMm: size.height - REGION_BAND_MM, widthMm: size.width, heightMm: REGION_BAND_MM }
      : snappedRegion(
          scene,
          face,
          {
            leftMm: size.width / 3,
            topMm: size.height / 3,
            widthMm: size.width / 3,
            heightMm: size.height / 3,
          },
          materials,
        );
  return regionPlacementIssue(scene, face, region) ? null : region;
}
