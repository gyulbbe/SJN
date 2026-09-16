import type { SceneCandidate } from './pipeline-contract';
import type { ReconstructionStandardOptions, ShowerVariant } from './types';
import {
  adoptedShowerObservationDecision,
  SHOWER_DETAIL_ADOPTION_REVISION,
  showerObservationDecision,
  type ShowerObservation,
} from './shower-observation';
import {
  parseShowerInstallationObservation,
  SHOWER_INSTALLATION_DECISION_REVISION,
  type ShowerInstallationDecision,
  type ShowerInstallationObservation,
} from './shower-installation-observation';
import { canonicalTargetValue } from './target-existence-observation';

export type ObservedShowerModelDecision = {
  version: 1;
  revision: typeof SHOWER_DETAIL_ADOPTION_REVISION;
  candidateId: string;
  action: 'apply' | 'hold' | 'unchanged';
  variant?: ShowerVariant;
  variantSource?: 'model' | 'inferred';
  /** Model composition does not silently rewrite which part the detail box describes. */
  projectionPart?: ShowerObservation['observedPart'];
  requiresReview: boolean;
  reasons: string[];
  detail: ShowerObservation;
  installation?: {
    observation: ShowerInstallationObservation;
    inputSha256: string;
    rawTextSha256: string;
    policyRevision: string;
  };
  scopeComparison?: 'same-assembly' | 'different-described-scope';
};

/**
 * Consume a receipt/raw-validated installation decision from quality-core. This does not
 * replace that async byte/receipt validation, call a provider or modify either observation.
 */
