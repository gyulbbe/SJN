import { z } from 'zod';
import { roomDefinitionSchema } from './room-validation';
import type { RoomDimensions, RoomFace } from './room-types';

export const WALL_FEATURE_MAX_COUNT = 24;
/** Supported modelling depth, not an estimate of the real wall thickness. */
export const WALL_FEATURE_MAX_DEPTH_MM = 1000;
export const WALL_FEATURE_CONTACT_EPSILON_MM = 1e-6;
/**
 * Ledges this close are one piece of masonry: before 2026-11-11 touching ledges were refused, so
 * people left a millimetre or so between them. Drawn and measured as joined; storage keeps the gap.
 */
export const LEDGE_JOIN_GAP_MM = 5;
export const LEDGE_OVERLAP_MESSAGE = '젠다이끼리는 맞닿게 놓을 수 있지만 겹칠 수는 없어요.';

export type WallFeatureFace = 'left' | 'back' | 'right';
type WallFeatureBaseV1 = {
  version: 1;
  id: string;
  face: WallFeatureFace;
  /** Distance from the wall's u=0 edge; never a photograph x coordinate. */
  leftMm: number;
  widthMm: number;
  depthMm: number;
  /** Explicitly authored values; this does not claim a physical measurement. */
  source: 'user';
};
/** `topMm` is the distance down from the room ceiling; a ledge stands on `bottomMm` above the floor. */
export type WallFeatureV1 = WallFeatureBaseV1 &
  (
    | { kind: 'closed-niche'; topMm: number; heightMm: number }
    | { kind: 'floor-alcove'; topMm: number; heightMm?: never }
    | { kind: 'ledge'; bottomMm: number; heightMm: number; topMm?: never }
  );

export type WallFeaturePoint3 = readonly [number, number, number];
export type WallFeatureBounds = Readonly<{
  min: WallFeaturePoint3;
  max: WallFeaturePoint3;
}>;
export type WallFeatureOpening = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;
export type ResolvedWallFeature = Readonly<{
  id: string;
  kind: WallFeatureV1['kind'];
  face: WallFeatureFace;
  wallSpanMm: number;
  heightMm: number;
  depthMm: number;
  /** Physical wall UV, top=0 and floor=1. This is not a photo bounding box. */
  opening: WallFeatureOpening;
  openingMm: WallFeatureOpening;
  inwardNormal: WallFeaturePoint3;
  /** The full void from its mouth to the rear face (a ledge: its solid), in room millimetres. */
  worldBounds: WallFeatureBounds;
  /** A ledge stands out into the room instead of going into the wall. */
  protrudes?: true;
}>;

export type WallFeatureIssueCode =
  | 'invalid-room'
  | 'invalid-features'
  | 'too-many-features'
  | 'invalid-feature'
  | 'invalid-version'
  | 'invalid-id'
  | 'duplicate-id'
  | 'invalid-kind'
  | 'invalid-source'
  | 'invalid-face'
  | 'invalid-number'
  | 'invalid-size'
  | 'out-of-bounds'
  | 'unexpected-field'
  | 'touching-or-overlap'
  | 'volume-collision';
export type WallFeatureValidationIssue = {
  code: WallFeatureIssueCode;
  /** Relative to Scene, including wallFeatures or room. */
  path: (string | number)[];
  message: string;
  featureId?: string;
  relatedFeatureId?: string;
};

export class WallFeatureValidationError extends Error {
  readonly issues: WallFeatureValidationIssue[];
  constructor(issues: WallFeatureValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'WallFeatureValidationError';
    this.issues = structuredClone(issues);
  }
}

