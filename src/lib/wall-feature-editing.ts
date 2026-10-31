import { regionSnapBase, type FacePoint } from './region-editing';
import { ROOM_FACE_NAMES, roomFaceSizeMm } from './room-geometry';
import { REGION_MIN_MM, snapRegion, type RegionBounds } from './room-surface-regions';
import type { RoomDimensions, RoomFace } from './room-types';
import type { MaterialVersion, Scene, SurfaceRegion } from './types';
import {
  validateWallFeatures,
  WALL_FEATURE_MAX_COUNT,
  type WallFeatureFace,
  type WallFeatureV1,
} from './wall-features';

/**
 * Drawing a wall feature on the editor canvas (docs/wall-feature-drawing-results-20261029.md). A drawn
 * feature keeps this far from the wall's corners and the ceiling: validation never accepts 0 or the
 * wall's end, so a drag that reaches them is cut here.
 */
export const WALL_FEATURE_EDGE_MM = 10;
export const WALL_FEATURE_DEFAULT_DEPTH_MM = 200;
export const WALL_FACE_NOTE = '왼쪽·정면·오른쪽 벽을 끌어 주세요.';
export const WALL_FEATURE_SIZE_NOTE = `가로·세로 ${REGION_MIN_MM}mm보다 크게 끌어 주세요.`;
export const WALL_FEATURE_3D_NOTICE =
  '벽 구조가 하나라도 있으면 편집 화면은 항상 3D로 표시돼요. 2D 합성은 평평한 벽과 바닥에 타일을 입히는 방식이라, 벽이 파인 깊이를 그리지 못하기 때문이에요.';

/** Why the wall-feature tool cannot be used now, or null. */
export function wallFeatureToolIssue(input: {
  scene?: Pick<Scene, 'room' | 'wallFeatures'>;
  writable: boolean;
  mode: 'before' | 'after' | 'split';
  /** Another edit's preview (a moved product, a dragged slider) is still open. */
  drafting: boolean;
}): string | null {
  if (!input.scene?.room) return '벽 구조는 방 치수가 있는 공간에서만 만들 수 있어요.';
  if (!input.writable) return '읽기 전용이라 벽 구조를 만들 수 없어요.';
  if (input.mode !== 'after') return '비교 보기에서는 벽 구조를 그릴 수 없어요.';
  if (input.drafting) return '진행 중인 편집을 마친 뒤 써 주세요.';
  return null;
}

/** Why no new feature can be drawn; the ones already there can still be picked, moved and deleted. */
export function wallFeatureDrawIssue(scene: Pick<Scene, 'wallFeatures'>): string | null {
  return (scene.wallFeatures?.length ?? 0) >= WALL_FEATURE_MAX_COUNT
    ? `벽 구조는 장면당 ${WALL_FEATURE_MAX_COUNT}개까지 만들 수 있어요. 놓인 구조를 눌러 고치거나 지워 주세요.`
    : null;
}

export const isWallFace = (face: RoomFace): face is WallFeatureFace => face !== 'floor';
/** One thing on screen, 벽 홈; stored as `floor-alcove` when it reaches the floor (바닥에서 0). */
export const wallFeatureTitle = (feature: Pick<WallFeatureV1, 'face'>) =>
  `${ROOM_FACE_NAMES[feature.face]} · 벽 홈`;

const within = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function build(face: WallFeatureFace, rect: SurfaceRegion, depthMm: number, toFloor = false): WallFeatureV1 {
  const base = {
    version: 1 as const,
    id: crypto.randomUUID(),
    source: 'user' as const,
    face,
    leftMm: rect.leftMm,
    topMm: rect.topMm,
    widthMm: rect.widthMm,
    depthMm,
  };
  return toFloor
    ? { ...base, kind: 'floor-alcove' }
    : { ...base, kind: 'closed-niche', heightMm: rect.heightMm };
}

export type WallFeatureDraw = {
  depthMm: number;
  snap: boolean;
  materials: Record<string, MaterialVersion>;
};
export type DrawnWallFeature = { feature: WallFeatureV1; issue?: never } | { feature?: never; issue: string };

/**
 * The feature a drag between two wall points makes: cut to the wall and WALL_FEATURE_EDGE_MM inside
 * it, reaching the floor when the drag gets within that distance of it or past it, and (when asked)
 * its edges on the wall's base grout lines (never the wall's own ends).
 */
export function featureFromDrag(
  scene: Scene,
  face: WallFeatureFace,
  from: FacePoint,
  to: FacePoint,
  draw: WallFeatureDraw,
): DrawnWallFeature {
  const size = roomFaceSizeMm(scene.room!, face);
  const cut = (value: number, extent: number) =>
    within(Math.round(value * extent), WALL_FEATURE_EDGE_MM, extent - WALL_FEATURE_EDGE_MM);
  const left = cut(Math.min(from.u, to.u), size.width),
    right = cut(Math.max(from.u, to.u), size.width),
    top = cut(Math.min(from.v, to.v), size.height),
    toFloor = Math.max(from.v, to.v) * size.height >= size.height - WALL_FEATURE_EDGE_MM,
    bottom = toFloor ? size.height : cut(Math.max(from.v, to.v), size.height);
  if (right - left < REGION_MIN_MM || bottom - top < REGION_MIN_MM) return { issue: WALL_FEATURE_SIZE_NOTE };
  let rect: SurfaceRegion = { leftMm: left, topMm: top, widthMm: right - left, heightMm: bottom - top };
  if (draw.snap)
    rect = snapRegion(rect, size, regionSnapBase(scene, face, rect, draw.materials), {
      inset: WALL_FEATURE_EDGE_MM,
    });
  return { feature: build(face, rect, draw.depthMm, toFloor) };
}