export function decideObservedShowerModel(input: {
  candidate: SceneCandidate;
  detail: ShowerObservation;
  installation?: ShowerInstallationDecision;
  protectedByUser?: boolean;
  existingOptions?: ReconstructionStandardOptions;
}): ObservedShowerModelDecision {
  const { candidate, detail, installation } = input;
  const result: ObservedShowerModelDecision = {
    version: 1,
    revision: SHOWER_DETAIL_ADOPTION_REVISION,
    candidateId: candidate.id,
    action: 'unchanged',
    requiresReview: true,
    reasons: [],
    detail: structuredClone(detail),
  };
  const unchanged = (reason: string) => ({ ...result, action: 'unchanged' as const, reasons: [reason] });
  if (
    input.protectedByUser ||
    Object.values(candidate.provenance ?? {}).includes('user') ||
    Object.values(input.existingOptions?.provenance ?? {}).includes('user')
  )
    return unchanged('사용자가 확인한 샤워 형태·규격·배치를 보존했어요.');
  if (
    candidate.kind !== 'shower' ||
    candidate.reflection !== 'physical' ||
    candidate.validation?.issues.length ||
    detail.id !== candidate.id
  )
    return unchanged('현재 실물 샤워 후보와 세부 관측이 일치하지 않아 모형을 바꾸지 않았어요.');

  const legacy = adoptedShowerObservationDecision(detail);
  const apply = (variant: ShowerVariant, reason: string, inferred = false) => ({
    ...result,
    action: 'apply' as const,
    variant,
    variantSource: inferred ? ('inferred' as const) : ('model' as const),
    projectionPart: detail.observedPart,
    reasons: [
      reason,
      ...(result.scopeComparison === 'different-described-scope'
        ? [
            '세부 관측의 부위와 독립 관측의 연결 장치 범위가 달라요. 원래 부위 투영을 유지하며 전체 장치 경계로 바꾸지 않았어요.',
          ]
        : []),
    ],
  });
  if (installation) {
    const receipt = installation.analysis.receipt;
    if (
      installation.candidateId !== candidate.id ||
      receipt.targetId !== candidate.id ||
      receipt.candidateSignature !== canonicalTargetValue(candidate) ||
      canonicalTargetValue(installation.before.candidate) !== canonicalTargetValue(candidate) ||
      canonicalTargetValue(receipt.targetBounds) !== canonicalTargetValue(candidate.bounds) ||
      installation.policyRevision !== SHOWER_INSTALLATION_DECISION_REVISION
    )
      return unchanged('독립 설치 관측의 후보·영역·정책이 현재 후보와 달라 새 모형을 적용하지 않았어요.');
    let observed: ShowerInstallationObservation;
    try {
      observed = parseShowerInstallationObservation(installation.analysis.rawText);
      if (canonicalTargetValue(observed) !== canonicalTargetValue(installation.analysis.observation))
        return unchanged('보존한 설치 원문과 관측 필드가 달라 새 모형을 적용하지 않았어요.');
    } catch {
      return unchanged('설치 원문을 같은 관측 계약으로 읽지 못해 새 모형을 적용하지 않았어요.');
    }
    result.installation = {
      observation: structuredClone(observed),
      inputSha256: receipt.inputSha256,
      rawTextSha256: installation.analysis.rawTextSha256,
      policyRevision: installation.policyRevision,
    };
    if (observed.scope === 'connected-assembly')
      result.scopeComparison =
        detail.observedPart === 'whole-kit' ? 'same-assembly' : 'different-described-scope';
    if (installation.action === 'hold')
      return {
        ...result,
        action: 'hold',
        reasons: ['미설치 구조의 독립 보류 결정을 유지했어요. 원후보와 두 관측은 보존해요.'],
      };
    const hardware = observed.visibleHardware;
    const installed =
      observed.view === 'direct' &&
      observed.installationState === 'installed-shower-hardware' &&
      hardware.recognizableSprayHeadBody === 'present' &&
      hardware.unfinishedPipeEnd === 'absent' &&
      hardware.looseServiceLoop === 'absent';
    const checked = showerObservationDecision(detail).applicable;
    if (
      installed &&
      checked &&
      observed.scope === 'connected-assembly' &&
      detail.style === 'hand-spray' &&
      ['handset', 'whole-kit'].includes(detail.observedPart) &&
      detail.visibleParts.handheldHead === 'present' &&
      detail.visibleParts.hose === 'present' &&
      detail.visibleParts.overheadHead === 'absent' &&
      detail.visibleParts.verticalRail === 'absent' &&
      hardware.headMountOrSupport === 'present' &&
      hardware.flexibleWaterHose === 'present' &&
      hardware.finishedUserControl === 'present'
    )
      return apply(
        'handheld-wall',
        '두 관측에서 연결된 헤드·호스·완성 조작부를 확인해 레일 없는 벽걸이 샤워 구성으로 연결했어요. 규격은 편집 가능한 기본값이며 실측이 아니에요.',
        true,
      );
    if (
      installed &&
      checked &&
      ['connected-assembly', 'separate-component'].includes(observed.scope) &&
      detail.style === 'overhead-set' &&
      detail.observedPart === 'overhead-head' &&
      detail.visibleParts.overheadHead === 'present' &&
      detail.visibleParts.handheldHead === 'absent' &&
      detail.visibleParts.hose === 'absent' &&
      detail.visibleParts.verticalRail === 'absent' &&
      hardware.flexibleWaterHose === 'absent' &&
      hardware.finishedUserControl === 'absent'
    )
      return apply(
        'overhead-head',
        '두 관측의 고정 헤드와 호스·손잡이 부재에 맞춰 헤드·연결관만 표현했어요. 레일·호스·조작부를 추가하지 않았고 규격은 실측이 아니에요.',
        true,
      );
    // Ambiguous full/crop structure must not turn a new ordinary assembly into a compact kit.
    if (
      legacy.action === 'apply' &&
      (observed.view !== 'direct' ||
        observed.scope === 'uncertain' ||
        observed.scope === 'multiple-targets' ||
        observed.installationState !== 'installed-shower-hardware' ||
        hardware.finishedUserControl === 'present' ||
        hardware.finishedUserControl === 'uncertain')
    )
      return unchanged(
        '독립 관측과 합의된 샤워 구성 범위가 없어 소형 또는 연결형 모형을 새로 선택하지 않았어요.',
      );
  }
  if (legacy.action === 'apply' && detail.style !== 'unknown')
    return apply(detail.style, legacy.reasons.join(' '));
  return { ...result, action: legacy.action, reasons: [...legacy.reasons] };
}
