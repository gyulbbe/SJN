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
export const WALL_LEDGE_DEFAULT_DEPTH_MM = 150;
export const WALL_FACE_NOTE = '왼쪽·정면·오른쪽 벽을 끌어 주세요.';
export const WALL_FEATURE_SIZE_NOTE = `가로·세로 ${REGION_MIN_MM}mm보다 크게 끌어 주세요.`;
export const WALL_FEATURE_3D_NOTICE =
  '벽 구조가 하나라도 있으면 편집 화면은 항상 3D로 표시돼요. 2D 합성은 평평한 벽과 바닥에 타일을 입히는 방식이라, 벽이 파이거나 튀어나온 깊이를 그리지 못하기 때문이에요.';

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
/** On screen a 벽 홈 (stored as `floor-alcove` when it reaches the floor, 바닥에서 0) or a 젠다이. */
export const wallFeatureTitle = (feature: Pick<WallFeatureV1, 'face' | 'kind'>) =>
  `${ROOM_FACE_NAMES[feature.face]} · ${feature.kind === 'ledge' ? '젠다이' : '벽 홈'}`;

const within = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function build(
  face: WallFeatureFace,
  rect: SurfaceRegion,
  depthMm: number,
  toFloor = false,
  ledgeOfRoomHeight?: number,
): WallFeatureV1 {
  const base = {
    version: 1 as const,
    id: crypto.randomUUID(),
    source: 'user' as const,
    face,
    leftMm: rect.leftMm,
    widthMm: rect.widthMm,
    depthMm,
  };
  if (ledgeOfRoomHeight !== undefined)
    return {
      ...base,
      kind: 'ledge',
      bottomMm: toFloor ? 0 : ledgeOfRoomHeight - rect.topMm - rect.heightMm,
      heightMm: toFloor ? ledgeOfRoomHeight - rect.topMm : rect.heightMm,
    };
  return toFloor
    ? { ...base, topMm: rect.topMm, kind: 'floor-alcove' }
    : { ...base, topMm: rect.topMm, kind: 'closed-niche', heightMm: rect.heightMm };
}

export type WallFeatureShape = 'niche' | 'ledge';
export type WallFeatureDraw = {
  depthMm: number;
  snap: boolean;
  materials: Record<string, MaterialVersion>;
  /** What is drawn; a niche when absent. */
  shape?: WallFeatureShape;
  /** The last ledge applied in this editing session: a click makes the next one as high, as far up. */
  ledgeHeightMm?: number;
  ledgeBottomMm?: number;
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
  const ledge = draw.shape === 'ledge';
  const cut = (value: number, extent: number) =>
    within(Math.round(value * extent), WALL_FEATURE_EDGE_MM, extent - WALL_FEATURE_EDGE_MM);
  // A ledge reaches its wall's ends: a drag that gets close to one goes all the way.
  const across = (value: number, extent: number) => {
    const mm = Math.round(value * extent);
    if (!ledge) return cut(value, extent);
    return mm <= WALL_FEATURE_EDGE_MM ? 0 : mm >= extent - WALL_FEATURE_EDGE_MM ? extent : mm;
  };
  const left = across(Math.min(from.u, to.u), size.width),
    right = across(Math.max(from.u, to.u), size.width),
    top = cut(Math.min(from.v, to.v), size.height),
    toFloor = Math.max(from.v, to.v) * size.height >= size.height - WALL_FEATURE_EDGE_MM,
    bottom = toFloor ? size.height : cut(Math.max(from.v, to.v), size.height);
  if (right - left < REGION_MIN_MM || bottom - top < REGION_MIN_MM) return { issue: WALL_FEATURE_SIZE_NOTE };
  let rect: SurfaceRegion = { leftMm: left, topMm: top, widthMm: right - left, heightMm: bottom - top };
  if (draw.snap) {
    const base = regionSnapBase(scene, face, rect, draw.materials);
    if (ledge) {
      // Its sides may take the wall's ends; its top keeps below the ceiling.
      const snapped = snapRegion(rect, size, base);
      const topMm = Math.max(WALL_FEATURE_EDGE_MM, snapped.topMm);
      rect = { ...snapped, topMm, heightMm: snapped.topMm + snapped.heightMm - topMm };
    } else rect = snapRegion(rect, size, base, { inset: WALL_FEATURE_EDGE_MM });
  }
  return {
    feature: build(
      face,
      rect,
      draw.depthMm,
      toFloor || (ledge && rect.topMm + rect.heightMm >= size.height - WALL_FEATURE_EDGE_MM),
      ledge ? size.height : undefined,
    ),
  };
}

