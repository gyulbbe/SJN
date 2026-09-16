import type { RoomDefinition } from '../room-types';
import { validateRoomDimensions } from '../room-geometry';
import type { VolumePlacement } from './projection';
import { validateSourceFixture } from './source-camera';
import type { ReconstructionCandidate, ReconstructionKind } from './types';

export type PlacementReview = NonNullable<ReconstructionCandidate['placementReview']>;

/** Physical room-bounds validation only. No source camera, inferred image box, fit or clamp. */
export function inspectStrictPlacement(
  room: RoomDefinition,
  placement: VolumePlacement & { kind: ReconstructionKind },
): PlacementReview {
  const {
    kind,
    face,
    u,
    v,
    widthMm,
    heightMm,
    depthMm,
    baseHeightMm,
    yawDegrees,
    scale,
    orientation,
    support,
    provenance,
  } = placement;
  const requested: PlacementReview['requested'] = {
    kind,
    face,
    u,
    v,
    widthMm,
    heightMm,
    depthMm,
    ...(baseHeightMm !== undefined ? { baseHeightMm } : {}),
    ...(yawDegrees !== undefined ? { yawDegrees } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(orientation !== undefined ? { orientation } : {}),
    ...(support ? { support: structuredClone(support) } : {}),
    ...(provenance ? { provenance: structuredClone(provenance) } : {}),
  };
  const check = validateSourceFixture(room, undefined, placement);
  const reasons = [...check.reasons];
  if (!validateRoomDimensions(room)) reasons.push('공간 크기를 확인해 주세요.');
  if (![u, v].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
    reasons.push('요청한 면 위치가 0–100% 범위를 벗어납니다.');
  if (![widthMm, heightMm, depthMm].every((n) => Number.isFinite(n) && n > 0 && n <= 20000))
    reasons.push('요청한 모형 규격은 1–20,000mm 범위여야 합니다.');
  if (
    baseHeightMm !== undefined &&
    (!Number.isFinite(baseHeightMm) || baseHeightMm < 0 || baseHeightMm > room.heightMm)
  )
    reasons.push('요청한 설치 높이가 공간 높이 범위를 벗어납니다.');
  return {
    version: 1,
    status: reasons.length ? 'held' : 'accepted',
    requested,
    reasons,
    ...(check.worldBoundsMm ? { worldBoundsMm: check.worldBoundsMm } : {}),
    ...(check.overflowMm ? { overflowMm: check.overflowMm } : {}),
  };
}

/** Only geometric rejections may become held candidates; storage/render errors still fail normally. */
export class StrictPlacementError extends Error {
  constructor(readonly review: PlacementReview) {
    super(review.reasons.join(' '));
    this.name = 'StrictPlacementError';
  }
}

/** Only changed fields gain user provenance; position edits do not claim measured dimensions. */
export function confirmedPlacementProvenance(
  requested: PlacementReview['requested'],
  edits: Partial<PlacementReview['requested']> = {},
) {
  const previous = requested.provenance ?? {};
  const changed = (key: keyof PlacementReview['requested']) =>
    Object.hasOwn(edits, key) && edits[key] !== requested[key];
  const dimensions = changed('widthMm') || changed('heightMm') || changed('depthMm');
  return {
    ...previous,
    ...(changed('face') ? { wall: 'user' as const } : {}),
    position:
      changed('u') || changed('v') || changed('face') || changed('baseHeightMm') || changed('yawDegrees')
        ? ('user' as const)
        : (previous.position ?? ('default' as const)),
    dimensions: dimensions ? ('user' as const) : (previous.dimensions ?? ('default' as const)),
    width: changed('widthMm')
      ? ('user' as const)
      : (previous.width ?? previous.dimensions ?? ('default' as const)),
    height: changed('heightMm')
      ? ('user' as const)
      : (previous.height ?? previous.dimensions ?? ('default' as const)),
    depth: changed('depthMm')
      ? ('user' as const)
      : (previous.depth ?? previous.dimensions ?? ('default' as const)),
  };
}
