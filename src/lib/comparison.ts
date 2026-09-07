import { createRoomSurfaces } from './room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK } from './types';
import type {
  BeforeFrame,
  ComparisonState,
  DesignDocument,
  DesignFrame,
  LegacyProjectDocument,
  ProjectDocument,
  ProjectFrame,
  ProjectInput,
  Scene,
  WorkspaceSnapshot,
} from './types';

export type EditingSide = 'before' | 'after';
export const MAX_DESIGNS = 5;
/** Read-only compatibility ceiling for documents created before the five-design limit. */
export const LEGACY_MAX_DESIGNS = 10;
export const MAX_COMPARISON_DESIGNS = 5;
export const HISTORY_LIMIT = 50;
export const DESIGN_LIMIT_MESSAGE =
  '프로젝트당 시안은 최대 5개까지 만들 수 있습니다. 기존 시안을 삭제한 뒤 다시 시도해 주세요.';
export const COMPARISON_LIMIT_MESSAGE =
  '한 번에 최대 5개 시안을 비교할 수 있습니다. 선택한 시안 하나를 해제해 주세요.';

/** Stable IDs keep repeated read-only legacy loads identical before their first v3 save. */
function legacyId(text: string): string {
  const chunks = [2166136261, 3339675911, 2654435761, 2246822519]
    .map((seed) => {
      let hash = seed;
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
      return (hash >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
  return `${chunks.slice(0, 8)}-${chunks.slice(8, 12)}-4${chunks.slice(13, 16)}-8${chunks.slice(17, 20)}-${chunks.slice(20)}`;
}
export function sameSceneFrame(a: Scene, b: Scene): boolean {
  const room = (scene: Scene) =>
    scene.room && [
      scene.room.kind,
      scene.room.version,
      scene.room.widthMm,
      scene.room.depthMm,
      scene.room.heightMm,
    ];
  return (
    a.imageWidth === b.imageWidth &&
    a.imageHeight === b.imageHeight &&
    JSON.stringify(room(a)) === JSON.stringify(room(b))
  );
}
export function blankSceneFrom(source: Scene, stableNamespace?: string): Scene {
  const next = structuredClone(source);
  delete next.backgroundAssetId;
  next.surfaces = source.room ? createRoomSurfaces(source.room, source.imageWidth / source.imageHeight) : [];
  if (stableNamespace)
    next.surfaces.forEach((surface) => {
      surface.id = legacyId(stableNamespace + '/' + surface.roomFace);
    });
  next.fixtures = [];
  next.protection = EMPTY_MASK();
  next.color = { ...DEFAULT_COLOR };
  return next;
}
export function getActiveDesign(
  project: ProjectDocument,
  id = project.activeDesignId,
): DesignDocument | undefined {
  return id ? project.designs.find((design) => design.id === id) : undefined;
}
export function getActiveScene(project: ProjectDocument): Scene {
  return getActiveDesign(project)?.scene ?? project.shared.baseline;
}
export function getActiveQuote(project: ProjectDocument) {
  return getActiveDesign(project)?.quote;
}
export function getComparison(project: ProjectInput) {
  return project.schemaVersion === 3 ? project.shared.comparison : project.comparison;
}
export function getEditingScene(project: ProjectDocument, side: EditingSide): Scene {
  return side === 'before' && project.shared.comparison
    ? project.shared.comparison.before
    : getActiveScene(project);
}
export function captureBeforeFrame(project: ProjectDocument): BeforeFrame {
  return {
    baseline: project.shared.baseline,
    ...(project.shared.comparison ? { comparison: project.shared.comparison } : {}),
  };
}
export function captureDesignFrame(design: DesignDocument): DesignFrame {
  return {
    scene: design.scene,
    ...(design.quote ? { quote: design.quote } : {}),
    ...(design.materialUsage ? { materialUsage: design.materialUsage } : {}),
  };
}
/** Kept for callers explicitly reading old combined project records. */
export function captureProjectFrame(project: ProjectInput): ProjectFrame {
  const scene = project.schemaVersion === 3 ? getActiveScene(project) : project.scene;
  const comparison = getComparison(project);
  return { ...scene, ...(comparison ? { comparison } : {}) };
}
export function restoreProjectFrame(
  project: LegacyProjectDocument,
  frame: ProjectFrame,
): LegacyProjectDocument {
  const { comparison, ...scene } = frame;
  const next = { ...project, scene };
  delete next.comparison;
  if (comparison) next.comparison = comparison;
  return next;
}
function legacyCompatible(project: LegacyProjectDocument, frame: ProjectFrame): boolean {
  if (!sameSceneFrame(project.scene, frame) || frame.originalAssetId !== project.scene.originalAssetId)
    return false;
  const a = project.comparison,
    b = frame.comparison;
  return (
    (!a && !b) ||
    (!!a &&
      !!b &&
      a.cameraVersion === b.cameraVersion &&
      a.aspect === b.aspect &&
      a.referenceOriginalAssetId === b.referenceOriginalAssetId &&
      a.referencePreviewAssetId === b.referencePreviewAssetId &&
      sameSceneFrame(a.before, b.before))
  );
}
function contiguousLegacy(project: LegacyProjectDocument, direction: 'past' | 'future'): ProjectFrame[] {
  const frames = direction === 'past' ? [...project.history.past].reverse() : project.history.future;
  const retained: ProjectFrame[] = [];
  for (const frame of frames) {
    if (!legacyCompatible(project, frame)) break;
    retained.push(frame);
  }
  return direction === 'past' ? retained.reverse() : retained;
}
/** Conversion is pure, deterministic and never saves, mutates, or discards the legacy records. */
export function normalizeProjectDocument(project: ProjectInput): ProjectDocument {
  if (project.schemaVersion === 3) return project;
  if (project.schemaVersion !== 1 && project.schemaVersion !== 2)
    throw new Error('지원하지 않는 프로젝트 형식이에요.');
  const baseline = blankSceneFrom(project.scene, project.id + '/baseline');
  const id = legacyId(project.id + '/design-a');
  const toDesignFrame = (frame: ProjectFrame): DesignFrame => {
    const { comparison: _comparison, ...scene } = structuredClone(frame);
    void _comparison;
    return { scene, ...(project.quote ? { quote: structuredClone(project.quote) } : {}) };
  };
  const designHistory = (direction: 'past' | 'future') => {
    const frames = contiguousLegacy(project, direction);
    const ordered = direction === 'past' ? [...frames].reverse() : frames;
    const states: DesignFrame[] = [];
    let last = JSON.stringify({ scene: project.scene, ...(project.quote ? { quote: project.quote } : {}) });
    for (const legacy of ordered) {
      const frame = toDesignFrame(legacy),
        key = JSON.stringify(frame);
      if (key === last) continue;
      states.push(frame);
      last = key;
    }
    return direction === 'past' ? states.reverse() : states;
  };
  const afterHistory = { past: designHistory('past'), future: designHistory('future') };
  const sharedHistory = (direction: 'past' | 'future') => {
    const frames = contiguousLegacy(project, direction);
    const ordered = direction === 'past' ? [...frames].reverse() : frames;
    const states: BeforeFrame[] = [];
    let previous = JSON.stringify(project.comparison);
    for (const frame of ordered) {
      const key = JSON.stringify(frame.comparison);
      if (key === previous) continue;
      states.push({
        baseline: structuredClone(baseline),
        ...(frame.comparison ? { comparison: structuredClone(frame.comparison) } : {}),
      });
      previous = key;
    }
    return direction === 'past' ? states.reverse() : states;
  };
  return {
    id: project.id,
    ownerId: project.ownerId,
    name: project.name,
    schemaVersion: 3,
    editRevision: project.editRevision,
    storageRevision: project.storageRevision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    ...(project.thumbnailAssetId ? { thumbnailAssetId: project.thumbnailAssetId } : {}),
    shared: {
      baseline,
      ...(project.comparison ? { comparison: structuredClone(project.comparison) } : {}),
      revision: 0,
      beforeHistory: { past: sharedHistory('past'), future: sharedHistory('future') },
      ...(project.history.past.length || project.history.future.length
        ? { legacyHistory: structuredClone(project.history) }
        : {}),
    },
    designs: [
      {
        id,
        name: '시안 A',
        scene: structuredClone(project.scene),
        ...(project.quote ? { quote: structuredClone(project.quote) } : {}),
        revision: 0,
        history: afterHistory,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        ...(project.thumbnailAssetId ? { thumbnailAssetId: project.thumbnailAssetId } : {}),
      },
    ],
    activeDesignId: id,
    comparisonDesignIds: [],
    viewport: structuredClone(project.viewport),
    roomHistory: {},
  };
}
export function captureWorkspace(project: ProjectDocument): WorkspaceSnapshot {
  return structuredClone({
    shared: project.shared,
    designs: project.designs,
    activeDesignId: project.activeDesignId,
    comparisonDesignIds: project.comparisonDesignIds,
    viewport: project.viewport,
  });
}
export function projectWorkspaces(project: ProjectDocument, includeHistory = true): WorkspaceSnapshot[] {
  return [
    project,
    ...(includeHistory
      ? [project.roomHistory.past, project.roomHistory.future].filter(
          (item): item is WorkspaceSnapshot => !!item,
        )
      : []),
  ];
}
export function projectComparisons(project: ProjectInput, includeHistory = true): ComparisonState[] {
  if (project.schemaVersion !== 3)
    return [
      project.comparison,
      ...(includeHistory
        ? [...project.history.past, ...project.history.future].map((frame) => frame.comparison)
        : []),
    ].filter((item): item is ComparisonState => !!item);
  return projectWorkspaces(project, includeHistory).flatMap(({ shared }) =>
    [
      shared.comparison,
      ...(includeHistory
        ? [
            ...shared.beforeHistory.past,
            ...shared.beforeHistory.future,
            ...(shared.legacyHistory?.past ?? []),
            ...(shared.legacyHistory?.future ?? []),
          ].map((frame) => frame.comparison)
        : []),
    ].filter((item): item is ComparisonState => !!item),
  );
}
export function projectScenes(project: ProjectInput, includeHistory = true): Scene[] {
  if (project.schemaVersion !== 3)
    return [
      project.scene,
      ...(project.comparison ? [project.comparison.before] : []),
      ...(includeHistory
        ? [...project.history.past, ...project.history.future].flatMap((frame) => [
            frame,
            ...(frame.comparison ? [frame.comparison.before] : []),
          ])
        : []),
    ];
  return projectWorkspaces(project, includeHistory).flatMap(({ shared, designs }) => [
    shared.baseline,
    ...(shared.comparison ? [shared.comparison.before] : []),
    ...designs.flatMap((design) => [
      design.scene,
      ...(includeHistory
        ? [...design.history.past, ...design.history.future].map((frame) => frame.scene)
        : []),
    ]),
    ...(includeHistory
      ? [...shared.beforeHistory.past, ...shared.beforeHistory.future].flatMap((frame) => [
          frame.baseline,
          ...(frame.comparison ? [frame.comparison.before] : []),
        ])
      : []),
    ...(includeHistory
      ? [...(shared.legacyHistory?.past ?? []), ...(shared.legacyHistory?.future ?? [])].flatMap((frame) => [
          frame,
          ...(frame.comparison ? [frame.comparison.before] : []),
        ])
      : []),
  ]);
}
export function comparisonFrameError(after: Scene, comparison: ComparisonState): string | null {
  if (
    !after.room ||
    !comparison.before.room ||
    !sameSceneFrame(after, comparison.before) ||
    JSON.stringify([
      after.room.kind,
      after.room.version,
      after.room.widthMm,
      after.room.depthMm,
      after.room.heightMm,
    ]) !==
      JSON.stringify([
        comparison.room.kind,
        comparison.room.version,
        comparison.room.widthMm,
        comparison.room.depthMm,
        comparison.room.heightMm,
      ])
  )
    return 'Before와 After의 공간 치수가 같아야 해요.';
  if (comparison.cameraVersion !== 1 || !Number.isFinite(comparison.aspect) || comparison.aspect <= 0)
    return '지원하지 않는 비교 카메라 설정이에요.';
  if (Math.abs(after.imageWidth / after.imageHeight - comparison.aspect) > 0.000001)
    return 'Before와 After의 화면 비율이 같아야 해요.';
  return null;
}
/** Structural invariants are shared by every store command and both repository implementations. */
export function projectFrameError(project: ProjectDocument, maxDesigns = MAX_DESIGNS): string | null {
  if (project.roomHistory.past && project.roomHistory.future)
    return '공간 변경 기록은 실행 취소 또는 다시 실행 하나만 유지할 수 있어요.';
  for (const scene of projectScenes(project)) {
    const ids = [
      ...scene.surfaces.map((surface) => surface.id),
      ...scene.fixtures.map((fixture) => fixture.id),
    ];
    if (new Set(ids).size !== ids.length) return '같은 장면 안에 면이나 제품 ID가 중복되었어요.';
  }
  for (const workspace of projectWorkspaces(project)) {
    if (workspace.designs.length > maxDesigns) return DESIGN_LIMIT_MESSAGE;
    const ids = new Set(workspace.designs.map((design) => design.id));
    if (ids.size !== workspace.designs.length) return '시안 ID가 중복되었어요.';
    if (
      workspace.designs.length
        ? !workspace.activeDesignId || !ids.has(workspace.activeDesignId)
        : workspace.activeDesignId !== null
    )
      return '활성 시안을 확인해 주세요.';
    if (workspace.comparisonDesignIds.length > MAX_COMPARISON_DESIGNS) return COMPARISON_LIMIT_MESSAGE;
    if (
      new Set(workspace.comparisonDesignIds).size !== workspace.comparisonDesignIds.length ||
      workspace.comparisonDesignIds.some((id) => !ids.has(id))
    )
      return '비교할 시안을 확인해 주세요.';
    const shared = workspace.shared;
    if (shared.comparison) {
      const error = comparisonFrameError(shared.baseline, shared.comparison);
      if (error) return error;
    }
    if (
      shared.beforeHistory.past.length > HISTORY_LIMIT ||
      shared.beforeHistory.future.length > HISTORY_LIMIT
    )
      return 'Before 이력은 최근 50개까지 저장할 수 있어요.';
    for (const frame of [...shared.beforeHistory.past, ...shared.beforeHistory.future]) {
      if (!sameSceneFrame(frame.baseline, shared.baseline)) return 'Before 이력의 공간 기준이 달라요.';
      if (frame.comparison) {
        const error = comparisonFrameError(frame.baseline, frame.comparison);
        if (error) return error;
      }
    }
    for (const design of workspace.designs) {
      if (design.history.past.length > HISTORY_LIMIT || design.history.future.length > HISTORY_LIMIT)
        return '시안 이력은 최근 50개까지 저장할 수 있어요.';
      for (const frame of [design, ...design.history.past, ...design.history.future]) {
        if (!sameSceneFrame(frame.scene, shared.baseline))
          return '모든 시안은 같은 공간 치수와 화면 비율을 사용해야 해요.';
      }
    }
  }
  return null;
}

/** Existing oversized workspaces may be edited, reduced, or restored, never expanded with new IDs. */
export function projectWriteError(project: ProjectDocument, previous?: ProjectDocument): string | null {
  const error = projectFrameError(project, LEGACY_MAX_DESIGNS);
  if (error) return error;
  const previousGroups = previous
    ? projectWorkspaces(previous).map((workspace) => new Set(workspace.designs.map((design) => design.id)))
    : [];
  for (const workspace of projectWorkspaces(project)) {
    if (workspace.designs.length <= MAX_DESIGNS) continue;
    if (!previousGroups.some((ids) => workspace.designs.every((design) => ids.has(design.id))))
      return DESIGN_LIMIT_MESSAGE;
  }
  return null;
}
