import type { ReconstructionLabReport } from './lab';
import type { ProjectDocument } from '../types';
import type { ProjectResourceBundle } from '../repositories/contracts';

/** Captured before the lab disposes its memory stores. Kept out of report JSON and cache keys. */
export type LabProjectBundle = ProjectResourceBundle & {
  version: 1;
  runId: string;
  inputFingerprint: string;
};

export function readLabProjectReport(project: ProjectDocument): ReconstructionLabReport | undefined {
  const source = project.shared.comparison?.labSource;
  if (!source) return undefined;
  const report: ReconstructionLabReport = JSON.parse(source.reportJson);
  if (
    report.schemaVersion !== 1 ||
    report.runId !== source.runId ||
    report.inputFingerprint !== source.inputFingerprint
  )
    throw new Error('저장된 사진 테스트의 원본 기록이 프로젝트와 달라요.');
  return report;
}
