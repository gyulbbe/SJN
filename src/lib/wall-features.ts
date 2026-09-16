import { z } from 'zod';
import { roomDefinitionSchema } from './room-validation';
import type { RoomDimensions } from './room-types';

export const WALL_FEATURE_MAX_COUNT = 24;
/** Supported modelling depth, not an estimate of the real wall thickness. */
export const WALL_FEATURE_MAX_DEPTH_MM = 1000;
export const WALL_FEATURE_CONTACT_EPSILON_MM = 1e-6;

export type WallFeatureFace = 'left' | 'back' | 'right';
type WallFeatureBaseV1 = {
  version: 1;
  id: string;
  face: WallFeatureFace;
  /** Distance from the wall's u=0 edge; never a photograph x coordinate. */
  leftMm: number;
  /** Distance down from the room ceiling. */
  topMm: number;
  widthMm: number;
  depthMm: number;
  /** Explicitly authored values; this does not claim a physical measurement. */
  source: 'user';
};
export type WallFeatureV1 = WallFeatureBaseV1 &
  ({ kind: 'closed-niche'; heightMm: number } | { kind: 'floor-alcove'; heightMm?: never });

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
  /** The full void from its mouth to the rear face, in room millimetres. */
  worldBounds: WallFeatureBounds;
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
const commonKeys = new Set([
  'version',
  'id',
  'kind',
  'face',
  'leftMm',
  'topMm',
  'widthMm',
  'depthMm',
  'source',
]);
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
  const left = feature.leftMm,
    right = left + feature.widthMm,
    top = feature.topMm,
    bottom = feature.kind === 'floor-alcove' ? room.heightMm : top + feature.heightMm;
  const lowY = room.heightMm - bottom,
    highY = room.heightMm - top,
    d = feature.depthMm;
  let min: WallFeaturePoint3, max: WallFeaturePoint3, inwardNormal: WallFeaturePoint3;
  if (feature.face === 'back') {
    min = [left - room.widthMm / 2, lowY, -d];
    max = [right - room.widthMm / 2, highY, 0];
    inwardNormal = [0, 0, 1];
  } else if (feature.face === 'left') {
    min = [-room.widthMm / 2 - d, lowY, room.depthMm - right];
    max = [-room.widthMm / 2, highY, room.depthMm - left];
    inwardNormal = [1, 0, 0];
  } else {
    min = [room.widthMm / 2, lowY, left];
    max = [room.widthMm / 2 + d, highY, right];
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
  };
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
    if (input.kind !== 'closed-niche' && input.kind !== 'floor-alcove')
      issue('invalid-kind', 'kind', '닫힌 홈 또는 바닥까지 열린 공간을 선택해 주세요.');
    if (input.source !== 'user')
      issue('invalid-source', 'source', '첫 벽 구조 형식은 사용자 입력만 지원해요.');
    if (!['left', 'back', 'right'].includes(input.face as string))
      issue('invalid-face', 'face', '벽 구조는 왼쪽·정면·오른쪽 벽에만 놓을 수 있어요.');
    for (const key of Object.keys(input))
      if (!commonKeys.has(key) && !(input.kind === 'closed-niche' && key === 'heightMm'))
        issue(
          'unexpected-field',
          key,
          '지원하지 않는 벽 구조 필드가 있어요. 바닥 연결 높이는 별도로 저장하지 않아요.',
        );
    const fields = [
      'leftMm',
      'topMm',
      'widthMm',
      'depthMm',
      ...(input.kind === 'closed-niche' ? ['heightMm'] : []),
    ];
    for (const field of fields) {
      const value = input[field];
      if (typeof value !== 'number' || !Number.isFinite(value))
        issue('invalid-number', field, '벽 구조 치수는 유한한 숫자여야 해요.');
      else if (value <= 0) issue('invalid-size', field, '벽 구조 치수와 천장·옆벽 여백은 0보다 커야 해요.');
      else if (field === 'depthMm' && value > WALL_FEATURE_MAX_DEPTH_MM)
        issue('invalid-size', field, '벽 구조 깊이는 지원 범위인 1000mm 이하여야 해요.');
    }
    if (issues.length !== before) continue;
    const feature = input as WallFeatureV1;
    const span = feature.face === 'back' ? room.widthMm : room.depthMm;
    const right = feature.leftMm + feature.widthMm;
    const bottom = feature.kind === 'floor-alcove' ? room.heightMm : feature.topMm + feature.heightMm;
    if (right >= span || !Number.isFinite(right))
      issue('out-of-bounds', 'widthMm', '벽 구조의 오른쪽 가장자리는 벽 안에 있어야 해요.');
    if (feature.topMm >= room.heightMm || (feature.kind === 'closed-niche' && bottom >= room.heightMm))
      issue(
        'out-of-bounds',
        feature.kind === 'closed-niche' ? 'heightMm' : 'topMm',
        '닫힌 홈은 바닥보다 높아야 하고, 열린 공간에도 양수 높이가 필요해요.',
      );
    if (right <= feature.leftMm || bottom <= feature.topMm)
      issue('invalid-size', undefined, '벽 구조 폭과 높이가 계산 가능한 양수 범위여야 해요.');
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
      const touches = sameFace
        ? Math.min(a.openingMm.right, b.openingMm.right) - Math.max(a.openingMm.left, b.openingMm.left) >=
            -epsilon &&
          Math.min(a.openingMm.bottom, b.openingMm.bottom) - Math.max(a.openingMm.top, b.openingMm.top) >=
            -epsilon
        : [0, 1, 2].every(
            (axis) =>
              Math.min(a.worldBounds.max[axis], b.worldBounds.max[axis]) -
                Math.max(a.worldBounds.min[axis], b.worldBounds.min[axis]) >=
              -epsilon,
          );
      if (touches)
        issues.push({
          code: sameFace ? 'touching-or-overlap' : 'volume-collision',
          path: ['wallFeatures', resolved[j].index],
          featureId: b.id,
          relatedFeatureId: a.id,
          message: '서로 겹치거나 맞닿는 벽 구조는 별도 연결 형상이 필요해요.',
        });
    }
  return issues;
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