const uuid = z.string().uuid();
const commonKeys = new Set(['version', 'id', 'kind', 'face', 'leftMm', 'widthMm', 'depthMm', 'source']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validRoom(room: RoomDimensions | undefined): room is RoomDimensions {
  // Dimension-only callers are accepted; an explicitly wrong kind/version is never overwritten.
  return (
    isRecord(room) && roomDefinitionSchema.safeParse({ kind: 'parametric', version: 1, ...room }).success
  );
}

function resolveValid(room: RoomDimensions, feature: WallFeatureV1): ResolvedWallFeature {
  const wallSpanMm = feature.face === 'back' ? room.widthMm : room.depthMm;
  const ledge = feature.kind === 'ledge';
  const left = feature.leftMm,
    right = left + feature.widthMm,
    top = ledge ? room.heightMm - feature.bottomMm - feature.heightMm : feature.topMm,
    bottom = ledge
      ? room.heightMm - feature.bottomMm
      : feature.kind === 'floor-alcove'
        ? room.heightMm
        : top + feature.heightMm;
  const lowY = room.heightMm - bottom,
    highY = room.heightMm - top,
    // Measured from the wall's plane along the room's inward normal: a void behind it, a ledge before it.
    near = ledge ? feature.depthMm : 0,
    far = ledge ? 0 : feature.depthMm,
    d = feature.depthMm;
  let min: WallFeaturePoint3, max: WallFeaturePoint3, inwardNormal: WallFeaturePoint3;
  if (feature.face === 'back') {
    min = [left - room.widthMm / 2, lowY, 0 - far];
    max = [right - room.widthMm / 2, highY, near];
    inwardNormal = [0, 0, 1];
  } else if (feature.face === 'left') {
    min = [-room.widthMm / 2 - far, lowY, room.depthMm - right];
    max = [-room.widthMm / 2 + near, highY, room.depthMm - left];
    inwardNormal = [1, 0, 0];
  } else {
    min = [room.widthMm / 2 - near, lowY, left];
    max = [room.widthMm / 2 + far, highY, right];
    inwardNormal = [-1, 0, 0];
  }
  return {
    id: feature.id,
    kind: feature.kind,
    face: feature.face,
    wallSpanMm,
    heightMm: bottom - top,
    depthMm: d,
    opening: {
      left: left / wallSpanMm,
      top: top / room.heightMm,
      right: right / wallSpanMm,
      bottom: bottom / room.heightMm,
    },
    openingMm: { left, top, right, bottom },
    inwardNormal,
    worldBounds: { min, max },
    ...(ledge ? { protrudes: true as const } : {}),
  };
}

/** The room face a ledge's end lies against: only a wall stands there, the room's front is open. */
export function ledgeEndWall(
  face: WallFeatureFace,
  end: 'left' | 'right',
): Extract<RoomFace, 'left' | 'back' | 'right'> | undefined {
  if (face === 'back') return end === 'left' ? 'left' : 'right';
  if (face === 'left') return end === 'right' ? 'back' : undefined;
  return end === 'left' ? 'back' : undefined;
}

export type LedgeFootprint = {
  face: RoomFace;
  left: number;
  right: number;
  /** Top to bottom on a wall, back to front on the floor (the face's own UV). */
  from: number;
  to: number;
};
/** What a ledge covers beyond its own wall: the floor under it and any wall its end lies against. */
export function ledgeFootprints(room: RoomDimensions, feature: ResolvedWallFeature): LedgeFootprint[] {
  if (!feature.protrudes) return [];
  const { min, max } = feature.worldBounds;
  const { widthMm: w, depthMm: d, heightMm: h } = room;
  const result: LedgeFootprint[] = [];
  if (min[1] === 0)
    result.push({
      face: 'floor',
      left: (min[0] + w / 2) / w,
      right: (max[0] + w / 2) / w,
      from: min[2] / d,
      to: max[2] / d,
    });
  const from = 1 - max[1] / h,
    to = 1 - min[1] / h;
  if (feature.face !== 'left' && min[0] === -w / 2)
    result.push({ face: 'left', left: 1 - max[2] / d, right: 1 - min[2] / d, from, to });
  if (feature.face !== 'right' && max[0] === w / 2)
    result.push({ face: 'right', left: min[2] / d, right: max[2] / d, from, to });
  if (feature.face !== 'back' && min[2] === 0)
    result.push({ face: 'back', left: (min[0] + w / 2) / w, right: (max[0] + w / 2) / w, from, to });
  return result;
}

/**
 * Validate authored Scene features without changing room dimensions or repairing input.
 * Missing/empty features leave legacy photo scenes alone; their room validation remains the caller's.
 */
export function validateWallFeatures(
  room: RoomDimensions | undefined,
  features: unknown,
): WallFeatureValidationIssue[] {
  if (features === undefined) return [];
  if (!Array.isArray(features))
    return [{ code: 'invalid-features', path: ['wallFeatures'], message: '벽 구조 목록을 확인해 주세요.' }];
  if (features.length > WALL_FEATURE_MAX_COUNT)
    return [
      { code: 'too-many-features', path: ['wallFeatures'], message: '벽 구조는 장면당 24개까지 지원해요.' },
    ];
  if (features.length === 0) return [];
  if (!validRoom(room))
    return [{ code: 'invalid-room', path: ['room'], message: '벽 구조를 놓을 유효한 방 치수가 필요해요.' }];

  const issues: WallFeatureValidationIssue[] = [];
  const ids = new Set<string>();
  const resolved: { index: number; value: ResolvedWallFeature }[] = [];
  for (const [index, input] of features.entries()) {
    const before = issues.length;
    const issue = (code: WallFeatureIssueCode, field: string | undefined, message: string) =>
      issues.push({
        code,
        path: ['wallFeatures', index, ...(field ? [field] : [])],
        message,
        ...(isRecord(input) && typeof input.id === 'string' ? { featureId: input.id } : {}),
      });
    if (!isRecord(input)) {
      issue('invalid-feature', undefined, '벽 구조 항목을 확인해 주세요.');
      continue;
    }
    if (input.version !== 1) issue('invalid-version', 'version', '지원하지 않는 벽 구조 버전이에요.');
    if (!uuid.safeParse(input.id).success) issue('invalid-id', 'id', '벽 구조 ID는 UUID여야 해요.');
    else {
      // UUID letter case does not create another identity. Preserve the supplied spelling.
      const id = (input.id as string).toLowerCase();
      if (ids.has(id)) issue('duplicate-id', 'id', '같은 장면의 벽 구조 ID가 중복되었어요.');
      ids.add(id);
    }
    const ledge = input.kind === 'ledge';
    if (input.kind !== 'closed-niche' && input.kind !== 'floor-alcove' && !ledge)
      issue('invalid-kind', 'kind', '지원하지 않는 벽 구조 형태예요.');
    if (input.source !== 'user')
      issue('invalid-source', 'source', '첫 벽 구조 형식은 사용자 입력만 지원해요.');
    if (!['left', 'back', 'right'].includes(input.face as string))
      issue('invalid-face', 'face', '벽 구조는 왼쪽·정면·오른쪽 벽에만 놓을 수 있어요.');
    for (const key of Object.keys(input))
      if (
        !commonKeys.has(key) &&
        !(ledge ? key === 'bottomMm' || key === 'heightMm' : key === 'topMm') &&
        !(input.kind === 'closed-niche' && key === 'heightMm')
      )
        issue(
          'unexpected-field',
          key,
          '지원하지 않는 벽 구조 필드가 있어요. 바닥 연결 높이는 별도로 저장하지 않아요.',
        );
    const fields = [
      'leftMm',
      ledge ? 'bottomMm' : 'topMm',
      'widthMm',
      'depthMm',
      ...(input.kind === 'closed-niche' || ledge ? ['heightMm'] : []),
    ];
    for (const field of fields) {
      const value = input[field];
      if (typeof value !== 'number' || !Number.isFinite(value))
        issue('invalid-number', field, '벽 구조 치수는 유한한 숫자여야 해요.');
      // A ledge may stand on the floor and reach its wall's end.
      else if (ledge && (field === 'leftMm' || field === 'bottomMm') ? value < 0 : value <= 0)
        issue('invalid-size', field, '벽 구조 치수와 천장·옆벽 여백은 0보다 커야 해요.');
      else if (field === 'depthMm' && value > WALL_FEATURE_MAX_DEPTH_MM)
        issue('invalid-size', field, '벽 구조 깊이는 지원 범위인 1000mm 이하여야 해요.');
    }
    if (issues.length !== before) continue;
    const feature = input as WallFeatureV1;
    const span = feature.face === 'back' ? room.widthMm : room.depthMm;
    const right = feature.leftMm + feature.widthMm;
    if (feature.kind === 'ledge') {
      if (right > span || !Number.isFinite(right))
        issue('out-of-bounds', 'widthMm', '젠다이의 오른쪽 끝은 벽 안에 있어야 해요.');
      const top = room.heightMm - feature.bottomMm - feature.heightMm;
      if (!(top > 0)) issue('out-of-bounds', 'heightMm', '젠다이의 윗면은 천장 아래에 있어야 해요.');
      if (feature.depthMm >= (feature.face === 'back' ? room.depthMm : room.widthMm))
        issue('out-of-bounds', 'depthMm', '젠다이의 깊이는 방 안에 들어와야 해요.');
      if (right <= feature.leftMm)
        issue('invalid-size', undefined, '벽 구조 폭과 높이가 계산 가능한 양수 범위여야 해요.');
    } else {
      const bottom = feature.kind === 'floor-alcove' ? room.heightMm : feature.topMm + feature.heightMm;
      if (right >= span || !Number.isFinite(right))
        issue('out-of-bounds', 'widthMm', '벽 구조의 오른쪽 가장자리는 벽 안에 있어야 해요.');
      if (feature.topMm >= room.heightMm || (feature.kind === 'closed-niche' && bottom >= room.heightMm))
        issue(
          'out-of-bounds',
          feature.kind === 'closed-niche' ? 'heightMm' : 'topMm',
          '벽 홈은 방 높이 안에 있어야 해요. 바닥까지 이으려면 바닥에서를 0으로 넣어 주세요.',
        );
      if (right <= feature.leftMm || bottom <= feature.topMm)
        issue('invalid-size', undefined, '벽 구조 폭과 높이가 계산 가능한 양수 범위여야 해요.');
    }
    if (issues.length === before) {
      const value = resolveValid(room, feature);
      if (value.worldBounds.min.some((lower, axis) => value.worldBounds.max[axis] <= lower))
        issue('invalid-size', undefined, '벽 구조 치수가 세계 좌표에서도 계산 가능한 양수 범위여야 해요.');
      else resolved.push({ index, value });
    }
  }
  for (let i = 0; i < resolved.length; i++)
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i].value,
        b = resolved[j].value;
      const epsilon = WALL_FEATURE_CONTACT_EPSILON_MM;
      const sameFace = a.face === b.face;
      const overlaps = [0, 1, 2].map(
        (axis) =>
          Math.min(a.worldBounds.max[axis], b.worldBounds.max[axis]) -
          Math.max(a.worldBounds.min[axis], b.worldBounds.min[axis]),
      );
      // Two ledges may touch (side by side, one on the other, round a corner): only a shared volume
      // is refused. A niche still needs clear wall around it.
      const ledges = !!a.protrudes && !!b.protrudes;
      const touches = ledges
        ? overlaps.every((overlap) => overlap > epsilon)
        : sameFace
          ? Math.min(a.openingMm.right, b.openingMm.right) - Math.max(a.openingMm.left, b.openingMm.left) >=
              -epsilon &&
            Math.min(a.openingMm.bottom, b.openingMm.bottom) - Math.max(a.openingMm.top, b.openingMm.top) >=
              -epsilon
          : overlaps.every((overlap) => overlap >= -epsilon);
      if (touches)
        issues.push({
          code: sameFace ? 'touching-or-overlap' : 'volume-collision',
          path: ['wallFeatures', resolved[j].index],
          featureId: b.id,
          relatedFeatureId: a.id,
          message: ledges
            ? LEDGE_OVERLAP_MESSAGE
            : '서로 겹치거나 맞닿는 벽 구조는 별도 연결 형상이 필요해요.',
        });
    }
  return issues;
}

