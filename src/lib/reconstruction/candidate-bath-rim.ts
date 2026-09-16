import type { RoomDefinition } from '../room-types';
import { DEFAULT_COLOR, EMPTY_MASK, type FixtureInstance } from '../types';
import type { CandidateFixturePlan } from './candidate-pipeline';
import { resolveBathRimPlacement, type BathRimResolution } from './bath-rim';
import { inferredSupportEvidenceErrors } from './raised-glass-support';
import type { RaisedGlassSupport, SupportDecisionSource } from './types';

/** Candidate IDs are remapped to real fixture IDs after the parent has been generated. */
export type CandidateBathRim = {
  parentCandidateId: string;
  side: 'left' | 'right' | 'front' | 'back';
  offsetMm: number;
  provenance: { parent: SupportDecisionSource; side: SupportDecisionSource; offset: SupportDecisionSource };
  evidence?: string[];
};
export type CandidatePartitionTop = {
  parentCandidateId: string;
  offsetMm: number;
  provenance: { parent: SupportDecisionSource; offset: SupportDecisionSource };
  evidence?: string[];
};
function candidateSupportErrors(link: CandidateBathRim | CandidatePartitionTop, fields: string[]): string[] {
  const values = link.provenance as Record<string, unknown> | undefined;
  const errors =
    typeof link.parentCandidateId !== 'string' ||
    !link.parentCandidateId.trim() ||
    !Number.isFinite(link.offsetMm) ||
    Math.abs(link.offsetMm) > 20000 ||
    fields.some((field) => values?.[field] !== 'user' && values?.[field] !== 'inferred')
      ? ['연결할 부모 후보와 중앙 기준 거리(mm), 판단 출처를 확인해 주세요.']
      : [];
  return [...errors, ...inferredSupportEvidenceErrors(values, link.evidence)];
}
export function candidateBathRimErrors(link: CandidateBathRim): string[] {
  return [
    ...candidateSupportErrors(link, ['parent', 'side', 'offset']),
    ...(!['left', 'right', 'front', 'back'].includes(link.side)
      ? ['연결할 욕조 테두리를 확인해 주세요.']
      : []),
  ];
}
export function candidatePartitionTopErrors(link: CandidatePartitionTop): string[] {
  return candidateSupportErrors(link, ['parent', 'offset']);
}
const supportSource = (link: CandidateBathRim | CandidatePartitionTop): SupportDecisionSource =>
  Object.values(link.provenance).includes('inferred') ? 'inferred' : 'user';
export function bathRimFixtureSupport(
  link: CandidateBathRim,
  parentFixtureId: string,
  heightMm: number,
): RaisedGlassSupport {
  return {
    kind: 'bath-rim',
    heightMm,
    provenance: { kind: supportSource(link), height: 'parent' },
    ...(link.evidence ? { evidence: [...link.evidence] } : {}),
    bathRim: {
      parentFixtureId,
      side: link.side,
      offsetMm: link.offsetMm,
      provenance: { ...link.provenance },
    },
  };
}
export function partitionTopFixtureSupport(
  link: CandidatePartitionTop,
  parentFixtureId: string,
  heightMm: number,
): RaisedGlassSupport {
  return {
    kind: 'partition-top',
    heightMm,
    provenance: { kind: supportSource(link), height: 'parent' },
    ...(link.evidence ? { evidence: [...link.evidence] } : {}),
    partitionTop: { parentFixtureId, offsetMm: link.offsetMm, provenance: { ...link.provenance } },
  };
}
/** Virtual parent is calculation input, never saved or reported as an AI-created fixture. */
function resolveCandidateSupport(
  room: RoomDefinition,
  link: CandidateBathRim | CandidatePartitionTop,
  parent: CandidateFixturePlan | null | undefined,
  child: CandidateFixturePlan,
  kind: 'bath' | 'lowPartition',
): BathRimResolution {
  const errors =
    kind === 'bath' ? candidateBathRimErrors(link as CandidateBathRim) : candidatePartitionTopErrors(link);
  if (errors.length) return { status: 'held', reason: errors.join(' ') };
  if (child.kind !== 'glassPartition')
    return { status: 'held', reason: '부모 지지 연결은 유리 파티션 후보에서만 사용할 수 있어요.' };
  if (!parent || parent.kind !== kind || parent.face !== 'floor' || parent.version !== 2)
    return {
      status: 'held',
      reason:
        '연결할 부모 후보가 아직 배치되지 않았거나 제외·다른 종류로 변경됐어요. 부모 욕조 또는 낮은 칸막이의 종류와 설치 위치를 확인해 주세요.',
    };
  if (
    ![parent.widthMm, parent.heightMm, parent.depthMm, child.widthMm, child.heightMm, child.depthMm].every(
      (n) => n !== undefined && Number.isFinite(n) && n > 0,
    )
  )
    return { status: 'held', reason: '부모와 유리의 기본 규격 또는 입력값을 확인해 주세요.' };
  const p: FixtureInstance = {
    id: link.parentCandidateId,
    name: kind === 'bath' ? '욕조 후보' : '낮은 칸막이 후보',
    materialVersionId: 'private-calculation-only',
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.1,
    height: 0.1,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    roomPlacement: {
      face: 'floor',
      u: parent.u,
      v: parent.v,
      scale: 1,
      widthMm: parent.widthMm!,
      heightMm: parent.heightMm!,
      imageAspect: 1,
      contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    },
    reconstruction: {
      ...parent,
      version: 2,
      widthMm: parent.widthMm!,
      heightMm: parent.heightMm!,
      depthMm: parent.depthMm!,
      color: parent.color ?? '#eeeeee',
    },
  };
  return resolveBathRimPlacement(room, [p], {
    ...child,
    version: 2,
    widthMm: child.widthMm!,
    heightMm: child.heightMm!,
    depthMm: child.depthMm!,
    support:
      kind === 'bath'
        ? bathRimFixtureSupport(link as CandidateBathRim, p.id, parent.heightMm!)
        : partitionTopFixtureSupport(link, p.id, parent.heightMm!),
  });
}
export function resolveCandidateBathRim(
  room: RoomDefinition,
  link: CandidateBathRim,
  parent: CandidateFixturePlan | null | undefined,
  child: CandidateFixturePlan,
): BathRimResolution {
  return resolveCandidateSupport(room, link, parent, child, 'bath');
}
export function resolveCandidatePartitionTop(
  room: RoomDefinition,
  link: CandidatePartitionTop,
  parent: CandidateFixturePlan | null | undefined,
  child: CandidateFixturePlan,
): BathRimResolution {
  return resolveCandidateSupport(room, link, parent, child, 'lowPartition');
}
