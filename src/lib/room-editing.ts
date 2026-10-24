import { hasParentGlassSupport } from './reconstruction/raised-glass-support';
import { syncBathRimAttachments } from './reconstruction/bath-rim';
import { reconstructionPositionFromPhoto, syncReconstructionHeight } from './reconstruction/position';
import { applyRoomSurfaceBand } from './room-surface-bands';
import { applyRoomSurfaceRegion, clipRegionToFace } from './room-surface-regions';
import { projectReconstructionFixture } from './reconstruction/projection';
import type { FixtureInstance, MaterialVersion, Scene, Surface } from './types';
import { EMPTY_MASK } from './types';
import type { RoomDefinition, RoomDimensions } from './room-types';
import { createRoomSurfaces, roomFaceSizeMm } from './room-geometry';
import {
  floorShift,
  projectRoomFixture,
  roomPositionFromPhoto,
  shownDirection,
  wallDrawnAt,
} from './room-fixtures';
import { applyWallContact, behindWall, WALL_SNAP_MM, wallDistanceMm } from './room-wall-contact';
import { validateWallFeatures, validateWallFeatureResize } from './wall-features';
import type { ProjectDocument } from './types';

function geometry(surface: Surface) {
  return JSON.stringify([surface.widthMm, surface.heightMm, surface.quad, surface.mask]);
}
/** The shape a room face's band or region has when nothing was edited by hand; null for an invalid region. */
function roomShape(original: Surface, surface: Surface): Surface | null {
  if (!surface.region) return applyRoomSurfaceBand(original, surface.reconstructionBand);
  try {
    return applyRoomSurfaceRegion(original, surface.region);
  } catch {
    return null;
  }
}
/**
 * Normalize only generated rooms. Photo projects retain their original editing behavior. `materials`
 * (the scene's versions, as far as they are read) keeps products marked against their wall there.
 */
export function normalizeRoomScene(
  previous: Scene,
  next: Scene,
  materials: Record<string, Pick<MaterialVersion, 'depthMm' | 'views'> | undefined> = {},
): void {
  const featureError = validateWallFeatures(next.room, next.wallFeatures)[0];
  if (featureError) throw new Error(featureError.message);
  if (!next.room) return;
  const aspect = next.imageWidth / next.imageHeight;
  const sameRoom =
    !!previous.room &&
    previous.room.kind === next.room.kind &&
    previous.room.version === next.room.version &&
    previous.room.widthMm === next.room.widthMm &&
    previous.room.depthMm === next.room.depthMm &&
    previous.room.heightMm === next.room.heightMm;
  // Ordinary edits cannot remove a generated face or one of its material bands (a region can
  // be removed). A new source frame or room dimensions deliberately permits replacement during
  // rebuild/resize.
  if (
    sameRoom &&
    previous.originalAssetId === next.originalAssetId &&
    previous.imageWidth === next.imageWidth &&
    previous.imageHeight === next.imageHeight
  ) {
    const retainedIds = new Set(next.surfaces.map((surface) => surface.id));
    previous.surfaces.forEach((surface, index) => {
      if (surface.roomFace && !surface.region && !retainedIds.has(surface.id)) {
        next.surfaces.splice(Math.min(index, next.surfaces.length), 0, structuredClone(surface));
        retainedIds.add(surface.id);
      }
    });
  }
  let canonical: Surface[] | undefined;
  if (sameRoom)
    for (const surface of next.surfaces) {
      const before = previous.surfaces.find((s) => s.id === surface.id);
      if (
        surface.roomFace &&
        surface.geometryMode === 'room' &&
        before &&
        geometry(before) !== geometry(surface)
      ) {
        canonical ??= createRoomSurfaces(next.room, aspect);
        const original = canonical.find((s) => s.roomFace === surface.roomFace);
        const shape = original && roomShape(original, surface);
        // An invalid region is left for validation to report rather than turned into a photo shape.
        if (!original || (shape && geometry(shape) !== geometry(surface))) surface.geometryMode = 'manual';
      }
    }
  for (const fixture of next.fixtures) {
    if (hasParentGlassSupport(fixture.reconstruction?.support)) continue;
    const before = previous.fixtures.find((f) => f.id === fixture.id);
    if (!fixture.roomPlacement) continue;
    // "벽에 붙이기" is a floor product's: a wall product always touches its wall (the next save drops it).
    if (fixture.roomPlacement.face !== 'floor') delete fixture.roomPlacement.againstWall;
    if (
      sameRoom &&
      before?.roomPlacement &&
      JSON.stringify(before.position) !== JSON.stringify(fixture.position) &&
      before.roomPlacement.u === fixture.roomPlacement.u &&
      before.roomPlacement.v === fixture.roomPlacement.v &&
      before.roomPlacement.face === fixture.roomPlacement.face &&
      !drawnAt(next.room, fixture, aspect, materials)
    ) {
      // The drawn place is the anchor's floor point moved so the product stands on it: undo that first.
      const anchorAt = { x: fixture.position.x, y: fixture.position.y + floorShift(fixture) };
      // A photo on a wall is drawn against it (wallDrawnAt): read its place back there.
      const face = fixture.roomPlacement.face;
      const across =
        face !== 'floor' && !fixture.reconstruction
          ? wallDrawnAt(next.room, fixture, face, !!fixture.projectedQuad)
          : undefined;
      Object.assign(
        fixture.roomPlacement,
        fixture.reconstruction?.version === 2
          ? reconstructionPositionFromPhoto(next.room, fixture, fixture.position, aspect)
          : roomPositionFromPhoto(next.room, face, anchorAt, aspect, across),
      );
      // A floor product moved near the wall behind it goes against it; moved away, it lets go.
      const distance = wallDistanceMm(next.room, fixture, materials);
      if (distance !== undefined && distance <= WALL_SNAP_MM) fixture.roomPlacement.againstWall = true;
      else if (distance !== undefined) delete fixture.roomPlacement.againstWall;
    }
    syncReconstructionHeight(next.room, fixture, before);
    reprojectFixture(next.room, fixture, aspect, materials);
  }
  syncBathRimAttachments(next);
}
type Depths = Record<string, Pick<MaterialVersion, 'depthMm' | 'views'> | undefined>;
/**
 * Whether a photo product is drawn where its u/v draws it (a new photo or scale drew it again), so
 * its place is not read back from the drawing: the floor correction would add rounding each time.
 */
