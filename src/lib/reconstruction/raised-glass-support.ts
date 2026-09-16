import type { RaisedGlassSupport } from './types';

/** Descriptive relation evidence is mandatory whenever an automatic decision is stored. */
export function inferredSupportEvidenceErrors(
  provenance: Record<string, unknown> | undefined,
  evidence: unknown,
): string[] {
  const inferred = provenance && Object.values(provenance).includes('inferred');
  if (!inferred && evidence === undefined) return [];
  return !Array.isArray(evidence) ||
    evidence.length < 1 ||
    evidence.length > 20 ||
    evidence.some((value) => typeof value !== 'string' || !value.trim() || value.length > 2000)
    ? ['추정한 유리 지지 관계에는 관측 근거가 필요해요.']
    : [];
}

export function hasParentGlassSupport(support?: RaisedGlassSupport) {
  return !!(support?.bathRim || support?.partitionTop);
}

/** Supports retain strict physical contact checks; an inferred source never bypasses them. */
export function raisedGlassSupportErrors(placement: {
  kind?: string;
  version?: number;
  face?: string;
  baseHeightMm?: number;
  support?: RaisedGlassSupport;
  widthMm?: number;
  depthMm?: number;
  scale?: number;
}): string[] {
  if (placement.support === undefined) return [];
  const support = placement.support;
  const errors: string[] = [];
  const source = (value: unknown) => value === 'user' || value === 'inferred';
  if (placement.kind !== 'glassPartition' || placement.version !== 2 || placement.face !== 'floor')
    errors.push('높은 지지면은 바닥 좌표로 배치하는 새 유리 파티션에서만 사용할 수 있어요.');
  if (
    !support ||
    !['bath-rim', 'shower-curb', 'partition-top'].includes(support.kind) ||
    !Number.isFinite(support.heightMm) ||
    support.heightMm <= 0 ||
    support.heightMm > 20000 ||
    !source(support.provenance?.kind) ||
    !['user', 'default', 'parent', 'inferred'].includes(support.provenance?.height)
  )
    errors.push('유리 지지면의 종류와 0보다 큰 높이, 판단 출처를 확인해 주세요.');
  else if (
    !Number.isFinite(placement.baseHeightMm) ||
    Math.abs(placement.baseHeightMm! - support.heightMm) > 1
  )
    errors.push('유리 하단 높이와 확인한 지지면 높이가 서로 달라요.');

  errors.push(...inferredSupportEvidenceErrors(support?.provenance, support?.evidence));
  if (support?.bathRim) {
    const link = support.bathRim;
    if (
      support.kind !== 'bath-rim' ||
      support.curb ||
      support.partitionTop ||
      typeof link.parentFixtureId !== 'string' ||
      !link.parentFixtureId.trim() ||
      !['left', 'right', 'front', 'back'].includes(link.side) ||
      !Number.isFinite(link.offsetMm) ||
      Math.abs(link.offsetMm) > 20000 ||
      !source(link.provenance?.parent) ||
      !source(link.provenance?.side) ||
      !source(link.provenance?.offset) ||
      support.provenance?.height !== 'parent'
    )
      errors.push('욕조 연결 대상·테두리·중앙 기준 거리와 판단 출처를 확인해 주세요.');
    errors.push(...inferredSupportEvidenceErrors(link.provenance, support.evidence));
    if (Object.values(link.provenance ?? {}).includes('inferred') && support.provenance?.kind !== 'inferred')
      errors.push('추정한 욕조 연결을 사용자 확인으로 저장할 수 없어요.');
  }
  if (support?.partitionTop) {
    const link = support.partitionTop;
    if (
      support.kind !== 'partition-top' ||
      support.curb ||
      support.bathRim ||
      typeof link.parentFixtureId !== 'string' ||
      !link.parentFixtureId.trim() ||
      !Number.isFinite(link.offsetMm) ||
      Math.abs(link.offsetMm) > 20000 ||
      !source(link.provenance?.parent) ||
      !source(link.provenance?.offset) ||
      support.provenance?.height !== 'parent'
    )
      errors.push('낮은 칸막이 연결 대상·중앙 기준 거리와 판단 출처를 확인해 주세요.');
    errors.push(...inferredSupportEvidenceErrors(link.provenance, support.evidence));
    if (Object.values(link.provenance ?? {}).includes('inferred') && support.provenance?.kind !== 'inferred')
      errors.push('추정한 칸막이 연결을 사용자 확인으로 저장할 수 없어요.');
  }
  if (support?.kind === 'partition-top' && !support.partitionTop)
    errors.push('칸막이 상단 지지에는 실제 연결된 낮은 칸막이 정보가 필요해요.');
  if (!hasParentGlassSupport(support) && support?.provenance?.height === 'parent')
    errors.push('부모에서 계산한 높이에는 연결된 욕조 또는 낮은 칸막이 정보가 필요해요.');
  if (support?.provenance?.kind === 'inferred' && !hasParentGlassSupport(support) && !support.curb)
    errors.push('추정 높이만으로 보이지 않는 지지 물체를 만들 수 없어요.');
  if (hasParentGlassSupport(support) && (placement.scale ?? 1) !== 1)
    errors.push('부모에 연결한 유리는 배율 대신 모형 규격으로 크기를 바꿔 주세요.');
  if (support?.curb) {
    const curb = support.curb;
    if (
      support.kind !== 'shower-curb' ||
      support.bathRim ||
      support.partitionTop ||
      ![curb.widthMm, curb.depthMm].every((n) => Number.isFinite(n) && n > 0 && n <= 20000) ||
      !['user', 'default'].includes(curb.provenance?.width) ||
      !['user', 'default'].includes(curb.provenance?.depth)
    )
      errors.push('턱 모형은 샤워 턱에서만 만들 수 있어요. 턱 폭·깊이와 기본값/사용자 출처를 확인해 주세요.');
    else if (
      (placement.widthMm !== undefined && curb.widthMm < placement.widthMm) ||
      (placement.depthMm !== undefined && curb.depthMm < placement.depthMm)
    )
      errors.push('턱 폭과 깊이는 그 위에 놓는 유리의 폭과 깊이 이상이어야 해요.');
    if ((placement.scale ?? 1) !== 1)
      errors.push('턱을 포함한 유리는 배율 대신 실제 모형 규격 입력으로 크기를 바꿔 주세요.');
  }
  return [...new Set(errors)];
}

