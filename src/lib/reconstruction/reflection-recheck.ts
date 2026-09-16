import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';
import type { ParsedFixtureAppearance } from './fixture-appearance-observation';
import { validAnalysisModelPair } from './analysis-provider';
import {
  canonicalTargetValue,
  validateTargetExistenceAnalysis,
  validateTargetExistenceReceipt,
  type TargetExistenceAnalysis,
  type TargetExistenceReceipt,
  type TargetExistenceObservation,
} from './target-existence-observation';

export const REFLECTION_RECHECK_RULE_REVISION = 'target-conflict-recheck-v3' as const;
export type ReflectionRecheckContext = {
  identity: SceneUnderstanding;
  installation: SceneUnderstanding;
  appearance: ParsedFixtureAppearance;
  /** Include user override IDs and manual placements; raw observations cannot identify every user edit. */
  protectedCandidateIds: ReadonlySet<string>;
};
export type ReflectionEligibility = {
  candidateId: string;
  eligible: boolean;
  reasonCodes: string[];
  reasons: string[];
};
export type ReflectionRecheckDecision = ReflectionEligibility & {
  status: 'not-eligible' | 'missing' | 'held' | 'applied';
  originalReflection: SceneCandidate['reflection'];
  effectiveReflection: SceneCandidate['reflection'];
  observationRawTextSha256?: string;
  /** New decision fields are optional only for historical saved records. */
  priorKind?: SceneCandidate['kind'];
  originalKind?: SceneCandidate['kind'];
  effectiveKind?: SceneCandidate['kind'];
  canonicalId?: string;
};
export type ReflectionRecheckEvidence = {
  version: 1;
  /** Historical records remain readable; only the current revision is eligible for analysis reuse. */
  ruleRevision:
    typeof REFLECTION_RECHECK_RULE_REVISION | 'reflection-direct-mirror-v2' | 'reflection-one-field-v1';
  photoFingerprint: string;
  image: { width: number; height: number };
  sourceDecisionSignature: string;
  requests: TargetExistenceReceipt[];
  observations: TargetExistenceAnalysis[];
  decisions: ReflectionRecheckDecision[];
};
const familyOf = (kind: string): 'mirror' | 'glass' | 'shower' | undefined =>
  kind === 'mirror' || kind === 'mirrorCabinet' || kind === 'mirror_cabinet'
    ? 'mirror'
    : kind === 'glassPartition' || kind === 'glass_partition'
      ? 'glass'
      : kind === 'shower'
        ? 'shower'
        : undefined;
