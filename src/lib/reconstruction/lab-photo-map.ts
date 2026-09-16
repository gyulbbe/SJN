import type { SceneUnderstanding } from './pipeline-contract';
import type { ReconstructionReview } from './types';

type PhotoMapReport = {
  pipeline?: { model?: { understanding: SceneUnderstanding }; automaticUnderstanding?: SceneUnderstanding };
  rawReview?: Pick<ReconstructionReview, 'candidates'>;
  review: Pick<ReconstructionReview, 'candidates'>;
};
import { reconstructionLabels } from './types';

export type CandidatePhotoItem = {
  id: string;
  label: string;
  bounds: { left: number; top: number; right: number; bottom: number };
};

export function validPhotoBounds(bounds: CandidatePhotoItem['bounds']): boolean {
  return (
    Object.values(bounds).every(Number.isFinite) &&
    bounds.left >= 0 &&
    bounds.top >= 0 &&
    bounds.right <= 1 &&
    bounds.bottom <= 1 &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top
  );
}

/** Original observations only: a corrected/user-added full-frame placeholder is not photo evidence. */
export function labPhotoCandidates(report: PhotoMapReport): CandidatePhotoItem[] {
  const source = report.pipeline
    ? ((report.pipeline.model?.understanding ?? report.pipeline.automaticUnderstanding)?.candidates ?? [])
    : (report.rawReview ?? report.review).candidates.filter((candidate) => candidate.source !== 'user');
  const seen = new Set<string>();
  return source.flatMap((candidate) => {
    if (seen.has(candidate.id) || !validPhotoBounds(candidate.bounds)) return [];
    // Historical automatic snapshots can lack the raw model. Never upgrade user placeholders to observations.
    if ('provenance' in candidate && candidate.provenance?.kind === 'user') return [];
    seen.add(candidate.id);
    return [
      {
        id: candidate.id,
        label: candidate.kind === 'unknown' ? '종류 확인 필요' : reconstructionLabels[candidate.kind],
        bounds: { ...candidate.bounds },
      },
    ];
  });
}
