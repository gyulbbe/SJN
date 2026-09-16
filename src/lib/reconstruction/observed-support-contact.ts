import type { Point } from '../types';
import type { SceneCandidate, SceneRelation } from './pipeline-contract';
import type { ReconstructionCandidate, ReconstructionReview } from './types';
import { inspectObservedInstallation, type ObservedPlacementDiagnostic } from './observed-placement';

export type ObservedSupportContactContext = {
  image: { width: number; height: number };
  candidateInputFingerprint: string;
  observationInputFingerprint: string;
  relations: readonly SceneRelation[];
};
export type ObservedSupportContact = {
  candidateId: string;
  baselineCandidateId: string;
  baselineBounds: ReconstructionCandidate['bounds'];
  point: Point;
  kind: 'floor-contact';
  source: 'geometry';
  pointRole: 'observed-pedestal-bottom';
  inputFingerprint: string;
  image: { width: number; height: number };
  evidence: {
    source: 'deeplab';
    matchMode: 'bounds-overlap' | 'pedestal-bowl-part';
    intersectionOverUnion: number;
    candidateCoverage?: number;
    pedestalSupport: NonNullable<ReconstructionCandidate['evidence']['pedestalSupport']>;
    positionBorrowed: false;
    interpretation: 'support-contour-bottom-not-footprint-centre';
  };
  reasons: string[];
};
export type ObservedSupportContactInspection = {
  contact?: ObservedSupportContact;
  diagnostic: {
    candidateId: string;
    baselineCandidateId?: string;
    status: 'accepted' | 'held';
    code: 'accepted' | 'identity-unverified' | 'not-pedestal' | 'existing-anchor' | 'relation-conflict' |
      'installation-rejected' | 'support-invalid' | 'candidate-cropped' | 'contact-invalid' | 'contact-occluded';
    message: string;
    details?: string[];
    installationCheck?: ObservedPlacementDiagnostic;
  };
};

const validBounds = (b: ReconstructionCandidate['bounds']) =>
  [b.left, b.top, b.right, b.bottom].every(Number.isFinite) &&
  b.left >= 0 && b.top >= 0 && b.right <= 1 && b.bottom <= 1 && b.left < b.right && b.top < b.bottom;
const contains = (bounds: ReconstructionCandidate['bounds'], point: Point) =>
  validBounds(bounds) && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;

/**
 * Reuses a source-photo contour, never a room coordinate or camera-projection success.
 * The stored pedestal ratios describe the same connected basin component. They remain
 * semantic evidence, not a guarantee that the lowest silhouette is the physical contact.
 */
