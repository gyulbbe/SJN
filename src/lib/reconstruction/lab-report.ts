import type { ReconstructionLabReport } from './lab';

export type LabExecution = {
  status: 'placed' | 'partial' | 'review-required' | 'no-observations';
  counts: { rawCandidates: number; organizedFixtures: number; placedFixtures: number; needsReview: number };
  reasons: string[];
};
export const labExecutionLabels: Record<LabExecution['status'], string> = {
  placed: '분석 완료 및 배치 완료',
  partial: '분석 완료, 일부 배치 확인 필요',
  'review-required': '분석 완료, 전체 배치 확인 필요',
  'no-observations': '분석 완료, 배치 대상 설비 없음 · 확인 필요',
};
/** A zero placement target count does not imply the model observed zero candidates. */
export function labExecutionLabel(execution: LabExecution): string {
  if (execution.status !== 'no-observations') return labExecutionLabels[execution.status];
  return execution.counts.rawCandidates > 0
    ? '분석 완료, 관측 후보 전부 배치 대상에서 제외됨 · 확인 필요'
    : '분석 완료, 원출력 후보 없음 · 확인 필요';
}
/** Older reports remain readable; never label a held or empty scene as successful reconstruction. */
export function labExecution(
  report: Pick<ReconstructionLabReport, 'pipeline' | 'review' | 'fixtures' | 'rawSegmentationCandidates'>,
): LabExecution {
  const pipeline = report.pipeline;
  const resolution = pipeline?.resolution;
  const excluded = new Set(
    resolution?.entries
      .filter((x) => ['duplicate', 'component', 'reflection'].includes(x.disposition))
      .map((x) => x.candidateId) ?? [],
  );
  const organizedIds = pipeline
    ? pipeline.understanding.candidates.filter((x) => !excluded.has(x.id)).map((x) => x.id)
    : report.review.candidates.filter((x) => x.status !== 'ignored').map((x) => x.id);
  const placedIds = new Set(
    report.review.candidates
      .filter((x) => x.status === 'placed' && report.fixtures.some((f) => f.id === x.fixtureId))
      .map((x) => x.id),
  );
  const needsReview = organizedIds.filter((id) => !placedIds.has(id)).length;
  const placedFixtures = report.fixtures.length;
  const rawCandidates = pipeline
    ? (pipeline.automaticUnderstanding?.validation?.rawCandidateCount ??
      pipeline.automaticUnderstanding?.candidates.length ??
      pipeline.understanding.candidates.length)
    : (report.rawSegmentationCandidates?.length ?? report.review.candidates.length);
  const organizedFixtures = resolution?.organizedCount ?? organizedIds.length;
  return {
    status:
      organizedFixtures === 0
        ? 'no-observations'
        : needsReview
          ? placedFixtures
            ? 'partial'
            : 'review-required'
          : 'placed',
    counts: { rawCandidates, organizedFixtures, placedFixtures, needsReview },
    reasons: [
      ...new Set([
        ...(pipeline?.camera.status === 'held' ? pipeline.camera.reasons : []),
        ...report.review.candidates
          .filter((x) => !excluded.has(x.id) && !placedIds.has(x.id))
          .flatMap((x) => (x.warning ? [x.warning] : [])),
      ]),
    ],
  };
}