/**
 * A click places the default size (width min(600, wall/3), height min(500, room height/3)) centred
 * on the pressed point and pushed inside the wall.
 */
export function featureFromClick(
  room: RoomDimensions,
  face: WallFeatureFace,
  at: FacePoint,
  draw: Pick<WallFeatureDraw, 'depthMm'>,
): WallFeatureV1 {
  const size = roomFaceSizeMm(room, face);
  const width = Math.min(600, Math.round(size.width / 3)),
    height = Math.min(500, Math.round(size.height / 3));
  const leftMm = within(
    Math.round(at.u * size.width - width / 2),
    WALL_FEATURE_EDGE_MM,
    size.width - WALL_FEATURE_EDGE_MM - width,
  );
  const topMm = within(
    Math.round(at.v * size.height - height / 2),
    WALL_FEATURE_EDGE_MM,
    size.height - WALL_FEATURE_EDGE_MM - height,
  );
  return build(face, { leftMm, topMm, widthMm: width, heightMm: height }, draw.depthMm);
}

/**
 * A feature moved by a wall-UV distance, kept WALL_FEATURE_EDGE_MM inside its wall. One reaching
 * the floor moves only sideways: moving its top would change its height.
 */
export function movedFeature(
  feature: WallFeatureV1,
  room: RoomDimensions,
  du: number,
  dv: number,
): WallFeatureV1 {
  const size = roomFaceSizeMm(room, feature.face);
  const leftMm = within(
    feature.leftMm + Math.round(du * size.width),
    WALL_FEATURE_EDGE_MM,
    size.width - WALL_FEATURE_EDGE_MM - feature.widthMm,
  );
  if (feature.kind === 'floor-alcove') return { ...feature, leftMm };
  const topMm = within(
    feature.topMm + Math.round(dv * size.height),
    WALL_FEATURE_EDGE_MM,
    size.height - WALL_FEATURE_EDGE_MM - feature.heightMm,
  );
  return { ...feature, leftMm, topMm };
}

/** Why the scene cannot hold this feature (the one with its id replaced), or null. */
export function featureIssue(
  room: RoomDimensions,
  features: readonly WallFeatureV1[] | undefined,
  candidate: WallFeatureV1,
): string | null {
  const issues = validateWallFeatures(room, [
    ...(features ?? []).filter((feature) => feature.id !== candidate.id),
    candidate,
  ]);
  return issues.length ? [...new Set(issues.map((issue) => issue.message))].join(' ') : null;
}

/** Adds the feature to a draft scene, or replaces the one with its id. */
export function putWallFeature(scene: Scene, feature: WallFeatureV1): void {
  const list = scene.wallFeatures ?? [];
  scene.wallFeatures = list.some((item) => item.id === feature.id)
    ? list.map((item) => (item.id === feature.id ? structuredClone(feature) : item))
    : [...list, structuredClone(feature)];
}
/** Removes a feature from a draft scene; the last one leaves no `wallFeatures` key. */
export function removeWallFeature(scene: Scene, id: string): void {
  const rest = (scene.wallFeatures ?? []).filter((item) => item.id !== id);
  if (rest.length) scene.wallFeatures = rest;
  else delete scene.wallFeatures;
}

/** The feature's opening as its wall's UV (top=0), for an outline. */
export function featureUv(feature: WallFeatureV1, room: RoomDimensions): RegionBounds {
  const size = roomFaceSizeMm(room, feature.face);
  const bottom = feature.kind === 'floor-alcove' ? size.height : feature.topMm + feature.heightMm;
  return {
    left: feature.leftMm / size.width,
    right: (feature.leftMm + feature.widthMm) / size.width,
    top: feature.topMm / size.height,
    bottom: bottom / size.height,
  };
}

/**
 * The card's fields: measured from the floor like a partial tile's, while storage keeps the distance
 * from the ceiling. 바닥에서 0 is the stored `floor-alcove`, which holds no height of its own.
 */
export type WallFeatureFields = {
  leftMm: number;
  bottomMm: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
};
export function featureFields(feature: WallFeatureV1, room: RoomDimensions): WallFeatureFields {
  const alcove = feature.kind === 'floor-alcove';
  const heightMm = alcove ? room.heightMm - feature.topMm : feature.heightMm;
  return {
    leftMm: feature.leftMm,
    bottomMm: alcove ? 0 : room.heightMm - feature.topMm - feature.heightMm,
    widthMm: feature.widthMm,
    heightMm,
    depthMm: feature.depthMm,
  };
}
export function withFields(
  feature: WallFeatureV1,
  fields: WallFeatureFields,
  room: RoomDimensions,
): WallFeatureV1 {
  const base = {
    version: feature.version,
    id: feature.id,
    source: feature.source,
    face: feature.face,
    leftMm: fields.leftMm,
    widthMm: fields.widthMm,
    depthMm: fields.depthMm,
    topMm: room.heightMm - fields.bottomMm - fields.heightMm,
  };
  return fields.bottomMm === 0
    ? { ...base, kind: 'floor-alcove' }
    : { ...base, kind: 'closed-niche', heightMm: fields.heightMm };
}
