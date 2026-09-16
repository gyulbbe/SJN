import type { ReconstructionLabReport, ReconstructionLabResult } from './lab';
import type { ProjectDocument } from '../types';
import type { ProjectResourceBundle, Repositories } from '../repositories/contracts';
import { getRepositories } from '../repositories';
import { projectReferences, StorageConflictError } from '../repositories/references';
import { storedProjectV3Schema } from '../supabase/validation';

/** Captured before the lab disposes its memory stores. Kept out of report JSON and cache keys. */
export type LabProjectBundle = ProjectResourceBundle & {
  version: 1;
  runId: string;
  inputFingerprint: string;
};

const abortError = () => new DOMException('프로젝트 저장을 취소했어요.', 'AbortError');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Explicit local action only. Does not analyze, render, upload, or mutate the completed lab result. */
export async function saveLabResultAsProject(
  result: Pick<ReconstructionLabResult, 'projectBundle' | 'report'>,
  options: { name?: string; repositories?: Repositories; signal?: AbortSignal } = {},
): Promise<ProjectDocument> {
  if (options.signal?.aborted) throw abortError();
  if (!result.projectBundle)
    throw new Error(
      '이전 보고서에는 편집용 모형 자료가 없어요. 저장할 교정 결과를 다시 생성해 주세요. AI 재분석은 필요하지 않아요.',
    );
  const { projectBundle: bundle, report } = structuredClone(result);
  const comparison = bundle!.document.shared.comparison;
  if (
    bundle!.version !== 1 ||
    report.schemaVersion !== 1 ||
    bundle!.runId !== report.runId ||
    bundle!.inputFingerprint !== report.inputFingerprint ||
    !comparison ||
    !same(comparison.room, report.room) ||
    !same(comparison.before.fixtures, report.fixtures) ||
    (!!report.renderView && !same(bundle!.document.roomView, report.renderView)) ||
    !same(comparison.review, report.review)
  )
    throw new Error(
      '완료된 결과와 편집용 모형 자료가 달라요. 원래 결과를 보존하고 저장할 결과를 다시 선택해 주세요.',
    );
  const document = bundle!.document;
  if (
    document.shared.baseline.fixtures.length ||
    document.shared.baseline.surfaces.some((surface) => surface.materialVersionId) ||
    document.designs.length !== 1 ||
    document.designs.some(
      (design) =>
        design.scene.fixtures.length || design.scene.surfaces.some((surface) => surface.materialVersionId),
    )
  )
    throw new Error('빈 After를 가진 완료 결과만 새 프로젝트로 만들 수 있어요.');
  const name = options.name?.trim();
  if (options.name !== undefined && (!name || name.length > 200))
    throw new Error('프로젝트 이름은 1~200자로 입력해 주세요.');
  if (name) document.name = name;
  const reportJson = JSON.stringify(report);
  if (new Blob([reportJson]).size > 10 * 1024 * 1024)
    throw new Error('보정 보고서가 너무 커요. 원래 결과는 그대로 보존했어요.');
  const sourceReferences = projectReferences(document);
  comparison.labSource = {
    version: 1,
    runId: report.runId,
    inputFingerprint: bundle!.inputFingerprint,
    reportJson,
    assetIds: sourceReferences.assets,
    materialVersionIds: sourceReferences.versions,
  };
  if (new Blob([JSON.stringify(document)]).size > 20 * 1024 * 1024)
    throw new Error('프로젝트 문서가 너무 커요. 원래 결과는 그대로 보존했어요.');
  storedProjectV3Schema.parse(document);
  const repositories = options.repositories ?? getRepositories();
  if (repositories.mode !== 'local' || !repositories.projects.createWithResources)
    throw new Error(
      '사진 테스트 결과는 로컬 저장 모드에서만 프로젝트로 만들 수 있어요. 서버로 전송하지 않았어요.',
    );
  if (options.signal?.aborted) throw abortError();
  try {
    return await repositories.projects.createWithResources(bundle!, { signal: options.signal });
  } catch (error) {
    // A double click or a retry after an uncertain commit must reuse the already-created project.
    // Never overwrite later edits to that project or consume a different run with the same ID.
    if (error instanceof StorageConflictError) {
      const existing = await repositories.projects.load(document.id).catch(() => undefined);
      const source = existing?.shared.comparison?.labSource;
      if (existing && source?.runId === report.runId && source.inputFingerprint === report.inputFingerprint)
        return existing;
    }
    throw error;
  }
}

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