/**
 * A click places the default size (width min(600, wall/3), height min(500, room height/3)) centred
 * on the pressed point and pushed inside the wall.
 */
export function featureFromClick(
  room: RoomDimensions,
  face: WallFeatureFace,
  at: FacePoint,
  draw: Pick<WallFeatureDraw, 'depthMm' | 'shape' | 'ledgeHeightMm' | 'ledgeBottomMm'>,
): WallFeatureV1 {
  const size = roomFaceSizeMm(room, face);
  if (draw.shape === 'ledge') {
    // A ledge stands on the floor: width min(1200, wall/2), height min(900, room height/2); or as
    // high and as far above the floor as the last one applied, while that fits under the ceiling.
    const widthMm = Math.min(1200, Math.round(size.width / 2));
    const fits =
      draw.ledgeHeightMm !== undefined &&
      (draw.ledgeBottomMm ?? 0) + draw.ledgeHeightMm <= size.height - WALL_FEATURE_EDGE_MM;
    const heightMm = fits ? draw.ledgeHeightMm! : Math.min(900, Math.round(size.height / 2)),
      bottomMm = fits ? (draw.ledgeBottomMm ?? 0) : 0;
    const leftMm = within(Math.round(at.u * size.width - widthMm / 2), 0, size.width - widthMm);
    return build(
      face,
      { leftMm, topMm: size.height - bottomMm - heightMm, widthMm, heightMm },
      draw.depthMm,
      bottomMm === 0,
      size.height,
    );
  }
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
  if (feature.kind === 'ledge') {
    const leftMm = within(feature.leftMm + Math.round(du * size.width), 0, size.width - feature.widthMm);
    if (feature.bottomMm === 0) return { ...feature, leftMm };
    const bottomMm = within(
      feature.bottomMm - Math.round(dv * size.height),
      WALL_FEATURE_EDGE_MM,
      size.height - WALL_FEATURE_EDGE_MM - feature.heightMm,
    );
    return { ...feature, leftMm, bottomMm };
  }
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
  const top = feature.kind === 'ledge' ? size.height - feature.bottomMm - feature.heightMm : feature.topMm;
  const bottom =
    feature.kind === 'ledge'
      ? size.height - feature.bottomMm
      : feature.kind === 'floor-alcove'
        ? size.height
        : feature.topMm + feature.heightMm;
  return {
    left: feature.leftMm / size.width,
    right: (feature.leftMm + feature.widthMm) / size.width,
    top: top / size.height,
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
  if (feature.kind === 'ledge')
    return {
      leftMm: feature.leftMm,
      bottomMm: feature.bottomMm,
      widthMm: feature.widthMm,
      heightMm: feature.heightMm,
      depthMm: feature.depthMm,
    };
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
  };
  // A ledge stays a ledge; 바닥에서 0 stands it on the floor.
  if (feature.kind === 'ledge')
    return { ...base, kind: 'ledge', bottomMm: fields.bottomMm, heightMm: fields.heightMm };
  const topMm = room.heightMm - fields.bottomMm - fields.heightMm;
  return fields.bottomMm === 0
    ? { ...base, topMm, kind: 'floor-alcove' }
    : { ...base, topMm, kind: 'closed-niche', heightMm: fields.heightMm };
}
/**
 * Continuing a ledge (docs/wall-ledge-join-results-20261111.md): a ledge drawn, clicked or moved this
 * near another one meets it exactly, and a drawn one this near its height takes its measures.
 */