function drawnAt(room: RoomDefinition, fixture: FixtureInstance, aspect: number, materials: Depths) {
  if (fixture.reconstruction?.version === 2 || !fixture.roomPlacement) return false;
  const drawn = structuredClone(fixture);
  try {
    projectRoomFixture(
      room,
      drawn,
      aspect,
      fixture.roomPlacement.againstWall ? behindWall(fixture, materials) : undefined,
      shownDirection(fixture, materials),
    );
  } catch {
    return false;
  }
  return Math.hypot(drawn.position.x - fixture.position.x, drawn.position.y - fixture.position.y) < 1e-9;
}
/**
 * Draws a fixture's room place again: a product kept against its wall goes there first. One whose
 * material is not read yet keeps the place it was drawn at (its depth and angle are unknown), as does
 * a picture drawn on its wall (its photo's direction is unknown).
 */
function reprojectFixture(room: RoomDefinition, fixture: FixtureInstance, aspect: number, materials: Depths) {
  const placement = fixture.roomPlacement;
  if (!placement) return;
  if (
    (placement.againstWall || fixture.projectedQuad) &&
    !fixture.reconstruction &&
    !materials[fixture.materialVersionId]
  )
    return;
  applyWallContact(room, fixture, materials);
  projectRoomFixture(
    room,
    fixture,
    aspect,
    placement.againstWall ? behindWall(fixture, materials) : undefined,
    shownDirection(fixture, materials),
  );
  projectReconstructionFixture(room, fixture, aspect);
}
/**
 * Read migration when the scene's materials arrive: draws every room product again with today's
 * rules (a floor photo on the floor, a product kept against its wall there). Not a change of its own:
 * the next ordinary edit saves it, as with the material usage.
 */
