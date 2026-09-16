import type { SceneCandidate, SceneUnderstanding } from './pipeline-contract';
import type { ParsedFixtureAppearance } from './fixture-appearance-observation';
import type { ReflectionRecheckEvidence } from './reflection-recheck';
import type { DividerApplication } from './divider-application';
import type { TargetExistenceObservation } from './target-existence-observation';
import { canonicalTargetValue } from './target-existence-observation';

export const CLASSIFICATION_RESOLUTION_REVISION = 'observed-family-conflict-v1' as const;
export type ClassificationDecision = {
  candidateId: string;
  action:
    | 'unchanged'
    | 'protected'
    | 'independent-confirmation'
    | 'retain-prior-hypothesis'
    | 'independent-negative';
  priorKind: SceneCandidate['kind'];
  appearanceKind: SceneCandidate['kind'];
  effectiveKind: SceneCandidate['kind'];
  priorReflection: SceneCandidate['reflection'];
  effectiveReflection: SceneCandidate['reflection'];
  needsReview: boolean;
  reasonCodes: string[];
  reasons: string[];
  targetRawTextSha256?: string;
};
export type ClassificationResolution = {
  revision: typeof CLASSIFICATION_RESOLUTION_REVISION;
  decisions: ClassificationDecision[];
};
const family = (kind: SceneCandidate['kind']) =>
  ['basin', 'vanity'].includes(kind)
    ? 'washbasin'
    : ['mirror', 'mirrorCabinet'].includes(kind)
      ? 'mirror'
      : kind;
const targetKind = (kind: TargetExistenceObservation['kind']): SceneCandidate['kind'] =>
  (
    ({
      wall_basin: 'basin',
      pedestal_basin: 'basin',
      enclosed_vanity: 'vanity',
      open_counter_basin: 'vanity',
      mirror: 'mirror',
      mirror_cabinet: 'mirrorCabinet',
      wall_cabinet: 'wallCabinet',
      glass_partition: 'glassPartition',
      opaque_low_partition: 'lowPartition',
      shower: 'shower',
      wall_shelf: 'wallShelf',
      window: 'window',
      toilet: 'toilet',
      bathtub: 'bath',
      door: 'door',
      door_frame_only: 'unknown',
      unknown: 'unknown',
    }) as const
  )[kind];
function positiveStructure(o: TargetExistenceObservation): boolean {
  const s = o.visibleStructure;
  // Semantic consistency is stricter than the historical JSON grammar. Never parse note prose.
  if (o.kind !== 'shower' && o.showerStyle !== 'unknown') return false;
  switch (o.kind) {
    case 'mirror':
      return s.reflectivePanel === 'present';
    case 'mirror_cabinet':
      return s.reflectivePanel === 'present' && (s.cabinetBody === 'present' || s.cabinetDoors === 'present');
    case 'wall_cabinet':
      return s.reflectivePanel === 'absent' && s.cabinetBody === 'present' && s.cabinetDoors === 'present';
    case 'glass_partition':
      return s.transparentPanel === 'present';
    case 'wall_basin':
      return s.basinBowl === 'present' && o.lowerSupport === 'wall-hung-open-below';
    case 'pedestal_basin':
      return s.basinBowl === 'present' && s.pedestalToFloor === 'present';
    case 'enclosed_vanity':
      return (
        s.basinBowl === 'present' &&
        s.cabinetBody === 'present' &&
        s.cabinetDoors === 'present' &&
        o.lowerSupport === 'enclosed-base'
      );
    case 'open_counter_basin':
      return (
        s.basinBowl === 'present' &&
        s.cabinetBody === 'absent' &&
        s.cabinetDoors === 'absent' &&
        o.lowerSupport === 'counter-with-open-below'
      );
    case 'toilet':
      return s.toiletBowl === 'present';
    // A style enum alone does not prove a shower; installedness is evaluated downstream.
    // The current target contract has no positive structural fields for shelves/windows/doors/baths.
    default:
      return false;
  }
}
/**
 * Resolve already validated observations, not model text or new detector answers.
 * An unresolved coarse-family substitution retains the earlier model hypothesis for
 * explicitly estimated placement. It is NOT an independently confirmed detection.
 * Downstream installedness, physical support, duplicate and collision gates still apply.
 */
