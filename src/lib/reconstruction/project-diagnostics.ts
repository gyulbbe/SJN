import { getRepositoryUserId } from '../repositories';
import { analysisCacheAllowed } from './analysis-cache-policy';
import type { ProjectDocument } from '../types';
import type { RoomDefinition } from '../room-types';
import type { LabTraceReport } from './lab-candidate-trace';
import { labCandidateTraces } from './lab-candidate-trace';
import {
  createDiagnosticRun,
  buildDiagnosticSummary,
  diagnosticValue,
  ReconstructionDiagnosticError,
} from './lab-diagnostics';
import { saveDiagnosticArchive, type DiagnosticArchiveEntry } from './lab-diagnostic-storage';
import type { ReconstructionQualityEvidence, ReconstructionAnalysisProfile } from './quality-contract';

export type ProjectDiagnosticCapture = Partial<LabTraceReport> & {
  quality?: ReconstructionQualityEvidence;
};
export async function withProjectAnalysisDiagnostics(
  file: File,
  room: RoomDefinition,
  profile: ReconstructionAnalysisProfile,
  signal: AbortSignal | undefined,
  execute: (
    capture: ProjectDiagnosticCapture,
    diagnostic: ReturnType<typeof createDiagnosticRun>,
  ) => Promise<ProjectDocument>,
  onDiagnostic?: (entry: DiagnosticArchiveEntry) => void,
) {
  const diagnosticUserId = getRepositoryUserId();
  const runId = crypto.randomUUID(),
    startedAt = new Date().toISOString();
  const diagnostic = createDiagnosticRun(
    runId,
    profile,
    { name: file.name, bytes: file.size, mime: file.type },
    startedAt,
  );
  diagnostic.checkpoint('room', {
    ...room,
    measurementSource: 'user-input-or-default-not-photo-measurement',
  });
  const capture: ProjectDiagnosticCapture = {};
  try {
    const project = await execute(capture, diagnostic);
    if (signal?.aborted) throw new DOMException('사진 분석을 취소했어요.', 'AbortError');
    const comparison = project.shared.comparison;
    if (!comparison?.review) throw new Error('재구성한 Before를 찾지 못했어요.');
    if (comparison.review.analysisSummary) comparison.review.analysisSummary.runId = runId;
    const traceInput = {
      runId,
      review: comparison.review,
      fixtures: comparison.before.fixtures,
      rawReview: capture.rawReview,
      rawSegmentationCandidates: capture.rawSegmentationCandidates,
      pipeline: capture.pipeline,
    };
    const candidateTraces = labCandidateTraces(traceInput);
    const summary = buildDiagnosticSummary(traceInput);
    // Report purpose is project preparation; this does not assert the repository transaction succeeded.
    const projectAnalysis = {
      scope: 'project-prepared-save-transaction-is-separate',
      profile,
      projectId: project.id,
      room,
      ...traceInput,
      candidateTraces,
      summary,
      quality: capture.quality,
      runLog: diagnostic.finish('complete'),
    };
    const entry: DiagnosticArchiveEntry = {
      schemaVersion: 1,
      runId,
      startedAt,
      status: 'complete',
      input: projectAnalysis.runLog.input,
      engine: profile,
      projectAnalysis: diagnosticValue(projectAnalysis) as Record<string, unknown>,
    };
    onDiagnostic?.(entry);
    if (!analysisCacheAllowed(signal)) return project;
    const status = await saveDiagnosticArchive(entry, diagnosticUserId);
    if (!status.stored)
      comparison.review.warnings.push('작업은 유지했지만 진단 기록을 보관하지 못했어요: ' + status.reason);
    return project;
  } catch (error) {
    const runLog = diagnostic.finish(
      signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' : 'failed',
      error,
    );
    const failure = new ReconstructionDiagnosticError(error, runLog);
    const entry: DiagnosticArchiveEntry = {
      schemaVersion: 1,
      runId,
      startedAt,
      status: runLog.status,
      input: runLog.input,
      engine: profile,
      failure: failure.diagnostics,
    };
    failure.diagnostics.logStorage = !analysisCacheAllowed(signal)
      ? { stored: false, reason: '관리자 편집의 진단은 현재 실행 메모리에만 보관해요.' }
      : await saveDiagnosticArchive(entry, diagnosticUserId);
    onDiagnostic?.(entry);
    throw failure;
  }
}