export const raisedGlassSupportLabels = {
  'bath-rim': '욕조 테두리',
  'shower-curb': '샤워 턱',
  'partition-top': '낮은 칸막이 상단',
} as const;

/** A visible default suggestion, persisted only by explicit user selection/application. */
export function defaultShowerCurb(widthMm: number, depthMm: number): NonNullable<RaisedGlassSupport['curb']> {
  return {
    widthMm: widthMm + 40,
    depthMm: Math.max(120, depthMm + 40),
    provenance: { width: 'default', depth: 'default' },
  };
}

/** Component boxes share the glass-bottom origin. The modeled curb extends down to the room floor. */
export function reconstructionLocalBoxes(placement: {
  kind?: string;
  version?: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  support?: RaisedGlassSupport;
}) {
  const boxes = [
    {
      min: [-placement.widthMm / 2, 0, -placement.depthMm / 2],
      max: [placement.widthMm / 2, placement.heightMm, placement.depthMm / 2],
    },
  ];
  const support = placement.support;
  if (
    placement.kind === 'glassPartition' &&
    placement.version === 2 &&
    support?.kind === 'shower-curb' &&
    support.curb
  )
    boxes.push({
      min: [-support.curb.widthMm / 2, -support.heightMm, -support.curb.depthMm / 2],
      max: [support.curb.widthMm / 2, 0, support.curb.depthMm / 2],
    });
  return boxes;
}