export function reprojectRoomScene(scene: Scene, materials: Depths): void {
  if (!scene.room) return;
  for (const fixture of scene.fixtures) {
    if (hasParentGlassSupport(fixture.reconstruction?.support)) continue;
    try {
      reprojectFixture(scene.room, fixture, scene.imageWidth / scene.imageHeight, materials);
    } catch {
      // A product too big for its room keeps its last drawing; editing it reports the problem.
    }
  }
  syncBathRimAttachments(scene);
}
function hasMask(mask: Scene['protection']) {
  return (
    mask.polygon.length > 0 || !!mask.polygons?.length || !!mask.holes?.length || mask.strokes.length > 0
  );
}
/** Regions kept in millimetres on a resized room: cut to the new face, or gone when nothing is left. */
function resizedRegions(scene: Scene, room: RoomDimensions) {
  const regions = scene.surfaces.filter((s) => s.region && s.roomFace);
  const kept = regions.map((s) => clipRegionToFace(s.region!, roomFaceSizeMm(room, s.roomFace!)));
  return {
    cut: kept.filter((region, i) => region && JSON.stringify(region) !== JSON.stringify(regions[i].region))
      .length,
    removed: kept.filter((region) => !region).length,
  };
}
export function roomResetWarnings(scene: Scene, nextRoom?: RoomDimensions | null): string[] {
  const messages: string[] = [];
  const presentFaces = scene.surfaces.filter((s) => s.roomFace && !s.region).map((s) => s.roomFace!);
  const missing = 4 - new Set(presentFaces).size;
  const faceKeys = scene.surfaces
    .filter((s) => s.roomFace && !s.region)
    .map(
      (s) =>
        s.roomFace +
        (s.reconstructionBand ? ':' + s.reconstructionBand.from + ':' + s.reconstructionBand.to : ''),
    );
  const duplicated = faceKeys.length - new Set(faceKeys).size;
  if (missing > 0) messages.push(`삭제한 기본 면 ${missing}개를 새 크기로 복원해요.`);
  if (duplicated > 0) messages.push(`복제한 기본 면 ${duplicated}개를 정리해요.`);
  const corrected = scene.surfaces.filter((s) => s.roomFace && s.geometryMode !== 'room').length;
  const added = scene.surfaces.filter((s) => !s.roomFace).length;
  const hidden = scene.fixtures.filter((f) => hasMask(f.occlusion)).length;
  if (corrected) messages.push(`수동 보정한 기본 면 ${corrected}개를 방 치수에 다시 맞춰요.`);
  if (added) messages.push(`직접 추가한 면 ${added}개를 제거해요.`);
  if (hasMask(scene.protection)) messages.push('전체 보호 영역을 초기화해요.');
  if (hidden) messages.push(`제품 가림 영역 ${hidden}개를 초기화해요.`);
  if (scene.backgroundAssetId) messages.push('복원한 배경 대신 새 크기의 빈 방을 사용해요.');
  if (nextRoom) {
    const { cut, removed } = resizedRegions(scene, nextRoom);
    if (cut) messages.push(`부분 타일 ${cut}개를 새 면에 맞춰 잘라요.`);
    if (removed) messages.push(`면 밖으로 나간 부분 타일 ${removed}개를 지워요.`);
  }
  if (scene.wallFeatures?.length) {
    messages.push('벽 구조의 거리·폭·깊이는 유지해요. 새 공간 범위를 벗어나면 크기를 변경하지 않아요.');
    if (scene.wallFeatures.some((feature) => feature.kind === 'floor-alcove'))
      messages.push('바닥까지 열린 후퇴 공간은 새 바닥 높이까지 이어져 높이가 달라질 수 있어요.');
  }
  return messages;
}
/** Call before creating resize assets. Historical scenes keep their own original room dimensions. */
export function projectWallFeatureResizeError(project: ProjectDocument, room: RoomDefinition): string | null {
  const scenes = [
    { name: '기본 공간', scene: project.shared.baseline },
    ...(project.shared.comparison ? [{ name: 'Before', scene: project.shared.comparison.before }] : []),
    ...project.designs.map((design) => ({ name: design.name, scene: design.scene })),
  ];
  for (const { name, scene } of scenes) {
    const issue = validateWallFeatureResize(scene, room)[0];
    if (issue) return `${name}: ${issue.message}`;
  }
  return null;
}
export function resizedRoomScene(
  scene: Scene,
  room: RoomDefinition,
  assets: {
    originalAssetId: string;
    previewAssetId: string;
    imageWidth: number;
    imageHeight: number;
  },
  materials: Record<string, Pick<MaterialVersion, 'depthMm' | 'views'> | undefined> = {},
): Scene {
  const featureError = validateWallFeatureResize(scene, room)[0];
  if (featureError) throw new Error(featureError.message);
  const next = structuredClone(scene);
  next.room = { ...room };
  Object.assign(next, assets);
  delete next.backgroundAssetId;
  next.protection = EMPTY_MASK();
  next.surfaces = createRoomSurfaces(room, assets.imageWidth / assets.imageHeight).flatMap((surface) => {
    const oldFaces = scene.surfaces.filter((s) => s.roomFace === surface.roomFace && !s.region);
    const bands = oldFaces.filter((s) => s.reconstructionBand);
    const retained = [
      ...oldFaces.filter((s) => !s.reconstructionBand).slice(0, 1),
      ...bands.filter(
        (s, i) =>
          bands.findIndex(
            (b) =>
              b.reconstructionBand!.from === s.reconstructionBand!.from &&
              b.reconstructionBand!.to === s.reconstructionBand!.to,
          ) === i,
      ),
    ];
    const carried = (old: Surface): Surface => ({
      ...surface,
      id: old.id,
      name: old.name,
      materialVersionId: old.materialVersionId,
      tile: { ...old.tile },
      color: { ...old.color },
    });
    // Regions keep their millimetres; the part outside the new face is cut, an empty one goes.
    const regions = scene.surfaces.flatMap((old) => {
      if (!old.region || old.roomFace !== surface.roomFace) return [];
      const region = clipRegionToFace(old.region, roomFaceSizeMm(room, surface.roomFace!));
      return region ? [applyRoomSurfaceRegion(carried(old), region)] : [];
    });
    if (!retained.length) return [surface, ...regions];
    return [...retained.map((old) => applyRoomSurfaceBand(carried(old), old.reconstructionBand)), ...regions];
  });
  for (const fixture of next.fixtures) {
    fixture.occlusion = EMPTY_MASK();
    if (hasParentGlassSupport(fixture.reconstruction?.support)) continue;
    syncReconstructionHeight(room, fixture);
    reprojectFixture(room, fixture, assets.imageWidth / assets.imageHeight, materials);
  }
  syncBathRimAttachments(next);
  return next;
}
