import type { Scene, Surface } from './types';
import { cellLeft, cellRight, partitionRoomFaces, type FaceCell } from './room-face-partition';
import { roomDefinitionSchema } from './room-validation';
import { resolveWallFeature, validateWallFeatures, type ResolvedWallFeature } from './wall-features';
import type { RoomDefinition } from './room-types';

export type RoomSurfaceArea = { areaM2: number | null; issue?: string };
type AreaMm2 = { areaMm2: number | null; issue?: string };
export type RoomAreaOptions = {
  /** The surfaces taken into account (the usage and quotation without wall features: tiled ones). */
  include?: (surface: Surface) => boolean;
  /**
   * Photo-coordinate brushes and holes of a room face are left out of its area instead of making it
   * unknown: the usage and quotation without wall features always counted the whole linked face.
   */
  ignorePhotoMasks?: boolean;
};
const unclear = '영역 범위가 불명확하거나 겹칩니다. 순시공 면적을 확인해 주세요.';
const hasAdditionalMask = (surface: Surface) =>
  Boolean(surface.mask.strokes.length || surface.mask.holes?.length || surface.mask.polygons?.length);

/**
 * One cell's physical area in mm², with the wall-feature rules of wall-feature-geometry.ts: the
 * opening is replaced by its rear, a reveal belongs to the cell just inside its edge and an alcove's
 * floor to the floor cell along the wall's foot. A whole-width cell keeps the original arithmetic.
 */
function cellAreaMm2(room: RoomDefinition, cell: FaceCell, features: readonly ResolvedWallFeature[]): number {
  const { face, from, to } = cell,
    left = cellLeft(cell),
    right = cellRight(cell);
  const whole = left === 0 && right === 1;
  if (face === 'floor') {
    let area = room.widthMm * room.depthMm * (to - from) * (right - left);
    for (const feature of features) {
      if (feature.kind !== 'floor-alcove') continue;
      const o = feature.opening;
      // The length of the alcove's mouth this cell meets along the wall's foot (left wall u = 1 − v).
      const length =
        whole && from === 0 && to === 1
          ? feature.openingMm.right - feature.openingMm.left
          : feature.face === 'back'
            ? from === 0
              ? Math.max(0, Math.min(o.right, right) - Math.max(o.left, left)) * room.widthMm
              : 0
            : feature.face === 'left'
              ? left === 0
                ? Math.max(0, Math.min(o.right, 1 - from) - Math.max(o.left, 1 - to)) * room.depthMm
                : 0
              : right === 1
                ? Math.max(0, Math.min(o.right, to) - Math.max(o.left, from)) * room.depthMm
                : 0;
      area += length * feature.depthMm;
    }
    return area;
  }
  const span = face === 'back' ? room.widthMm : room.depthMm;
  let area = span * room.heightMm * (to - from) * (right - left);
  for (const feature of features.filter((feature) => feature.face === face)) {
    const opening = feature.opening;
    const width = whole
      ? feature.openingMm.right - feature.openingMm.left
      : Math.max(0, Math.min(right, opening.right) - Math.max(left, opening.left)) * span;
    const overlapHeight =
      Math.max(0, Math.min(to, opening.bottom) - Math.max(from, opening.top)) * room.heightMm;
    // Equal opening and rear rectangles cancel. Keep the physical subtraction explicit.
    const openingArea = width * overlapHeight;
    const rearArea = width * overlapHeight;
    // Each side reveal belongs to the cell just inside its edge.
    const reveals =
      Number(left <= opening.left && opening.left < right) +
      Number(left < opening.right && opening.right <= right);
    area += -openingArea + rearArea + reveals * overlapHeight * feature.depthMm;
    // Exact band boundary ownership points into the opening, as in geometry.
    if (from <= opening.top && opening.top < to) area += width * feature.depthMm;
    if (feature.kind === 'closed-niche' && from < opening.bottom && opening.bottom <= to)
      area += width * feature.depthMm;
  }
  return area;
}

/** Pure physical areas with the same ownership as the common room renderer (room-face-partition.ts).
 * Photo masks are never converted to physical subtraction; uncertain areas stay unresolved.
 * User-authored dimensions describe this model, not certified measured construction quantities.
 */
export function roomSurfaceAreas(scene: Scene, options: RoomAreaOptions = {}): Map<string, RoomSurfaceArea> {
  return new Map(
    [...roomSurfaceAreasMm2(scene, options)].map(([id, { areaMm2, issue }]) => [
      id,
      areaMm2 === null ? { areaM2: null, issue } : { areaM2: areaMm2 / 1_000_000 },
    ]),
  );
}

/** The same areas in mm², for callers that round a sum of them. */
export function roomSurfaceAreasMm2(
  scene: Scene,
  { include = () => true, ignorePhotoMasks = false }: RoomAreaOptions = {},
): Map<string, AreaMm2> {
  const result = new Map<string, AreaMm2>();
  const surfaces = scene.surfaces.filter(include);
  for (const surface of surfaces)
    result.set(surface.id, { areaMm2: null, issue: '순시공 면적을 직접 입력해 주세요.' });
  const room = scene.room;
  if (!room || !roomDefinitionSchema.safeParse(room).success) return result;
  const featureIssues = validateWallFeatures(room, scene.wallFeatures);
  if (featureIssues.length) {
    for (const surface of surfaces)
      result.set(surface.id, {
        areaMm2: null,
        issue: '벽 구조 입력을 확인한 후 순시공 면적을 계산해 주세요.',
      });
    return result;
  }
  const features = (scene.wallFeatures ?? []).map((feature) => resolveWallFeature(room, feature));
  const ids = new Set<string>();
  if (surfaces.some((surface) => ids.has(surface.id) || !ids.add(surface.id))) {
    for (const surface of surfaces) result.set(surface.id, { areaMm2: null, issue: unclear });
    return result;
  }
  for (const face of partitionRoomFaces(scene, include).faces) {
    // Include unassigned surfaces: their bands still replace the parent's physical area.
    if (!face.surfaces.length) continue;
    if (face.unclear) {
      for (const surface of face.surfaces) result.set(surface.id, { areaMm2: null, issue: unclear });
      continue;
    }
    const areasMm2 = new Map(face.surfaces.map((surface) => [surface.id, 0]));
    for (const cell of face.cells)
      if (cell.surface)
        areasMm2.set(cell.surface.id, areasMm2.get(cell.surface.id)! + cellAreaMm2(room, cell, features));
    for (const surface of face.surfaces)
      result.set(
        surface.id,
        hasAdditionalMask(surface) && !ignorePhotoMasks
          ? {
              areaMm2: null,
              issue: '사진 마스크의 실제 면적은 알 수 없어요. 순시공 면적을 직접 확인해 주세요.',
            }
          : surface.region && !surface.materialVersionId
            ? { areaMm2: null, issue: '타일을 고르면 이 부분 타일의 면적을 계산해요.' }
            : { areaMm2: areasMm2.get(surface.id)! },
      );
  }
  return result;
}

/** Undefined means manual review is required, never a zero-area estimate. */
export function roomSurfaceAreaM2(scene: Scene, surfaceId: string): number | undefined {
  return roomSurfaceAreas(scene).get(surfaceId)?.areaM2 ?? undefined;
}