type Axis = 0 | 1 | 2;
type Side = 'min' | 'max';
/** The axis a ledge stands out along: its wall's own plane is one end of it. */
const depthAxis = (face: WallFeatureFace): Axis => (face === 'back' ? 2 : 0);
/** The box end lying in the ledge's own wall, which never moves. */
const wallSide = (face: WallFeatureFace): Side => (face === 'right' ? 'max' : 'min');

/** A ledge with one end of its box moved: the box, and the one measure of the opening that follows it. */
function withEdge(
  room: RoomDimensions,
  feature: ResolvedWallFeature,
  axis: Axis,
  side: Side,
  value: number,
): ResolvedWallFeature {
  const min: [number, number, number] = [...feature.worldBounds.min],
    max: [number, number, number] = [...feature.worldBounds.max];
  (side === 'min' ? min : max)[axis] = value;
  const mm = { ...feature.openingMm };
  let depthMm = feature.depthMm;
  if (axis === 1) {
    if (side === 'min') mm.bottom = room.heightMm - value;
    else mm.top = room.heightMm - value;
  } else if (axis === depthAxis(feature.face))
    depthMm =
      feature.face === 'back'
        ? value
        : feature.face === 'left'
          ? value + room.widthMm / 2
          : room.widthMm / 2 - value;
  else if (feature.face === 'back') mm[side === 'min' ? 'left' : 'right'] = value + room.widthMm / 2;
  else if (feature.face === 'left') mm[side === 'min' ? 'right' : 'left'] = room.depthMm - value;
  else mm[side === 'min' ? 'left' : 'right'] = value;
  return {
    ...feature,
    heightMm: mm.bottom - mm.top,
    depthMm,
    opening: {
      left: mm.left / feature.wallSpanMm,
      top: mm.top / room.heightMm,
      right: mm.right / feature.wallSpanMm,
      bottom: mm.bottom / room.heightMm,
    },
    openingMm: mm,
    worldBounds: { min, max },
  };
}