function contextCandidates(input: ReflectionRecheckContext) {
  const current = input.appearance.understanding.candidates;
  if (current.length > 24 || new Set(current.map((c) => c.id)).size !== current.length)
    throw new Error('재확인 후보 ID가 반복되거나 너무 많아요.');
  const ids = new Set(current.map((c) => c.id));
  for (const candidates of [input.identity.candidates, input.installation.candidates])
    if (
      candidates.length !== current.length ||
      new Set(candidates.map((c) => c.id)).size !== current.length ||
      candidates.some((c) => !ids.has(c.id))
    )
      throw new Error('거울 재확인의 원관측 ID 목록이 달라요.');
  const observations = input.appearance.observations;
  if (
    observations.length !== current.length ||
    new Set(observations.map((o) => o.id)).size !== current.length ||
    observations.some((o) => !ids.has(o.id))
  )
    throw new Error('형태 원관측 목록이 현재 후보와 달라요.');
  const decisions = input.appearance.decisions;
  if (
    decisions.length !== current.length ||
    new Set(decisions.map((d) => d.candidateId)).size !== current.length ||
    decisions.some((d) => !ids.has(d.candidateId))
  )
    throw new Error('거울 재확인의 형태 판정 목록이 원후보와 달라요.');
  for (const id of input.protectedCandidateIds)
    if (!ids.has(id)) throw new Error('사용자 보호 대상이 원후보에 없어요.');
  for (const d of decisions)
    if (
      canonicalTargetValue(d.observation) !==
        canonicalTargetValue(observations.find((o) => o.id === d.candidateId)) ||
      canonicalTargetValue(d.effective) !==
        canonicalTargetValue(current.find((c) => c.id === d.candidateId)) ||
      canonicalTargetValue(d.original) !==
        canonicalTargetValue(input.installation.candidates.find((c) => c.id === d.candidateId))
    )
      throw new Error('형태 판정과 원래 설치/적용 관측이 달라요.');
  return current;
}
/** Includes all relevant observations and protected IDs, never a photo-specific exception or note parser. */
export function reflectionRecheckSignature(input: ReflectionRecheckContext): string {
  contextCandidates(input);
  return canonicalTargetValue({
    ruleRevision: REFLECTION_RECHECK_RULE_REVISION,
    identity: input.identity,
    installation: input.installation,
    appearance: input.appearance,
    protectedCandidateIds: [...input.protectedCandidateIds].sort(),
  });
}
export function reflectionRecheckCandidates(input: ReflectionRecheckContext): ReflectionEligibility[] {
  const current = contextCandidates(input);
  const scenes = [input.identity, input.installation, input.appearance.understanding];
  const relations = scenes.flatMap((s) => [
    ...s.relations,
    ...(s.validation?.quarantinedRelations ?? []).map((r) => r.relation),
  ]);
  return current.map((candidate) => {
    const identity = input.identity.candidates.find((c) => c.id === candidate.id)!;
    const installation = input.installation.candidates.find((c) => c.id === candidate.id)!;
    const decision = input.appearance.decisions.find((d) => d.candidateId === candidate.id)!;
    const reasonCodes: string[] = [],
      reasons: string[] = [];
    const hold = (code: string, message: string) => {
      reasonCodes.push(code);
      reasons.push(message);
    };
    const originalFamily = familyOf(identity.kind);
    if (!originalFamily || identity.reflection !== 'physical')
      hold('identity-not-physical-mirror', '앞선 관측이 재확인 가능한 실제 거울·유리·샤워 계열이 아니에요.');
    if (familyOf(installation.kind) !== originalFamily || installation.reflection !== 'physical')
      hold(
        'installation-not-physical-mirror',
        '앞선 두 관측의 실물 계열이 일치하지 않아 자동 교정하지 않아요.',
      );
    const reflectionConflict =
      candidate.reflection === 'reflected' && decision.observation.context === 'reflected';
    const kindConflict = originalFamily !== undefined && familyOf(candidate.kind) !== originalFamily;
    if (!reflectionConflict && !kindConflict)
      hold(
        'no-appearance-reflection-conflict',
        '형태 재확인에서 실물 여부나 설비 계열이 달라진 충돌이 아니에요.',
      );
    if (decision.status === 'held')
      hold('appearance-held', '기존 형태 관측의 보류를 새 관측으로 지우지 않아요.');
    if (
      input.protectedCandidateIds.has(candidate.id) ||
      [identity, installation, candidate].some((c) => Object.values(c.provenance ?? {}).includes('user'))
    )
      hold('user-controlled', '사용자가 확인하거나 배치한 후보는 자동 관측으로 바꾸지 않아요.');
    if ([identity, installation, candidate].some((c) => c.validation?.issues.length))
      hold('existing-validation', '기존 관측 검증 오류를 새 관측으로 지우지 않아요.');
    if (
      relations.some(
        (r) => r.relation === 'reflectionOf' && (r.frontId === candidate.id || r.behindId === candidate.id),
      )
    )
      hold('explicit-reflection-relation', '명시적 반사 관계가 있어 실제 표면으로 자동 승격하지 않아요.');
    if (
      relations.some(
        (r) => r.relation === 'partOf' && (r.frontId === candidate.id || r.behindId === candidate.id),
      )
    )
      hold('explicit-component-relation', '명시적 구성 부품 관계가 있어 독립 실물로 복구하지 않아요.');
    if (
      canonicalTargetValue(identity.bounds) !== canonicalTargetValue(installation.bounds) ||
      canonicalTargetValue(installation.bounds) !== canonicalTargetValue(candidate.bounds)
    )
      hold('bounds-mismatch', '원래 후보 영역이 단계 사이에서 달라졌어요.');
    return { candidateId: candidate.id, eligible: reasonCodes.length === 0, reasonCodes, reasons };
  });
}
/** No I/O. Request receipts must be prepared independently from the actual current image bytes. */
export async function applyReflectionRechecks(
  input: ReflectionRecheckContext & {
    expected: {
      photoFingerprint: string;
      image: { width: number; height: number };
      modelId: string;
      modelRevision: string;
      requests: readonly TargetExistenceReceipt[];
    };
    observations: readonly TargetExistenceAnalysis[];
  },
): Promise<{ understanding: SceneUnderstanding; record: ReflectionRecheckEvidence }> {
  input = structuredClone(input);
  const eligibility = reflectionRecheckCandidates(input),
    signature = reflectionRecheckSignature(input),
    boxes = input.appearance.understanding.candidates.map(({ id, bounds }) => ({ id, bounds }));
  if (
    !/^[a-f0-9]{64}$/.test(input.expected.photoFingerprint) ||
    !validAnalysisModelPair(input.expected.modelId, input.expected.modelRevision) ||
    ![input.expected.image.width, input.expected.image.height].every(
      (n) => Number.isInteger(n) && n > 0 && n <= 2048,
    )
  )
    throw new Error('현재 재확인 사진 또는 모델 식별 정보가 올바르지 않아요.');
  const requests = new Map(input.expected.requests.map((r) => [r.targetId, r]));
  if (
    requests.size !== input.expected.requests.length ||
    requests.size > eligibility.filter((e) => e.eligible).length
  )
    throw new Error('재확인 요청 대상이 반복되거나 자격 후보 범위를 넘었어요.');
  for (const request of requests.values()) {
    await validateTargetExistenceReceipt(request);
    if (
      !eligibility.some((e) => e.eligible && e.candidateId === request.targetId) ||
      request.photoFingerprint !== input.expected.photoFingerprint ||
      canonicalTargetValue(request.sourceImage) !== canonicalTargetValue(input.expected.image) ||
      request.modelId !== input.expected.modelId ||
      request.modelRevision !== input.expected.modelRevision ||
      request.sourceDecisionSignature !== signature ||
      canonicalTargetValue(request.boxes) !== canonicalTargetValue(boxes)
    )
      throw new Error('재확인 요청이 현재 사진·후보 판단·모델과 일치하지 않아요.');
  }
  const observations = new Map<string, TargetExistenceAnalysis>();
  for (const supplied of input.observations) {
    const id = supplied.receipt.targetId,
      request = requests.get(id);
    if (!request || observations.has(id)) throw new Error('요청하지 않았거나 반복된 대상 관측이에요.');
    observations.set(id, await validateTargetExistenceAnalysis(supplied, request));
  }
  const { understanding, decisions } = deriveReflectionRecheckCorrections(input, [...observations.values()]);
  return {
    understanding,
    record: {
      version: 1,
      ruleRevision: REFLECTION_RECHECK_RULE_REVISION,
      photoFingerprint: input.expected.photoFingerprint,
      image: { ...input.expected.image },
      sourceDecisionSignature: signature,
      requests: structuredClone([...requests.values()]),
      observations: structuredClone([...observations.values()]),
      decisions,
    },
  };
}

