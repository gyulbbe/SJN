import { candidateBoxIoU, type CandidateResolution } from './candidate-resolution';
import type { SceneCandidate, SceneRelation } from './pipeline-contract';
import { inferToiletLidState } from './toilet-observations';
import type { ReconstructionCandidate, ReconstructionStandardOptions } from './types';

export type CandidateToiletLidPolicy = 'legacy-placement-coupled' | 'independent-semantic-v1';
/** Shared by strict placement, estimated placement and explicit replay callers. */
export const DEFAULT_CANDIDATE_TOILET_LID_POLICY: CandidateToiletLidPolicy = 'independent-semantic-v1';
export type CandidateToiletLidDiagnostic = {
  revision: 'candidate-toilet-lid-v1';
  candidateId: string;
  candidateContext: string;
  status: 'observed' | 'unobserved' | 'excluded';
  semanticCandidateId?: string;
  intersectionOverUnion?: number;
  semanticContext?: string;
  observed?: { value: 'open'; source: 'inferred'; basis: 'connected-toilet-lid-bowl' };
  reasons: string[];
};

function context(candidate: SceneCandidate) {
  return JSON.stringify({
    id: candidate.id,
    kind: candidate.kind,
    bounds: {
      left: candidate.bounds.left,
      top: candidate.bounds.top,
      right: candidate.bounds.right,
      bottom: candidate.bounds.bottom,
    },
    reflection: candidate.reflection,
    validation: candidate.validation
      ? {
          status: candidate.validation.status,
          issues: candidate.validation.issues.map((issue) => ({ code: issue.code, message: issue.message })),
        }
      : undefined,
  });
}

/** Recomputes from this invocation's original semantic candidates; never consumes a saved ID-only decision. */
export function inspectCandidateToiletLid(input: {
  candidate: SceneCandidate;
  canonicalCandidate: SceneCandidate | undefined;
  baselineCandidates: readonly ReconstructionCandidate[];
  resolution: CandidateResolution;
  relations: readonly SceneRelation[];
}): CandidateToiletLidDiagnostic {
  const { candidate, canonicalCandidate, baselineCandidates, resolution, relations } = input;
  const result: CandidateToiletLidDiagnostic = {
    revision: 'candidate-toilet-lid-v1',
    candidateId: candidate.id,
    candidateContext: context(candidate),
    status: 'unobserved',
    reasons: [],
  };
  if (!canonicalCandidate || context(canonicalCandidate) !== context(candidate)) {
    result.status = 'excluded';
    result.reasons.push(
      '현재 후보의 종류·영역·실물 여부가 엄격 경로 입력과 달라 과거 뚜껑 근거를 재사용하지 않았어요.',
    );
    return result;
  }
  const resolved = resolution.entries.find((entry) => entry.candidateId === candidate.id);
  if (
    candidate.kind !== 'toilet' ||
    candidate.reflection !== 'physical' ||
    candidate.validation?.issues.length ||
    resolved?.disposition !== 'fixture' ||
    relations.some((relation) => relation.relation === 'reflectionOf' && relation.frontId === candidate.id)
  ) {
    result.status = 'excluded';
    result.reasons.push('종류·실물·중복 또는 입력 검증 보호 조건에 따라 자동 뚜껑 근거를 적용하지 않았어요.');
    return result;
  }
  // Same all-candidate argmax and stable tie order as candidate-pipeline. Do not prefilter by kind/validity.
  const matched = baselineCandidates
    .map((entry) => ({ entry, overlap: candidateBoxIoU(entry.bounds, candidate.bounds) }))
    .sort((a, b) => b.overlap - a.overlap)[0];
  const evidence = matched && matched.overlap >= 0.25 ? matched : undefined;
  if (!evidence) {
    result.reasons.push('기존 픽셀 분류와 대응하는 영역이 없어요.');
    return result;
  }
  result.semanticCandidateId = evidence.entry.id;
  result.intersectionOverUnion = evidence.overlap;
  result.semanticContext = JSON.stringify({
    id: evidence.entry.id,
    kind: evidence.entry.kind,
    bounds: evidence.entry.bounds,
    source: evidence.entry.source,
    reflectionOf: evidence.entry.reflectionOf,
    requiresReview: evidence.entry.requiresReview,
    status: evidence.entry.status,
    evidence: evidence.entry.evidence,
  });
  if (evidence.entry.kind !== candidate.kind || evidence.overlap < 0.5) {
    result.reasons.push('최고 일치 영역의 종류 또는 기존 IoU 0.5 조건이 뚜껑 근거를 지지하지 않아요.');
    return result;
  }
  const observed = inferToiletLidState(evidence.entry);
  if (!observed) {
    result.reasons.push('원본 픽셀 관측의 출처·검토 상태 또는 연결된 뚜껑/볼 부위 조건을 충족하지 않았어요.');
    return result;
  }
  result.status = 'observed';
  result.observed = structuredClone(observed);
  result.reasons.push('위치의 확정 여부와 별개로 기존 연결 부위 근거에서 열린 뚜껑을 추정했어요.');
  return result;
}

/** The latest validated explicit lid map wins. User placement/kind provenance is not an appearance veto. */
export function resolveCandidateToiletLid(
  diagnostic: CandidateToiletLidDiagnostic,
  userValue: 'open' | 'closed' | undefined,
  previous: Pick<ReconstructionStandardOptions, 'toiletLidState' | 'provenance'> | undefined,
  fallback: 'open' | 'closed' | undefined = 'closed',
): { value: 'open' | 'closed' | undefined; source: 'user' | 'inferred' | 'default' } {
  if (userValue !== undefined) return { value: userValue, source: 'user' };
  if (previous?.provenance?.toiletLidState === 'user' && previous.toiletLidState !== undefined)
    return { value: previous.toiletLidState, source: 'user' };
  if (diagnostic.status === 'observed' && diagnostic.observed)
    return { value: diagnostic.observed.value, source: diagnostic.observed.source };
  return { value: fallback, source: 'default' };
}