const boxOverlap = (a: WallFeatureBounds, b: WallFeatureBounds, axis: number) =>
  Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]);

/**
 * The features as they are built: every one resolved, and ledges that face each other across
 * LEDGE_JOIN_GAP_MM or less made to touch (the later one of the list reaches the earlier; one that
 * meets the other's front with its end is the one that reaches). Edges a rounding error apart become
 * the same number. Stored millimetres are not changed; drawing, areas, floor contact and the AI
 * description all take this shape. Call validateWallFeatures first.
 */
export function joinedLedges(
  room: RoomDimensions,
  features: readonly WallFeatureV1[] | undefined,
): ResolvedWallFeature[] {
  const result = (features ?? []).map((feature) => resolveValid(room, feature));
  const epsilon = WALL_FEATURE_CONTACT_EPSILON_MM;
  const ledges = result.map((feature, index) => (feature.protrudes ? index : -1)).filter((i) => i >= 0);
  if (ledges.length < 2) return result;
  const locked = (feature: ResolvedWallFeature, axis: Axis, side: Side) =>
    axis === depthAxis(feature.face) && side === wallSide(feature.face);
  const sides: Side[] = ['min', 'max'];
  // Rounding: the same plane is one number.
  for (const i of ledges)
    for (const j of ledges) {
      if (j <= i) continue;
      for (const axis of [0, 1, 2] as Axis[])
        for (const si of sides)
          for (const sj of sides) {
            const a = result[i].worldBounds[si][axis],
              b = result[j].worldBounds[sj][axis];
            if (a === b || Math.abs(a - b) > epsilon) continue;
            if (!locked(result[j], axis, sj)) result[j] = withEdge(room, result[j], axis, sj, a);
            else if (!locked(result[i], axis, si)) result[i] = withEdge(room, result[i], axis, si, b);
          }
    }
  const collides = (candidate: ResolvedWallFeature, self: number) =>
    result.some((other, index) => {
      if (index === self) return false;
      if (other.protrudes)
        return [0, 1, 2].every(
          (axis) => boxOverlap(candidate.worldBounds, other.worldBounds, axis) > epsilon,
        );
      return (
        other.face === candidate.face &&
        Math.min(candidate.openingMm.right, other.openingMm.right) -
          Math.max(candidate.openingMm.left, other.openingMm.left) >=
          -epsilon &&
        Math.min(candidate.openingMm.bottom, other.openingMm.bottom) -
          Math.max(candidate.openingMm.top, other.openingMm.top) >=
          -epsilon
      );
    });
  for (const i of ledges)
    for (const j of ledges) {
      if (j <= i) continue;
      const overlaps = [0, 1, 2].map((axis) =>
        boxOverlap(result[i].worldBounds, result[j].worldBounds, axis),
      );
      const apart = overlaps.filter((overlap) => overlap < 0);
      // One gap, across faces that overlap: ledges meeting only at an edge or a corner stay as they are.
      if (apart.length !== 1 || -apart[0] > LEDGE_JOIN_GAP_MM) continue;
      if (overlaps.some((overlap) => overlap >= 0 && overlap <= epsilon)) continue;
      const axis = overlaps.findIndex((overlap) => overlap < 0) as Axis;
      // The one whose end, top or underside faces the gap reaches across; a depth never changes.
      const mover = depthAxis(result[j].face) !== axis ? j : depthAxis(result[i].face) !== axis ? i : -1;
      if (mover < 0) continue;
      const other = mover === j ? i : j;
      const above = result[mover].worldBounds.min[axis] >= result[other].worldBounds.max[axis];
      const moved = withEdge(
        room,
        result[mover],
        axis,
        above ? 'min' : 'max',
        result[other].worldBounds[above ? 'max' : 'min'][axis],
      );
      if (!collides(moved, mover)) result[mover] = moved;
    }
  return result;
}