export const LEDGE_SNAP_MM = 50;
export const LEDGE_MATCH_MM = 100;
type Ledge = Extract<WallFeatureV1, { kind: 'ledge' }>;
/** A line on a wall (its UV, `outMm` before it) showing what a ledge was matched to. */
export type LedgeGuide = { face: WallFeatureFace; from: FacePoint; to: FacePoint; outMm: number };
export type LedgeSnap = {
  feature: WallFeatureV1;
  /** The ledge it met, which of its measures it took and which of its own ends met it. */
  matched?: { id: string; height: boolean; bottom: boolean; depth: boolean; ends: ('left' | 'right')[] };
  guides: LedgeGuide[];
};
/** What the tool says when a ledge met another one. */
export function ledgeSnapNote(snap: LedgeSnap): string {
  if (!snap.matched || snap.feature.kind !== 'ledge') return '';
  const taken = [
    snap.matched.height ? `높이 ${+snap.feature.heightMm.toFixed(1)}` : '',
    snap.matched.depth ? `깊이 ${+snap.feature.depthMm.toFixed(1)}` : '',
  ].filter(Boolean);
  return taken.length ? `옆 젠다이에 맞췄어요 · ${taken.join(' · ')}` : '옆 젠다이에 붙였어요';
}

/** Where a ledge of a neighbouring wall, standing in the shared corner, has its front on this wall. */
function cornerFronts(room: RoomDimensions, face: WallFeatureFace, features: readonly WallFeatureV1[]) {
  const span = roomFaceSizeMm(room, face).width;
  const result: { end: 'left' | 'right'; atMm: number; ledge: Ledge }[] = [];
  for (const other of features) {
    if (other.kind !== 'ledge' || other.face === face) continue;
    const otherSpan = roomFaceSizeMm(room, other.face).width;
    const atStart = other.leftMm === 0,
      atEnd = other.leftMm + other.widthMm === otherSpan;
    // The back wall meets the left wall's far end and the right wall's near end.
    if (face === 'back') {
      if (other.face === 'left' && atEnd) result.push({ end: 'left', atMm: other.depthMm, ledge: other });
      if (other.face === 'right' && atStart)
        result.push({ end: 'right', atMm: span - other.depthMm, ledge: other });
    } else if (other.face === 'back') {
      if (face === 'left' && atStart) result.push({ end: 'right', atMm: span - other.depthMm, ledge: other });
      if (face === 'right' && atEnd) result.push({ end: 'left', atMm: other.depthMm, ledge: other });
    }
  }
  return result;
}

/**
 * A ledge made to meet the nearest ledge within LEDGE_SNAP_MM of one of its ends: beside it on the
 * same wall, or round the corner at the front of a ledge standing in that corner. `draw` moves the
 * end alone and takes the neighbour's depth, and its height and distance from the floor when the
 * drawn ones are within LEDGE_MATCH_MM (a stair keeps its own height); `move` shifts the ledge whole
 * and keeps its size. One hanging within LEDGE_SNAP_MM above another on its wall sits on it. A result
 * the scene would refuse is given up for the ledge as it came.
 */
