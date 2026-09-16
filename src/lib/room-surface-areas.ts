import type { Scene, Surface } from './types';
import { roomDefinitionSchema } from './room-validation';
import { resolveWallFeature, validateWallFeatures } from './wall-features';

export type RoomSurfaceArea = { areaM2: number | null; issue?: string };
const unclear = '영역 범위가 불명확하거나 겹칩니다. 순시공 면적을 확인해 주세요.';
const hasAdditionalMask = (surface: Surface) =>
  Boolean(surface.mask.strokes.length || surface.mask.holes?.length || surface.mask.polygons?.length);

/** Pure physical areas with the same band ownership as the common room renderer.
 * Photo masks are never converted to physical subtraction; uncertain areas stay unresolved.
 * User-authored dimensions describe this model, not certified measured construction quantities.
 */
export function roomSurfaceAreas(scene: Scene): Map<string, RoomSurfaceArea> {
  const result = new Map<string, RoomSurfaceArea>();
  for (const surface of scene.surfaces)
    result.set(surface.id, { areaM2: null, issue: '순시공 면적을 직접 입력해 주세요.' });
  const room = scene.room;
  if (!room || !roomDefinitionSchema.safeParse(room).success) return result;
  const featureIssues = validateWallFeatures(room, scene.wallFeatures);
  if (featureIssues.length) {
    for (const surface of scene.surfaces)
      result.set(surface.id, {
        areaM2: null,
        issue: '벽 구조 입력을 확인한 후 순시공 면적을 계산해 주세요.',
      });
    return result;
  }
  const features = (scene.wallFeatures ?? []).map((feature) => resolveWallFeature(room, feature));
  const ids = new Set<string>();
  if (scene.surfaces.some((surface) => ids.has(surface.id) || !ids.add(surface.id))) {
    for (const surface of scene.surfaces) result.set(surface.id, { areaM2: null, issue: unclear });
    return result;
  }
  for (const face of ['floor', 'back', 'left', 'right'] as const) {
    // Include unassigned surfaces: their bands still replace the parent's physical area.
    const surfaces = scene.surfaces.filter((surface) => surface.roomFace === face);
    if (!surfaces.length) continue;
    const invalid = surfaces.some((surface) => {
      const band = surface.reconstructionBand;
      return (
        surface.geometryMode !== 'room' ||
        Boolean(
          band &&
          (face === 'floor' ||
            !Number.isFinite(band.from) ||
            !Number.isFinite(band.to) ||
            band.from < 0 ||
            band.to > 1 ||
            band.from >= band.to),
        )
      );
    });
    const full = surfaces.filter(
      (surface) =>
        !surface.reconstructionBand ||
        (surface.reconstructionBand.from === 0 && surface.reconstructionBand.to === 1),
    );
    const bands = surfaces.filter((surface) => !full.includes(surface));
    const overlap = bands.some((surface, index) =>
      bands
        .slice(index + 1)
        .some(
          (other) =>
            Math.min(surface.reconstructionBand!.to, other.reconstructionBand!.to) -
              Math.max(surface.reconstructionBand!.from, other.reconstructionBand!.from) >
            1e-9,
        ),
    );
    if (invalid || full.length > 1 || overlap) {
      for (const surface of surfaces) result.set(surface.id, { areaM2: null, issue: unclear });
      continue;
    }
    const boundaries = [
      ...new Set([
        0,
        1,
        ...bands.flatMap((surface) => [surface.reconstructionBand!.from, surface.reconstructionBand!.to]),
      ]),
    ].sort((a, b) => a - b);
    const areasMm2 = new Map(surfaces.map((surface) => [surface.id, 0]));
    for (let index = 0; index < boundaries.length - 1; index++) {
      const from = boundaries[index],
        to = boundaries[index + 1],
        mid = (from + to) / 2;
      const covering = bands.filter(
        (surface) => surface.reconstructionBand!.from <= mid && surface.reconstructionBand!.to >= mid,
      );
      const owner = covering.length === 1 ? covering[0] : covering.length ? undefined : full[0];
      if (!owner) continue;
      let area =
        face === 'floor'
          ? room.widthMm * room.depthMm
          : (face === 'back' ? room.widthMm : room.depthMm) * room.heightMm * (to - from);
      if (face === 'floor') {
        for (const feature of features)
          if (feature.kind === 'floor-alcove')
            area += (feature.openingMm.right - feature.openingMm.left) * feature.depthMm;
      } else {
        for (const feature of features.filter((feature) => feature.face === face)) {
          const opening = feature.opening;
          const width = feature.openingMm.right - feature.openingMm.left;
          const overlapHeight =
            Math.max(0, Math.min(to, opening.bottom) - Math.max(from, opening.top)) * room.heightMm;
          // Equal opening and rear rectangles cancel. Keep the physical subtraction explicit.
          const openingArea = width * overlapHeight;
          const rearArea = width * overlapHeight;
          area += -openingArea + rearArea + 2 * overlapHeight * feature.depthMm;
          // Exact band boundary ownership points into the opening, as in geometry.
          if (from <= opening.top && opening.top < to) area += width * feature.depthMm;
          if (feature.kind === 'closed-niche' && from < opening.bottom && opening.bottom <= to)
            area += width * feature.depthMm;
        }
      }
      areasMm2.set(owner.id, areasMm2.get(owner.id)! + area);
    }
    for (const surface of surfaces)
      result.set(
        surface.id,
        hasAdditionalMask(surface)
          ? {
              areaM2: null,
              issue: '사진 마스크의 실제 면적은 알 수 없어요. 순시공 면적을 직접 확인해 주세요.',
            }
          : { areaM2: areasMm2.get(surface.id)! / 1_000_000 },
      );
  }
  return result;
}

/** Undefined means manual review is required, never a zero-area estimate. */
export function roomSurfaceAreaM2(scene: Scene, surfaceId: string): number | undefined {
  return roomSurfaceAreas(scene).get(surfaceId)?.areaM2 ?? undefined;
}
