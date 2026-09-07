import { applyRoomSurfaceBand } from './room-surface-bands';
import { projectReconstructionFixture } from './reconstruction/projection';
import type { Scene, Surface } from './types';
import { EMPTY_MASK } from './types';
import type { RoomDefinition } from './room-types';
import { createRoomSurfaces } from './room-geometry';
import { projectRoomFixture, roomPositionFromPhoto } from './room-fixtures';

function geometry(surface: Surface) {
  return JSON.stringify([surface.widthMm, surface.heightMm, surface.quad, surface.mask]);
}
/** Normalize only generated rooms. Photo projects retain their original editing behavior. */
export function normalizeRoomScene(previous: Scene, next: Scene): void {
  if (!next.room) return;
  const aspect = next.imageWidth / next.imageHeight;
  const sameRoom =
    !!previous.room &&
    previous.room.kind === next.room.kind &&
    previous.room.version === next.room.version &&
    previous.room.widthMm === next.room.widthMm &&
    previous.room.depthMm === next.room.depthMm &&
    previous.room.heightMm === next.room.heightMm;
  // Ordinary edits cannot remove a generated face or one of its material bands. A new
  // source frame or room dimensions deliberately permits replacement during rebuild/resize.
  if (
    sameRoom &&
    previous.originalAssetId === next.originalAssetId &&
    previous.imageWidth === next.imageWidth &&
    previous.imageHeight === next.imageHeight
  ) {
    const retainedIds = new Set(next.surfaces.map((surface) => surface.id));
    previous.surfaces.forEach((surface, index) => {
      if (surface.roomFace && !retainedIds.has(surface.id)) {
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
        if (
          !original ||
          geometry(applyRoomSurfaceBand(original, surface.reconstructionBand)) !== geometry(surface)
        )
          surface.geometryMode = 'manual';
      }
    }
  for (const fixture of next.fixtures) {
    const before = previous.fixtures.find((f) => f.id === fixture.id);
    if (!fixture.roomPlacement) continue;
    if (
      sameRoom &&
      before?.roomPlacement &&
      JSON.stringify(before.position) !== JSON.stringify(fixture.position) &&
      before.roomPlacement.u === fixture.roomPlacement.u &&
      before.roomPlacement.v === fixture.roomPlacement.v &&
      before.roomPlacement.face === fixture.roomPlacement.face
    ) {
      Object.assign(
        fixture.roomPlacement,
        roomPositionFromPhoto(next.room, fixture.roomPlacement.face, fixture.position, aspect),
      );
    }
    projectRoomFixture(next.room, fixture, aspect);
    projectReconstructionFixture(next.room, fixture, aspect);
  }
}
function hasMask(mask: Scene['protection']) {
  return (
    mask.polygon.length > 0 || !!mask.polygons?.length || !!mask.holes?.length || mask.strokes.length > 0
  );
}
export function roomResetWarnings(scene: Scene): string[] {
  const messages: string[] = [];
  const presentFaces = scene.surfaces.filter((s) => s.roomFace).map((s) => s.roomFace!);
  const missing = 4 - new Set(presentFaces).size;
  const faceKeys = scene.surfaces
    .filter((s) => s.roomFace)
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
  return messages;
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
): Scene {
  const next = structuredClone(scene);
  next.room = { ...room };
  Object.assign(next, assets);
  delete next.backgroundAssetId;
  next.protection = EMPTY_MASK();
  next.surfaces = createRoomSurfaces(room, assets.imageWidth / assets.imageHeight).flatMap((surface) => {
    const oldFaces = scene.surfaces.filter((s) => s.roomFace === surface.roomFace);
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
    if (!retained.length) return [surface];
    return retained.map((old) =>
      applyRoomSurfaceBand(
        {
          ...surface,
          id: old.id,
          name: old.name,
          materialVersionId: old.materialVersionId,
          tile: { ...old.tile },
          color: { ...old.color },
        },
        old.reconstructionBand,
      ),
    );
  });
  for (const fixture of next.fixtures) {
    fixture.occlusion = EMPTY_MASK();
    projectRoomFixture(room, fixture, assets.imageWidth / assets.imageHeight);
    projectReconstructionFixture(room, fixture, assets.imageWidth / assets.imageHeight);
  }
  return next;
}