export function snapLedge(
  room: RoomDimensions,
  features: readonly WallFeatureV1[] | undefined,
  candidate: WallFeatureV1,
  mode: 'draw' | 'move',
): LedgeSnap {
  const plain: LedgeSnap = { feature: candidate, guides: [] };
  if (candidate.kind !== 'ledge') return plain;
  const others = (features ?? []).filter((item) => item.id !== candidate.id);
  const size = roomFaceSizeMm(room, candidate.face);
  const top = (item: Ledge) => item.bottomMm + item.heightMm;
  const near = (a: number, b: number, by = LEDGE_SNAP_MM) => Math.abs(a - b) <= by;
  // Close in height too: a ledge high above a low one is not its neighbour.
  const level = (other: Ledge) =>
    Math.min(top(candidate), top(other)) - Math.max(candidate.bottomMm, other.bottomMm) >= -LEDGE_MATCH_MM;
  type Target = { end: 'left' | 'right'; atMm: number; ledge: Ledge; distance: number };
  const targets: Target[] = [];
  const right = candidate.leftMm + candidate.widthMm;
  for (const other of others) {
    if (other.kind !== 'ledge' || other.face !== candidate.face || !level(other)) continue;
    const otherRight = other.leftMm + other.widthMm;
    if (near(candidate.leftMm, otherRight))
      targets.push({
        end: 'left',
        atMm: otherRight,
        ledge: other,
        distance: Math.abs(candidate.leftMm - otherRight),
      });
    if (near(right, other.leftMm))
      targets.push({
        end: 'right',
        atMm: other.leftMm,
        ledge: other,
        distance: Math.abs(right - other.leftMm),
      });
  }
  for (const corner of cornerFronts(room, candidate.face, others)) {
    if (!level(corner.ledge)) continue;
    // Anywhere from the wall's end to a little past the neighbour's front.
    const end = corner.end === 'left' ? candidate.leftMm : right;
    const inside =
      corner.end === 'left' ? end <= corner.atMm + LEDGE_SNAP_MM : end >= corner.atMm - LEDGE_SNAP_MM;
    if (inside) targets.push({ ...corner, distance: Math.abs(end - corner.atMm) });
  }
  targets.sort((a, b) => a.distance - b.distance);
  let next: Ledge = candidate;
  let matched: LedgeSnap['matched'];
  const guides: LedgeGuide[] = [];
  const used = new Set<string>();
  for (const target of targets) {
    // One target an end when drawing; a moved ledge shifts once.
    if (used.has(target.end) || (mode === 'move' && used.size)) continue;
    const nextRight = next.leftMm + next.widthMm;
    const leftMm =
      target.end === 'left' ? target.atMm : mode === 'move' ? target.atMm - next.widthMm : next.leftMm;
    const widthMm =
      mode === 'move'
        ? next.widthMm
        : target.end === 'left'
          ? nextRight - target.atMm
          : target.atMm - next.leftMm;
    if (leftMm < 0 || leftMm + widthMm > size.width || widthMm < REGION_MIN_MM) continue;
    used.add(target.end);
    next = { ...next, leftMm, widthMm };
    if (!matched) {
      const from = target.ledge;
      const takeBottom = mode === 'draw' && near(next.bottomMm, from.bottomMm, LEDGE_MATCH_MM);
      const bottomMm = takeBottom ? from.bottomMm : next.bottomMm;
      const takeHeight = mode === 'draw' && takeBottom && near(top(next), top(from), LEDGE_MATCH_MM);
      const sameWall = from.face === next.face;
      matched = { id: from.id, height: takeHeight, bottom: takeBottom, depth: mode === 'draw', ends: [] };
      next = {
        ...next,
        bottomMm,
        heightMm: takeHeight ? from.heightMm : takeBottom ? top(next) - bottomMm : next.heightMm,
        ...(mode === 'draw' ? { depthMm: from.depthMm } : {}),
      };
      // A moved hanging ledge comes level with its neighbour.
      if (mode === 'move' && next.bottomMm !== 0 && near(next.bottomMm, from.bottomMm))
        next = { ...next, bottomMm: from.bottomMm };
      const v = (mm: number) => 1 - mm / size.height;
      const high = Math.max(top(next), sameWall ? top(from) : top(next));
      const low = Math.min(next.bottomMm, sameWall ? from.bottomMm : next.bottomMm);
      guides.push({
        face: next.face,
        from: { u: target.atMm / size.width, v: v(high) },
        to: { u: target.atMm / size.width, v: v(low) },
        outMm: next.depthMm,
      });
      if (sameWall && top(next) === top(from))
        guides.push({
          face: next.face,
          from: { u: Math.min(from.leftMm, next.leftMm) / size.width, v: v(top(next)) },
          to: {
            u: Math.max(from.leftMm + from.widthMm, next.leftMm + next.widthMm) / size.width,
            v: v(top(next)),
          },
          outMm: next.depthMm,
        });
    }
  }
  // Onto the top of one below it.
  if (next.bottomMm > 0)
    for (const other of others) {
      if (other.kind !== 'ledge' || other.face !== next.face || other.id === matched?.id) continue;
      const overlap =
        Math.min(next.leftMm + next.widthMm, other.leftMm + other.widthMm) -
        Math.max(next.leftMm, other.leftMm);
      if (overlap <= 0 || !near(next.bottomMm, top(other)) || next.bottomMm === top(other)) continue;
      const heightMm = mode === 'draw' ? top(next) - top(other) : next.heightMm;
      if (heightMm < REGION_MIN_MM) continue;
      next = { ...next, bottomMm: top(other), heightMm };
      matched ??= { id: other.id, height: false, bottom: false, depth: false, ends: [] };
      guides.push({
        face: next.face,
        from: { u: Math.min(next.leftMm, other.leftMm) / size.width, v: 1 - top(other) / size.height },
        to: {
          u: Math.max(next.leftMm + next.widthMm, other.leftMm + other.widthMm) / size.width,
          v: 1 - top(other) / size.height,
        },
        outMm: Math.min(next.depthMm, other.depthMm),
      });
      break;
    }
  if (!matched || validateWallFeatures(room, [...others, next]).length) return plain;
  return { feature: next, matched: { ...matched, ends: [...used] as ('left' | 'right')[] }, guides };
}