export function resolveClassificationConflicts(input: {
  appearance: ParsedFixtureAppearance;
  effective: SceneUnderstanding;
  reflection?: ReflectionRecheckEvidence;
  divider?: DividerApplication;
  protectedCandidateIds: ReadonlySet<string>;
}): {
  understanding: SceneUnderstanding;
  appearance: ParsedFixtureAppearance;
  record: ClassificationResolution;
} {
  const understanding = structuredClone(input.effective);
  const appearance = structuredClone(input.appearance);
  const record: ClassificationResolution = { revision: CLASSIFICATION_RESOLUTION_REVISION, decisions: [] };
  const ids = new Set(understanding.candidates.map((c) => c.id));
  if (
    ids.size !== understanding.candidates.length ||
    appearance.decisions.length !== ids.size ||
    new Set(appearance.decisions.map((d) => d.candidateId)).size !== ids.size
  )
    throw new Error('분류 충돌 검증의 후보 ID가 원관측과 달라요.');
  for (const d of appearance.decisions) {
    const index = understanding.candidates.findIndex((c) => c.id === d.candidateId);
    const current = understanding.candidates[index];
    const prior = d.original;
    if (
      !current ||
      prior.id !== current.id ||
      d.effective.id !== current.id ||
      canonicalTargetValue(prior.bounds) !== canonicalTargetValue(current.bounds) ||
      canonicalTargetValue(prior.bounds) !== canonicalTargetValue(d.effective.bounds)
    )
      throw new Error('분류 충돌 검증의 원후보 영역이 달라요.');
    const decision: ClassificationDecision = {
      candidateId: current.id,
      action: 'unchanged',
      priorKind: prior.kind,
      appearanceKind: d.effective.kind,
      effectiveKind: current.kind,
      priorReflection: prior.reflection,
      effectiveReflection: current.reflection,
      needsReview: false,
      reasonCodes: [],
      reasons: [],
    };
    record.decisions.push(decision);
    const reason = (code: string, text: string) => {
      decision.reasonCodes.push(code);
      decision.reasons.push(text);
    };
    if (
      input.protectedCandidateIds.has(current.id) ||
      [prior, current, d.effective].some((c) => Object.values(c.provenance ?? {}).includes('user'))
    ) {
      decision.action = 'protected';
      reason('user-controlled', '사용자가 확인한 종류·설치·배치를 보존해요.');
      continue;
    }
    // Existing validation/alias gates are authoritative; a prior must not resurrect an excluded duplicate.
    const recheck = input.reflection?.decisions.find((r) => r.candidateId === current.id);
    if (
      prior.validation?.issues.length ||
      current.validation?.issues.length ||
      d.status === 'duplicate' ||
      (recheck?.canonicalId && recheck.canonicalId !== current.id) ||
      input.effective.relations.some(
        (r) =>
          (r.frontId === current.id || r.behindId === current.id) &&
          ['reflectionOf', 'partOf'].includes(r.relation),
      )
    ) {
      reason('existing-validation-or-relation', '기존 반사·중복·부품·검증 제약을 유지해요.');
      continue;
    }
    if (input.divider?.decisions.some((r) => r.candidateId === current.id && r.status === 'applied')) {
      reason('independent-material-applied', '검증된 커튼 재질 적용을 보존해요.');
      continue;
    }
    if (
      recheck?.status === 'applied' &&
      family(prior.kind) === family(current.kind) &&
      family(prior.kind) !== family(d.effective.kind)
    ) {
      // The older recheck changed only kind/reflection. Discard the rejected family's
      // mounting, erased anchor and renderer options before the next observation stage.
      const restored = structuredClone(prior);
      restored.kind = current.kind;
      restored.reflection = current.reflection;
      restored.provenance = { ...restored.provenance, kind: 'model' };
      understanding.candidates[index] = restored;
      appearance.understanding.candidates[
        appearance.understanding.candidates.findIndex((c) => c.id === current.id)
      ] = structuredClone(restored);
      d.effective = structuredClone(restored);
      delete appearance.modelOptions[current.id];
      decision.action = 'independent-confirmation';
      reason(
        'independent-prior-family-restored',
        '별도의 대상 관측으로 원 계열을 복구했어요. 거부된 계열의 설치 방식·기준점 삭제·모형 옵션도 함께 되돌렸어요.',
      );
      d.reasons.push(...decision.reasons);
      continue;
    }
    if (
      prior.reflection !== 'physical' ||
      prior.kind === 'unknown' ||
      (family(prior.kind) === family(current.kind) && prior.reflection === current.reflection)
    ) {
      reason('no-unresolved-family-conflict', '현재 계열·실물 판단을 유지해요.');
      continue;
    }
    // A visibly empty door frame is deliberately not represented by an invented door leaf.
    if (d.observation.kind === 'door_frame_only') {
      reason('door-frame-not-leaf', '문틀 관측만으로 문짝을 복구하지 않아요.');
      continue;
    }
    const target = input.reflection?.observations.find((t) => t.receipt.targetId === current.id);
    const o = target?.observation;
    if (target) decision.targetRawTextSha256 = target.rawTextSha256;
    const material = input.divider?.decisions.find((r) => r.candidateId === current.id)?.observation;
    const materialConflict =
      material?.context === 'physical' &&
      material.dividerMaterial === 'rigid-glass' &&
      material.support === 'frame' &&
      ['mirror', 'mirrorCabinet'].includes(current.kind);
    const directWhole =
      o &&
      ['directly-visible-object', 'directly-visible-surface'].includes(o.targetExistence) &&
      o.objectScope === 'whole-object' &&
      o.partOf === null &&
      o.sameObjectAs === null;
    if (
      directWhole &&
      targetKind(o.kind) === current.kind &&
      positiveStructure(o) &&
      !materialConflict &&
      current.reflection === 'physical'
    ) {
      decision.action = 'independent-confirmation';
      reason('independent-whole-structure', '별도 대상 관측의 직접 보이는 전체 구조가 새 종류를 뒷받침해요.');
      continue;
    }
    if (
      o &&
      o.partOf === null &&
      o.sameObjectAs === null &&
      !materialConflict &&
      ((o.targetExistence === 'only-depicted-in-reflection' && current.reflection === 'reflected') ||
        (o.targetExistence === 'not-an-identifiable-target' && current.kind === 'unknown'))
    ) {
      decision.action = 'independent-negative';
      reason(
        'independent-negative-confirmed',
        '별도 대상 관측도 반사 또는 미확인 영역으로 판단해 자동 복구하지 않아요.',
      );
      continue;
    }
    decision.action = 'retain-prior-hypothesis';
    decision.needsReview = true;
    reason(
      materialConflict
        ? 'independent-referent-conflict'
        : o
          ? 'unconfirmed-substitution'
          : 'no-independent-target',
      '종류·실물 관측이 서로 달라 원래 관측을 확인이 필요한 추정 모형으로 유지해요. 새 종류가 확정된 것은 아니에요.',
    );
    // Restore the complete pre-appearance candidate, including the original anchor/mounting.
    // Rejected category-specific options and duplicate proposals must not leak into the retained prior.
    const restored = structuredClone(prior);
    restored.uncertainty = [...new Set([...restored.uncertainty, ...decision.reasons])].slice(-6);
    understanding.candidates[index] = restored;
    const appearanceIndex = appearance.understanding.candidates.findIndex((c) => c.id === current.id);
    appearance.understanding.candidates[appearanceIndex] = structuredClone(restored);
    d.effective = structuredClone(restored);
    d.status = 'held';
    d.reasons.push(...decision.reasons);
    delete appearance.modelOptions[current.id];
    appearance.duplicates = appearance.duplicates.filter(
      (r) => r.candidateId !== current.id && r.canonicalId !== current.id,
    );
    decision.effectiveKind = restored.kind;
    decision.effectiveReflection = restored.reflection;
  }
  return { understanding, appearance, record };
}