/** A ledge's faces, named as its drawn pieces are. */
export type LedgeFaceRole = 'front' | 'reveal-left' | 'reveal-right' | 'reveal-top' | 'reveal-bottom';
/**
 * A rectangle of a ledge's face that another ledge lies flat against, in the ledge's own wall
 * millimetres. `a`: along the wall (front, top, underside) or down from the ceiling (the two ends);
 * `b`: down from the ceiling (front) or out from the wall (the others).
 */
export type LedgeCover = {
  role: LedgeFaceRole;
  /** The wall of the ledge that covers it. */
  by: WallFeatureFace;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
};
/** A box as a wall sees it: along the wall, down from the ceiling and out into the room. */
function boundsOnFace(room: RoomDimensions, face: WallFeatureFace, bounds: WallFeatureBounds) {
  const { min, max } = bounds,
    w = room.widthMm,
    d = room.depthMm;
  const along =
    face === 'back'
      ? { left: min[0] + w / 2, right: max[0] + w / 2, near: min[2], far: max[2] }
      : face === 'left'
        ? { left: d - max[2], right: d - min[2], near: min[0] + w / 2, far: max[0] + w / 2 }
        : { left: min[2], right: max[2], near: w / 2 - max[0], far: w / 2 - min[0] };
  return { ...along, top: room.heightMm - max[1], bottom: room.heightMm - min[1] };
}
/**
 * What the other ledges hide of this one (all from `joinedLedges`): neither drawn while the other
 * stands there nor tiled. Rectangles of one face do not overlap, as the ledges do not.
 */
