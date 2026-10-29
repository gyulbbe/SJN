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
export const WALL_FEATURE_KIND_NAMES: Record<WallFeatureV1['kind'], string> = {
  'closed-niche': '벽 홈',
  'floor-alcove': '바닥까지 열린 공간',
};
export const WALL_FACE_NOTE = '왼쪽·정면·오른쪽 벽을 끌어 주세요.';
export const WALL_FEATURE_SIZE_NOTE = `가로·세로 ${REGION_MIN_MM}mm보다 크게 끌어 주세요.`;

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
  if ((input.scene.wallFeatures?.length ?? 0) >= WALL_FEATURE_MAX_COUNT)
    return `벽 구조는 장면당 ${WALL_FEATURE_MAX_COUNT}개까지 만들 수 있어요.`;
  if (input.drafting) return '진행 중인 편집을 마친 뒤 써 주세요.';
  return null;
}

export const isWallFace = (face: RoomFace): face is WallFeatureFace => face !== 'floor';
export const wallFeatureTitle = (feature: Pick<WallFeatureV1, 'face' | 'kind'>) =>
  `${ROOM_FACE_NAMES[feature.face]} · ${WALL_FEATURE_KIND_NAMES[feature.kind]}`;

const within = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function build(
  face: WallFeatureFace,
  kind: WallFeatureV1['kind'],
  rect: SurfaceRegion,
  depthMm: number,
): WallFeatureV1 {
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
  return kind === 'closed-niche' ? { ...base, kind, heightMm: rect.heightMm } : { ...base, kind };
}

export type WallFeatureDraw = {
  kind: WallFeatureV1['kind'];
  depthMm: number;
  snap: boolean;
  materials: Record<string, MaterialVersion>;
};
export type DrawnWallFeature = { feature: WallFeatureV1; issue?: never } | { feature?: never; issue: string };

/**
 * The feature a drag between two wall points makes: cut to the wall and WALL_FEATURE_EDGE_MM inside
 * it, an alcove reaching the floor whatever the drag's bottom, and (when asked) its edges on the
 * wall's base grout lines (never the wall's own ends).
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
    bottom = draw.kind === 'floor-alcove' ? size.height : cut(Math.max(from.v, to.v), size.height);
  if (right - left < REGION_MIN_MM || bottom - top < REGION_MIN_MM) return { issue: WALL_FEATURE_SIZE_NOTE };
  let rect: SurfaceRegion = { leftMm: left, topMm: top, widthMm: right - left, heightMm: bottom - top };
  if (draw.snap)
    rect = snapRegion(rect, size, regionSnapBase(scene, face, rect, draw.materials), {
      inset: WALL_FEATURE_EDGE_MM,
    });
  if (draw.kind === 'floor-alcove') rect = { ...rect, heightMm: size.height - rect.topMm };
  return { feature: build(face, draw.kind, rect, draw.depthMm) };
}

/**
 * A click places the editor dialog's default size (width min(600, wall/3), height min(500, room
 * height/3)) centred on the pressed point and pushed inside the wall; an alcove's top sits half that
 * height above the point and it reaches the floor.
 */
export function featureFromClick(
  room: RoomDimensions,
  face: WallFeatureFace,
  at: FacePoint,
  draw: Pick<WallFeatureDraw, 'kind' | 'depthMm'>,
): WallFeatureV1 {
  const size = roomFaceSizeMm(room, face);
  const width = Math.min(600, Math.round(size.width / 3)),
    height = Math.min(500, Math.round(size.height / 3));
  const leftMm = within(
    Math.round(at.u * size.width - width / 2),
    WALL_FEATURE_EDGE_MM,
    size.width - WALL_FEATURE_EDGE_MM - width,
  );
  const lowest = draw.kind === 'floor-alcove' ? REGION_MIN_MM : WALL_FEATURE_EDGE_MM + height;
  const topMm = within(
    Math.round(at.v * size.height - height / 2),
    WALL_FEATURE_EDGE_MM,
    size.height - lowest,
  );
  return build(
    face,
    draw.kind,
    {
      leftMm,
      topMm,
      widthMm: width,
      heightMm: draw.kind === 'floor-alcove' ? size.height - topMm : height,
    },
    draw.depthMm,
  );
}

/**
 * A feature moved by a wall-UV distance, kept WALL_FEATURE_EDGE_MM inside its wall. An alcove moves
 * only sideways: moving its top would change its height.
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
/** Removes a feature from a draft scene; the last one leaves no `wallFeatures` key (as the dialog). */
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
 * The card's and dialog's fields: measured from the floor like a partial tile's, while storage keeps
 * the distance from the ceiling. `heightMm` of an alcove is its top's height (윗면 높이).
 */
/** A feature's fields other than its kind and height (an alcove stores no height). */
const common = (feature: WallFeatureV1) => ({
  version: feature.version,
  id: feature.id,
  source: feature.source,
  face: feature.face,
  leftMm: feature.leftMm,
  topMm: feature.topMm,
  widthMm: feature.widthMm,
  depthMm: feature.depthMm,
});
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
    ...common(feature),
    leftMm: fields.leftMm,
    widthMm: fields.widthMm,
    depthMm: fields.depthMm,
    topMm: room.heightMm - (feature.kind === 'floor-alcove' ? 0 : fields.bottomMm) - fields.heightMm,
  };
  return feature.kind === 'closed-niche'
    ? { ...base, kind: 'closed-niche', heightMm: fields.heightMm }
    : { ...base, kind: 'floor-alcove' };
}

/**
 * The same opening as the other kind: a niche becoming an alcove keeps its top and reaches the
 * floor; an alcove becoming a niche keeps its top with the default height, short of the floor.
 */
export function withKind(
  feature: WallFeatureV1,
  kind: WallFeatureV1['kind'],
  room: RoomDimensions,
): WallFeatureV1 {
  if (feature.kind === kind) return feature;
  const base = common(feature);
  if (kind === 'floor-alcove') return { ...base, kind };
  const heightMm = Math.max(
    0,
    Math.min(500, Math.round(room.heightMm / 3), room.heightMm - WALL_FEATURE_EDGE_MM - feature.topMm),
  );
  return { ...base, kind, heightMm };
}
