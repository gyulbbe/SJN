import { categoryLabels } from '../types';
import { projectComparisons, projectScenes } from '../comparison';
import type { MaterialVersion, ProjectInput, Scene } from '../types';

export function sceneReferences(scene: Scene) {
  return {
    assets: [
      scene.originalAssetId,
      scene.previewAssetId,
      scene.backgroundAssetId,
      ...scene.fixtures.map((f) => f.reconstruction?.appearanceAssetId),
    ].filter((id): id is string => !!id),
    versions: [
      ...scene.surfaces.map((s) => s.materialVersionId),
      ...scene.fixtures.map((f) => f.materialVersionId),
    ].filter((id): id is string => !!id),
  };
}

export function projectReferences(document: ProjectInput) {
  const refs = projectScenes(document).map(sceneReferences);
  const workspaces =
    document.schemaVersion === 3
      ? [document, document.roomHistory.past, document.roomHistory.future].filter((value) => !!value)
      : [];
  const designs = workspaces.flatMap((workspace) => workspace.designs);
  const usageStates = designs.flatMap((design) => [
    design.materialUsage,
    ...design.history.past.map((frame) => frame.materialUsage),
    ...design.history.future.map((frame) => frame.materialUsage),
  ]);
  const quotes =
    document.schemaVersion === 3
      ? designs.flatMap((design) => [
          design.quote,
          ...design.history.past.map((frame) => frame.quote),
          ...design.history.future.map((frame) => frame.quote),
        ])
      : [document.quote];
  return {
    assets: [
      ...new Set([
        ...refs.flatMap((r) => r.assets),
        ...projectComparisons(document).flatMap((c) => [
          c.referenceOriginalAssetId,
          c.referencePreviewAssetId,
        ]),
        ...(document.thumbnailAssetId ? [document.thumbnailAssetId] : []),
        ...designs.flatMap((design) => (design.thumbnailAssetId ? [design.thumbnailAssetId] : [])),
      ]),
    ],
    versions: [
      ...new Set([
        ...refs.flatMap((r) => r.versions),
        ...usageStates.flatMap((usage) =>
          usage
            ? [
                ...Object.values(usage.assignments).flatMap((assignment) => [
                  assignment.materialVersionId,
                  assignment.pricing.sourceVersionId,
                ]),
                ...usage.aggregateAreas.map((area) => area.materialVersionId),
              ]
            : [],
        ),
        ...quotes.flatMap(
          (quote) =>
            quote?.lines.flatMap((line) => (line.materialVersionId ? [line.materialVersionId] : [])) ?? [],
        ),
      ]),
    ],
  };
}

export function materialReferences(
  version: Pick<MaterialVersion, 'coverAssetId' | 'imageAssetIds' | 'textureAssetIds' | 'views'>,
) {
  return [
    ...new Set(
      [
        version.coverAssetId,
        ...version.imageAssetIds,
        ...version.textureAssetIds,
        ...version.views.map((v) => v.assetId),
      ].filter(Boolean),
    ),
  ];
}

export class StorageConflictError extends Error {
  constructor() {
    super('다른 창에서 저장한 변경이 있어요. 현재 작업을 보존한 뒤 새로 열어 주세요.');
    this.name = 'StorageConflictError';
  }
}

export class StorageNotFoundError extends Error {
  constructor(kind = '자료') {
    super(`${kind}를 찾을 수 없어요.`);
    this.name = 'StorageNotFoundError';
  }
}

/** Only unmodified internal cache entries are disposable; copied or edited user materials stay. */
export function isDisposableReconstructionVersion(version: MaterialVersion): boolean {
  if (
    !version.reconstruction ||
    version.reconstruction.version !== 1 ||
    version.version !== 1 ||
    version.scope !== 'personal' ||
    version.brand !== '' ||
    version.pricing ||
    !/^reconstruction-v1-[0-9a-f]{64}$/.test(version.code)
  )
    return false;
  if (version.reconstruction.kind !== version.category) return false;
  if (version.category === 'tile')
    return ['기존 바닥 타일 · 추정', '기존 벽 타일 · 추정'].includes(version.name);
  return (
    ['toilet', 'basin', 'vanity', 'bath', 'mirror', 'door', 'window'].includes(version.category) &&
    (version.name === categoryLabels[version.category] + ' · 재구성 모형' ||
      (version.category === 'vanity' && version.name === '세면대 하부장 · 재구성 모형'))
  );
}
