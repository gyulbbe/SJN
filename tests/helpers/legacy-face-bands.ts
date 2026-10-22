/**
 * The face-partition code as it was before wall regions (main 5189f4c), kept verbatim to compare
 * the shared partition with: viewer patches, room areas, usage areas and the quotation area.
 */
import type { RoomFace } from '../../src/lib/room-types';
import type { Scene, Surface } from '../../src/lib/types';
import { validUsageNumber } from '../../src/lib/material-usage';
import { roomDefinitionSchema } from '../../src/lib/room-validation';
import { resolveWallFeature, validateWallFeatures } from '../../src/lib/wall-features';
import type { SurfaceNotice, ViewerSurfacePatch } from '../../src/lib/room-viewer/surfaces';

const faces: RoomFace[] = ['floor', 'left', 'back', 'right'];
const hasAdditionalMask = (s: Surface) =>
  !!(s.mask.strokes.length || s.mask.holes?.length || s.mask.polygons?.length);

/** Partition physical intervals instead of stacking coplanar materials. No photo quad is projected. */
export function legacyViewerSurfacePatches(scene: Scene): {
  patches: ViewerSurfacePatch[];
  notices: SurfaceNotice[];
} {
  const patches: ViewerSurfacePatch[] = [],
    notices: SurfaceNotice[] = [];
  const warn = (s: Surface, message: string) =>
    notices.push({ id: s.id, name: s.name, message, severity: 'limitation' });
  for (const s of scene.surfaces) {
    if (!s.roomFace || s.geometryMode !== 'room')
      warn(s, '사진 좌표로 편집한 면은 입체 위치를 확정할 수 없어 이 보기에서 자재를 표시하지 않아요.');
    else if (hasAdditionalMask(s))
      warn(s, '사진 좌표의 브러시·보호 구멍은 이 보기에서 재현하지 않으며, 알려진 공간 면 범위를 사용해요.');
  }
  for (const face of faces) {
    const candidates = scene.surfaces.filter((s) => s.roomFace === face && s.geometryMode === 'room');
    const valid = candidates.filter((s) => {
      const b = s.reconstructionBand;
      if (
        b &&
        (face === 'floor' ||
          !Number.isFinite(b.from) ||
          !Number.isFinite(b.to) ||
          b.from < 0 ||
          b.to > 1 ||
          b.from >= b.to)
      ) {
        warn(s, '벽 높이 구간이 잘못되어 자재를 표시하지 않아요.');
        return false;
      }
      return true;
    });
    const full = valid.filter(
      (s) => !s.reconstructionBand || (s.reconstructionBand.from === 0 && s.reconstructionBand.to === 1),
    );
    const bands = valid.filter((s) => !full.includes(s));
    const conflicting = new Set<Surface>();
    for (const a of bands)
      for (const b of bands)
        if (
          a !== b &&
          Math.min(a.reconstructionBand!.to, b.reconstructionBand!.to) -
            Math.max(a.reconstructionBand!.from, b.reconstructionBand!.from) >
            1e-9
        ) {
          conflicting.add(a);
          conflicting.add(b);
        }
    for (const s of conflicting)
      warn(s, '겹치는 벽 구간의 앞뒤를 임의로 정하지 않아요. 해당 자재 구간을 확인해 주세요.');
    if (full.length > 1)
      full.forEach((s) => warn(s, '같은 공간 면에 전체 자재가 여러 개여서 자동 선택하지 않아요.'));
    const boundaries = [
      ...new Set([0, 1, ...bands.flatMap((s) => [s.reconstructionBand!.from, s.reconstructionBand!.to])]),
    ].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i],
        to = boundaries[i + 1],
        mid = (from + to) / 2;
      const covering = bands.filter(
        (s) => s.reconstructionBand!.from <= mid && s.reconstructionBand!.to >= mid,
      );
      const surface =
        covering.length === 1 && !conflicting.has(covering[0])
          ? covering[0]
          : covering.length
            ? undefined
            : full.length === 1
              ? full[0]
              : undefined;
      patches.push({ face, from, to, surface });
    }
  }
  return { patches, notices };
}

type RoomSurfaceArea = { areaM2: number | null; issue?: string };
const unclear = '영역 범위가 불명확하거나 겹칩니다. 순시공 면적을 확인해 주세요.';
const hasAdditionalMaskArea = (surface: Surface) =>
  Boolean(surface.mask.strokes.length || surface.mask.holes?.length || surface.mask.polygons?.length);

/** Pure physical areas with the same band ownership as the common room renderer.
 * Photo masks are never converted to physical subtraction; uncertain areas stay unresolved.
 * User-authored dimensions describe this model, not certified measured construction quantities.
 */
export function legacyRoomSurfaceAreas(scene: Scene): Map<string, RoomSurfaceArea> {
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
        hasAdditionalMaskArea(surface)
          ? {
              areaM2: null,
              issue: '사진 마스크의 실제 면적은 알 수 없어요. 순시공 면적을 직접 확인해 주세요.',
            }
          : { areaM2: areasMm2.get(surface.id)! / 1_000_000 },
      );
  }
  return result;
}