export function ledgeCovers(
  room: RoomDimensions,
  ledge: ResolvedWallFeature,
  all: readonly ResolvedWallFeature[],
): LedgeCover[] {
  if (!ledge.protrudes) return [];
  const epsilon = WALL_FEATURE_CONTACT_EPSILON_MM;
  const o = ledge.openingMm,
    depth = ledge.depthMm;
  const covers: LedgeCover[] = [];
  const same = (a: number, b: number) => Math.abs(a - b) <= epsilon;
  for (const other of all) {
    if (other.id === ledge.id || !other.protrudes) continue;
    const box = boundsOnFace(room, ledge.face, other.worldBounds);
    const u0 = Math.max(o.left, box.left),
      u1 = Math.min(o.right, box.right),
      v0 = Math.max(o.top, box.top),
      v1 = Math.min(o.bottom, box.bottom),
      t0 = Math.max(0, box.near),
      t1 = Math.min(depth, box.far);
    const u = u1 - u0 > epsilon,
      v = v1 - v0 > epsilon,
      t = t1 - t0 > epsilon;
    const add = (role: LedgeFaceRole, a0: number, a1: number, b0: number, b1: number) =>
      covers.push({ role, by: other.face, a0, a1, b0, b1 });
    if (same(box.near, depth) && u && v) add('front', u0, u1, v0, v1);
    if (same(box.right, o.left) && v && t) add('reveal-left', v0, v1, t0, t1);
    if (same(box.left, o.right) && v && t) add('reveal-right', v0, v1, t0, t1);
    if (same(box.bottom, o.top) && u && t) add('reveal-top', u0, u1, t0, t1);
    if (same(box.top, o.bottom) && u && t) add('reveal-bottom', u0, u1, t0, t1);
  }
  return covers;
}

/**
 * Which body each feature of `joinedLedges` belongs to: ledges lying flat against each other share
 * a number (the index of the body's first ledge); a niche has -1.
 */
export function ledgeGroups(room: RoomDimensions, joined: readonly ResolvedWallFeature[]): number[] {
  const groups = joined.map((feature, index) => (feature.protrudes ? index : -1));
  for (let i = 0; i < joined.length; i++)
    for (let j = i + 1; j < joined.length; j++) {
      if (groups[i] < 0 || groups[j] < 0 || groups[i] === groups[j]) continue;
      if (!ledgeCovers(room, joined[i], [joined[j]]).length) continue;
      const from = Math.max(groups[i], groups[j]),
        to = Math.min(groups[i], groups[j]);
      for (let k = 0; k < groups.length; k++) if (groups[k] === from) groups[k] = to;
    }
  return groups;
}

/** Derived plain data only. Call validateWallFeatures first to validate a multi-feature scene. */
export function resolveWallFeature(room: RoomDimensions, feature: WallFeatureV1): ResolvedWallFeature {
  const issues = validateWallFeatures(room, [feature]);
  if (issues.length) throw new WallFeatureValidationError(issues);
  return resolveValid(room, feature);
}

/** Preserve stored millimetres; an alcove's floor connection alone derives its new height. */
export function validateWallFeatureResize(
  scene: { room?: RoomDimensions; wallFeatures?: readonly WallFeatureV1[] },
  nextRoom: RoomDimensions,
): WallFeatureValidationIssue[] {
  const previousIssues = validateWallFeatures(scene.room, scene.wallFeatures);
  return previousIssues.length ? previousIssues : validateWallFeatures(nextRoom, scene.wallFeatures);
}