export function inspectObservedSupportContact(
  candidate: SceneCandidate,
  eligibleCandidates: readonly SceneCandidate[],
  baseline: ReconstructionReview,
  context?: ObservedSupportContactContext,
): ObservedSupportContactInspection {
  const diagnostic: ObservedSupportContactInspection['diagnostic'] = {
    candidateId: candidate.id, status: 'held', code: 'identity-unverified', message: '',
  };
  const held = (code: typeof diagnostic.code, message: string, details?: string[]): ObservedSupportContactInspection => ({
    diagnostic: { ...diagnostic, code, message, ...(details ? { details } : {}) },
  });
  if (!context || !context.image || !/^[0-9a-f]{64}$/.test(context.candidateInputFingerprint) ||
      context.candidateInputFingerprint !== context.observationInputFingerprint ||
      ![context.image.width, context.image.height].every((v) => Number.isInteger(v) && v > 0) ||
      !Array.isArray(context.relations))
    return held('identity-unverified', '후보와 지지대 관측이 같은 사진이라는 해시·영상 크기·관계 근거가 필요해요.');
  if (candidate.anchor)
    return held('existing-anchor', '명시적인 후보 기준점이 있어 독립 지지대 하단으로 덮어쓰지 않았어요.');
  if (candidate.kind !== 'basin' || !['pedestal', 'unknown'].includes(candidate.basinStyle))
    return held('not-pedestal', '기둥형 세면대의 독립 지지대 하단에만 사용하는 검사예요.');
  if (!validBounds(candidate.bounds))
    return held('contact-invalid', '후보 사진 영역이 올바르지 않아 지지대 끝점을 연결하지 않았어요.');
  if (context.relations.some((r) => r.frontId === candidate.id && ['reflectionOf', 'partOf'].includes(r.relation)))
    return held('relation-conflict', '반사 또는 다른 제품의 부품으로 연결된 후보는 독립 기둥 접점을 사용하지 않아요.');
  const installation = inspectObservedInstallation(candidate, eligibleCandidates, baseline);
  diagnostic.installationCheck = installation.diagnostic;
  if (!installation.installation || !installation.baselineEvidence)
    return held('installation-rejected', installation.diagnostic.message, installation.diagnostic.details);
  diagnostic.baselineCandidateId = installation.baselineEvidence.candidateId;
  if (installation.installation.mode !== 'floor' || installation.installation.basinVariant !== 'pedestal')
    return held('not-pedestal', '같은 제품의 바닥 설치·기둥형 지지 근거가 일치하지 않아요.');
  const observed = baseline.candidates.find((c) => c.id === installation.baselineEvidence!.candidateId)!;
  const support = observed.evidence.pedestalSupport;
  // Apply continuity checks even for full-bounds matches, which do not use the bowl-part exception.
  if (!support || ![support.stemWidthRatio, support.stemHeightRatio, support.coverage, observed.evidence.meanMargin].every(Number.isFinite) ||
      support.stemWidthRatio <= 0 || support.stemWidthRatio > .6 || support.stemHeightRatio < .3 ||
      support.stemHeightRatio > 1 || support.coverage < .7 || support.coverage > 1 ||
      !Number.isInteger(observed.evidence.semanticPixels) || observed.evidence.semanticPixels <= 0 ||
      !validBounds(observed.bounds))
    return held('support-invalid', '같은 세면볼에서 이어지는 좁고 긴 지지대의 유효한 연속 관측이 부족해요.');
  const point = observed.foot;
  if (!point || ![point.x, point.y].every(Number.isFinite))
    return held('contact-invalid', '지지대 하단의 유효한 사진 좌표가 없어요.');
  const pixelY = 1 / context.image.height;
  if ([candidate.bounds, observed.bounds].some((b) => b.bottom >= .995 || b.left <= .005 || b.right >= .995) ||
      point.x <= .005 || point.x >= .995 || point.y >= .995)
    return held('candidate-cropped', '후보 또는 지지대 관측이 사진 하단·좌우에서 잘려 온전한 지지대 끝점으로 사용하지 않았어요.');
  const observedWidth = observed.bounds.right - observed.bounds.left;
  const observedHeight = observed.bounds.bottom - observed.bounds.top;
  if (![point.x, point.y].every(Number.isFinite) || !contains(observed.bounds, point) ||
      Math.abs(point.y - observed.bounds.bottom) > pixelY ||
      Math.abs(point.x - (observed.bounds.left + observed.bounds.right) / 2) > observedWidth * .3 ||
      candidate.bounds.top > observed.bounds.top + observedHeight * .45 || point.y + pixelY < candidate.bounds.bottom)
    return held('contact-invalid', '끝점이 같은 기둥의 하단·중심 지지 범위 또는 관측된 세면볼 위치와 맞지 않아요.');
  const otherClaims = eligibleCandidates.filter((other) => other.id !== candidate.id && other.reflection !== 'reflected');
  const overlaps = otherClaims.filter((other) => contains(other.bounds, point));
  const otherPixels = baseline.candidates.filter((other) =>
    other.id !== observed.id && other.source === 'deeplab' && !other.reflectionOf && other.status !== 'ignored' &&
    !other.requiresReview && Number.isFinite(other.evidence.meanMargin) && other.evidence.meanMargin >= 1.5 &&
    contains(other.bounds, point));
  if (overlaps.length || otherPixels.length)
    return held('contact-occluded', '지지대 끝점이 다른 제품 관측과 겹쳐 같은 기둥의 온전한 하단인지 확정하지 않았어요.',
      [...overlaps.map((c) => c.id), ...otherPixels.map((c) => c.id)]);
  const obstructed = context.relations.filter((r) => r.behindId === candidate.id && ['occludes', 'visibleThrough', 'uncertain'].includes(r.relation))
    .filter((r) => {
      const foreground = eligibleCandidates.find((c) => c.id === r.frontId);
      // Unknown foreground extent cannot establish an unobstructed support endpoint.
      if (!foreground || !validBounds(foreground.bounds)) return true;
      return point.x >= foreground.bounds.left && point.x <= foreground.bounds.right &&
        foreground.bounds.bottom >= candidate.bounds.bottom && foreground.bounds.top <= point.y;
    });
  if (obstructed.length)
    return held('contact-occluded', '앞쪽 물체 또는 유리와 지지대 하단의 가림 관계가 남아 접점을 보류했어요.', obstructed.map((r) => r.frontId));
  const reasons = [
    '같은 세면볼과 연결된 DeepLab 기둥 관측의 하단 윤곽점을 사용했어요. 볼 bbox 하단이나 기존 방 좌표는 재사용하지 않았어요.',
    '이 점은 지지대 윤곽 하단의 추정이며 실제 접촉면 중심·제품 중심·실측 접점이 아니에요. 모형 기준점으로 해석하는 가정과 배치 검증은 별도예요.',
    '사진 안의 같은 제품·지지 연속성·가림 근거로 검사했으며 바닥 투영 성공을 접점 정확도 근거로 사용하지 않았어요.',
  ];
  return {
    contact: { candidateId: candidate.id, baselineCandidateId: observed.id, baselineBounds: { ...observed.bounds },
      point: { ...point }, kind: 'floor-contact', source: 'geometry', pointRole: 'observed-pedestal-bottom',
      inputFingerprint: context.candidateInputFingerprint, image: { ...context.image },
      evidence: { source: 'deeplab', matchMode: installation.baselineEvidence.matchMode,
        intersectionOverUnion: installation.baselineEvidence.intersectionOverUnion,
        candidateCoverage: installation.baselineEvidence.candidateCoverage, pedestalSupport: { ...support },
        positionBorrowed: false, interpretation: 'support-contour-bottom-not-footprint-centre' }, reasons },
    diagnostic: { ...diagnostic, status: 'accepted', code: 'accepted', message: reasons[0], details: reasons.slice(1) },
  };
}