export function legacyUsageRoomAreas(scene: Scene): Map<string, { areaM2: number | null; issue?: string }> {
  if (
    scene.wallFeatures !== undefined &&
    !(Array.isArray(scene.wallFeatures) && scene.wallFeatures.length === 0)
  )
    return legacyRoomSurfaceAreas(scene);
  const result = new Map<string, { areaM2: number | null; issue?: string }>();
  const applicable = scene.surfaces.filter((s) => s.materialVersionId);
  for (const s of applicable) result.set(s.id, { areaM2: null, issue: '순시공 면적을 직접 입력해 주세요.' });
  const room = scene.room;
  if (
    !room ||
    !validUsageNumber(room.widthMm, 20_000, 500) ||
    !validUsageNumber(room.depthMm, 20_000, 500) ||
    !validUsageNumber(room.heightMm, 6_000, 1000)
  )
    return result;
  for (const face of ['floor', 'back', 'left', 'right'] as const) {
    const surfaces = applicable.filter((s) => s.roomFace === face);
    if (!surfaces.length) continue;
    const invalid = surfaces.some(
      (s) =>
        s.geometryMode !== 'room' ||
        (s.reconstructionBand &&
          (face === 'floor' ||
            !validUsageNumber(s.reconstructionBand.from, 1) ||
            !validUsageNumber(s.reconstructionBand.to, 1) ||
            s.reconstructionBand.to <= s.reconstructionBand.from)),
    );
    const full = surfaces.filter(
      (s) => !s.reconstructionBand || (s.reconstructionBand.from === 0 && s.reconstructionBand.to === 1),
    );
    const bands = surfaces.filter((s) => s.reconstructionBand && !full.includes(s));
    const overlap = bands.some((s, i) =>
      bands
        .slice(i + 1)
        .some(
          (t) =>
            Math.min(s.reconstructionBand!.to, t.reconstructionBand!.to) -
              Math.max(s.reconstructionBand!.from, t.reconstructionBand!.from) >
            1e-9,
        ),
    );
    if (invalid || full.length > 1 || overlap) {
      for (const s of surfaces)
        result.set(s.id, {
          areaM2: null,
          issue: '영역 범위가 불명확하거나 겹칩니다. 순시공 면적을 확인해 주세요.',
        });
      continue;
    }
    const faceArea = (room.heightMm * (face === 'back' ? room.widthMm : room.depthMm)) / 1_000_000;
    const total = face === 'floor' ? (room.widthMm * room.depthMm) / 1_000_000 : faceArea;
    let used = 0;
    for (const s of bands) {
      const fraction = s.reconstructionBand!.to - s.reconstructionBand!.from;
      result.set(s.id, { areaM2: total * fraction });
      used += fraction;
    }
    for (const s of full) result.set(s.id, { areaM2: total * Math.max(0, 1 - used) });
  }
  return result;
}

function bounded(value: unknown, maximum: number, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

/** A full linked face contributes its physical area, independently of photo masks or occluding products. */
export function legacyRoomAreaForSurfaces(
  scene: Scene,
  surfaceIds: string[],
  versionId?: string,
): number | null {
  const room = scene.room;
  if (!room || !surfaceIds.length || new Set(surfaceIds).size !== surfaceIds.length) return null;
  if (
    !bounded(room.widthMm, 20_000, 500) ||
    !bounded(room.depthMm, 20_000, 500) ||
    !bounded(room.heightMm, 6_000, 1_000)
  )
    return null;
  if (
    scene.wallFeatures !== undefined &&
    !(Array.isArray(scene.wallFeatures) && scene.wallFeatures.length === 0)
  ) {
    const areas = legacyRoomSurfaceAreas(scene);
    let area = 0;
    for (const id of surfaceIds) {
      const surface = scene.surfaces.find((item) => item.id === id);
      const value = areas.get(id)?.areaM2;
      if (
        !surface ||
        (versionId && surface.materialVersionId !== versionId) ||
        value === null ||
        value === undefined
      )
        return null;
      area += value;
    }
    return area;
  }
  const faces = new Map<string, { from: number; to: number }[]>();
  let area = 0;
  for (const id of surfaceIds) {
    const surface = scene.surfaces.find((item) => item.id === id);
    if (
      !surface ||
      surface.geometryMode !== 'room' ||
      !surface.roomFace ||
      (versionId && surface.materialVersionId !== versionId)
    )
      return null;
    const band = surface.reconstructionBand ?? { from: 0, to: 1 };
    if (
      !Number.isFinite(band.from) ||
      !Number.isFinite(band.to) ||
      band.from < 0 ||
      band.to > 1 ||
      band.from >= band.to ||
      (surface.reconstructionBand && surface.roomFace === 'floor')
    )
      return null;
    const intervals = faces.get(surface.roomFace) ?? [];
    if (intervals.some((b) => Math.min(b.to, band.to) - Math.max(b.from, band.from) > 1e-9)) return null;
    faces.set(surface.roomFace, [...intervals, band]);
    const fraction = band.to - band.from;
    if (surface.roomFace === 'floor') area += room.widthMm * room.depthMm;
    else if (surface.roomFace === 'back') area += room.widthMm * room.heightMm * fraction;
    else if (surface.roomFace === 'left' || surface.roomFace === 'right')
      area += room.depthMm * room.heightMm * fraction;
    else return null;
  }
  return Math.round(area) / 1_000_000;
}