const isWholeDirect = (o: TargetExistenceObservation) =>
  o.objectScope === 'whole-object' &&
  ['directly-visible-surface', 'directly-visible-object'].includes(o.targetExistence);
function structureConfirmed(o: TargetExistenceObservation): boolean {
  switch (o.kind) {
    case 'mirror':
      return o.visibleStructure.reflectivePanel === 'present';
    case 'mirror_cabinet':
      return (
        o.visibleStructure.reflectivePanel === 'present' &&
        (o.visibleStructure.cabinetBody === 'present' || o.visibleStructure.cabinetDoors === 'present')
      );
    case 'glass_partition':
      return o.visibleStructure.transparentPanel === 'present';
    case 'shower':
      return o.showerStyle !== 'unknown';
    default:
      return false;
  }
}
const contains = (a: SceneCandidate['bounds'], b: SceneCandidate['bounds']) =>
  a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
const area = (b: SceneCandidate['bounds']) => (b.right - b.left) * (b.bottom - b.top);

/**
 * Pure decision layer. Production calls this only after the wrapper validates every
 * receipt against current input bytes/context and reparses the preserved raw text.
 * An offline historical-policy replay may independently validate the original
 * receipts first; that does not make them reusable under the current rule revision.
 */
export function deriveReflectionRecheckCorrections(
  input: ReflectionRecheckContext,
  validatedObservations: readonly TargetExistenceAnalysis[],
): { understanding: SceneUnderstanding; decisions: ReflectionRecheckDecision[] } {
  const eligibility = reflectionRecheckCandidates(input);
  const observations = new Map(validatedObservations.map((a) => [a.receipt.targetId, a]));
  if (
    observations.size !== validatedObservations.length ||
    validatedObservations.some(
      (a) =>
        a.observation.id !== a.receipt.targetId ||
        !eligibility.some((e) => e.candidateId === a.receipt.targetId && e.eligible),
    )
  )
    throw new Error('검증한 대상 관측 목록이 현재 재확인 후보와 달라요.');
  const understanding = structuredClone(input.appearance.understanding);
  const byId = new Map(understanding.candidates.map((c) => [c.id, c]));
  const prior = new Map(input.installation.candidates.map((c) => [c.id, c]));
  const representatives = new Map<string, string>();
  // Independent target requests have no earlier-ID canonical convention. A mutual
  // pair can express equality rather than a directed cycle, but only with whole,
  // direct mirror-family evidence, containment, and no component/user conflicts.
  for (const [id, analysis] of observations) {
    const a = analysis.observation,
      peerId = a.sameObjectAs;
    if (!peerId || representatives.has(id)) continue;
    const b = observations.get(peerId)?.observation;
    if (
      !b ||
      b.sameObjectAs !== id ||
      a.partOf !== null ||
      b.partOf !== null ||
      !isWholeDirect(a) ||
      !isWholeDirect(b) ||
      familyOf(a.kind) !== 'mirror' ||
      familyOf(b.kind) !== 'mirror' ||
      familyOf(prior.get(id)!.kind) !== 'mirror' ||
      familyOf(prior.get(peerId)!.kind) !== 'mirror' ||
      a.visibleStructure.reflectivePanel !== 'present' ||
      b.visibleStructure.reflectivePanel !== 'present' ||
      [...observations.values()].some(
        (x) =>
          x.observation.id !== id &&
          x.observation.id !== peerId &&
          [id, peerId].includes(x.observation.sameObjectAs ?? ''),
      )
    )
      continue;
    const left = byId.get(id)!,
      right = byId.get(peerId)!;
    if (!contains(left.bounds, right.bounds) && !contains(right.bounds, left.bounds)) continue;
    const qualified = [id, peerId].filter((key) => structureConfirmed(observations.get(key)!.observation));
    if (!qualified.length) continue;
    const strength = (key: string) => {
      const o = observations.get(key)!.observation;
      return (
        Number(o.kind === 'mirror_cabinet' && structureConfirmed(o)) * 3 +
        Number(o.visibleStructure.cabinetBody === 'present') +
        Number(o.visibleStructure.cabinetDoors === 'present')
      );
    };
    qualified.sort(
      (x, y) =>
        strength(y) - strength(x) ||
        area(byId.get(y)!.bounds) - area(byId.get(x)!.bounds) ||
        understanding.candidates.findIndex((c) => c.id === x) -
          understanding.candidates.findIndex((c) => c.id === y),
    );
    representatives.set(id, qualified[0]);
    representatives.set(peerId, qualified[0]);
  }
  const decisions: ReflectionRecheckDecision[] = eligibility.map((entry) => {
    const candidate = byId.get(entry.candidateId)!;
    const result: ReflectionRecheckDecision = {
      ...structuredClone(entry),
      status: entry.eligible ? 'missing' : 'not-eligible',
      priorKind: prior.get(candidate.id)!.kind,
      originalKind: candidate.kind,
      effectiveKind: candidate.kind,
      originalReflection: candidate.reflection,
      effectiveReflection: candidate.reflection,
    };
    if (!entry.eligible) return result;
    const analysis = observations.get(candidate.id);
    if (!analysis) {
      result.reasonCodes.push('missing-observation');
      result.reasons.push('같은 입력의 대상 재확인 관측이 없어 원래 결과를 보존했어요.');
      return result;
    }
    result.observationRawTextSha256 = analysis.rawTextSha256;
    const observed = analysis.observation;
    const hold = (code: string, reason: string) => {
      result.status = 'held';
      result.reasonCodes.push(code);
      result.reasons.push(reason);
      return result;
    };
    if (!isWholeDirect(observed) || familyOf(observed.kind) !== familyOf(prior.get(candidate.id)!.kind))
      return hold(
        'not-direct-whole-mirror',
        '새 관측이 원 계열의 직접 보이는 전체 대상을 확인하지 않아 원래 결과를 보존했어요.',
      );
    const canonicalId = representatives.get(candidate.id);
    if (observed.partOf !== null || (observed.sameObjectAs !== null && !canonicalId))
      return hold(
        'target-duplicate-or-component',
        '동일 물체·부품 참조를 별도 동등집합으로 확인하지 못해 독립 실물로 복구하지 않았어요.',
      );
    if (canonicalId && canonicalId !== candidate.id) {
      result.canonicalId = canonicalId;
      const message = `${candidate.id}와 ${canonicalId}를 직접 보이는 같은 거울 계열로 상호 관측했고 포함 영역을 확인했어요. 구조 근거가 있는 ${canonicalId}를 대표로 사용하며 이 원후보는 중복 배치를 보류해요.`;
      candidate.validation = {
        status: 'needs-review',
        issues: [...(candidate.validation?.issues ?? []), { code: 'target-same-object-duplicate', message }],
      };
      return hold('target-same-object-duplicate', message);
    }
    if (!structureConfirmed(observed)) {
      const code =
        familyOf(observed.kind) === 'mirror'
          ? observed.visibleStructure.reflectivePanel !== 'present'
            ? 'reflective-panel-unconfirmed'
            : 'mirror-cabinet-structure-unconfirmed'
          : observed.kind === 'glass_partition'
            ? 'transparent-panel-unconfirmed'
            : 'shower-structure-unconfirmed';
      return hold(code, '새 대상 관측의 구체적 구조 근거가 부족해 종류나 실물 여부를 교정하지 않았어요.');
    }
    if (canonicalId) result.canonicalId = canonicalId;
    const kind: SceneCandidate['kind'] =
      observed.kind === 'mirror_cabinet'
        ? 'mirrorCabinet'
        : observed.kind === 'glass_partition'
          ? 'glassPartition'
          : observed.kind === 'shower'
            ? 'shower'
            : candidate.kind === 'mirrorCabinet'
              ? 'mirrorCabinet'
              : 'mirror';
    if (candidate.kind !== kind) {
      candidate.kind = kind;
      candidate.provenance = { ...candidate.provenance, kind: 'model' };
      result.reasonCodes.push(
        kind === 'mirrorCabinet' ? 'mirror-cabinet-subtype-restored' : 'target-kind-confirmed',
      );
    }
    candidate.reflection = 'physical';
    result.effectiveKind = candidate.kind;
    result.effectiveReflection = 'physical';
    result.status = 'applied';
    result.reasonCodes.push('direct-mirror-conflict-rechecked');
    result.reasons.push(
      '같은 사진의 별도 대상 관측이 직접 보이는 전체 대상과 구조를 확인해 종류·실물 여부를 교정했어요. 원문·영역·다른 필드는 보존했어요.',
    );
    return result;
  });
  return { understanding, decisions };
}