/** The ledge a click makes beside one it would land on or near: whole, on the side that was pressed. */
export function ledgeBeside(
  room: RoomDimensions,
  features: readonly WallFeatureV1[] | undefined,
  candidate: WallFeatureV1,
  atMm: number,
): WallFeatureV1 {
  if (candidate.kind !== 'ledge') return candidate;
  const size = roomFaceSizeMm(room, candidate.face);
  const right = candidate.leftMm + candidate.widthMm;
  for (const other of features ?? []) {
    if (other.kind !== 'ledge' || other.face !== candidate.face || other.id === candidate.id) continue;
    const otherRight = other.leftMm + other.widthMm;
    if (Math.min(right, otherRight) - Math.max(candidate.leftMm, other.leftMm) <= 0) continue;
    // Pressed on its right half or past it: to its right, as wide as the wall allows.
    const after = atMm >= (other.leftMm + otherRight) / 2;
    const leftMm = after ? otherRight : Math.max(0, other.leftMm - candidate.widthMm);
    const widthMm = after ? Math.min(candidate.widthMm, size.width - otherRight) : other.leftMm - leftMm;
    if (widthMm >= REGION_MIN_MM) return { ...candidate, leftMm, widthMm };
  }
  return candidate;
}

/**
 * What a drag makes with the other ledges in mind. The neighbour comes before the grout lines: the
 * drag as drawn is matched to it first, and only the ends it left free (and the top, unless the
 * neighbour's height was taken) go to the wall's grout lines.
 */
export function drawnFeature(
  scene: Scene,
  face: WallFeatureFace,
  from: FacePoint,
  to: FacePoint,
  draw: WallFeatureDraw,
): { snap: LedgeSnap; issue?: never } | { snap?: never; issue: string } {
  const room = scene.room!;
  const lined = featureFromDrag(scene, face, from, to, draw);
  if (!lined.feature) return { issue: lined.issue };
  const fallback = { snap: snapLedge(room, scene.wallFeatures, lined.feature, 'draw') };
  if (!draw.snap || lined.feature.kind !== 'ledge') return fallback;
  const raw = featureFromDrag(scene, face, from, to, { ...draw, snap: false });
  if (raw.feature?.kind !== 'ledge') return fallback;
  const met = snapLedge(room, scene.wallFeatures, raw.feature, 'draw');
  if (!met.matched || met.feature.kind !== 'ledge') return fallback;
  const own = met.feature,
    grid = lined.feature;
  const leftMm = met.matched.ends.includes('left') ? own.leftMm : grid.leftMm,
    rightMm = met.matched.ends.includes('right') ? own.leftMm + own.widthMm : grid.leftMm + grid.widthMm,
    bottomMm = met.matched.bottom ? own.bottomMm : grid.bottomMm,
    topMm = met.matched.height ? own.bottomMm + own.heightMm : grid.bottomMm + grid.heightMm;
  const feature: WallFeatureV1 = {
    ...own,
    leftMm,
    widthMm: rightMm - leftMm,
    bottomMm,
    heightMm: topMm - bottomMm,
  };
  const fits =
    feature.widthMm >= REGION_MIN_MM &&
    feature.heightMm >= REGION_MIN_MM &&
    !featureIssue(room, scene.wallFeatures, feature);
  return { snap: fits ? { ...met, feature } : met };
}
