import { labCandidateTraces, type LabCandidateTrace } from './lab-candidate-trace';
import { runQualityPipeline } from './quality-core';
import { SHOWER_DETAIL_ADOPTION_REVISION } from './shower-observation';
import { LOCAL_QUALITY_REVISION, type ReconstructionQualityEvidence } from './quality-contract';
import type { ProductColorOverride } from './product-color';
import type { LabProjectBundle } from './lab-project';
import type { LabCorrectionSnapshot } from './lab-correction';
import {
  baselineCacheKey,
  baselineReuseCompatible,
  modelCacheKey,
  modelReuseCompatible,
  historicalCorrectionCompatible,
  sameLabInput,
  LAB_BASELINE_SETTINGS,
} from './lab-cache';
import { labExecution, type LabExecution } from './lab-report';
import { saveDiagnosticArchive, type DiagnosticStorageStatus } from './lab-diagnostic-storage';
import {
  buildDiagnosticSummary,
  createDiagnosticRun,
  ReconstructionDiagnosticError,
  type DiagnosticRun,
} from './lab-diagnostics';
import { validateUserUnderstanding } from './scene-understanding';
import {
  LAB_BASELINE_REVISION,
  LAB_BASELINE_MODEL_REVISION,
  LAB_CANDIDATE_REVISION,
  type LabEngineId,
  type LabEngineMetadata,
} from './lab-engine';
import {
  buildCandidatePipeline,
  type CandidatePipeline,
  type ManualCandidatePlacement,
} from './candidate-pipeline';
import {
  type LocalSceneAnalysis,
} from './analysis-client';
import type { SceneUnderstanding } from './pipeline-contract';
import { createReconstructionProject } from './index';
import { TEMPLATE_RENDERER_REVISION } from './templates';
import { PhotoCompositor } from '../render/compositor';
import { canvasBlob, readImageHeader } from '../images';
import { sourceRoomView, type RoomViewState } from '../room-viewer/view-state';
import { renderRoomSnapshotImage } from '../room-viewer/render-snapshot';
import { ROOM_VIEWER_RENDERER_REVISION } from '../room-viewer/render-version';
import type { Repositories } from '../repositories/contracts';
import type { AssetRecord, FixtureInstance, Material, MaterialVersion } from '../types';
import type { RoomDefinition } from '../room-types';
import type { ReconstructionReview } from './types';

export type ReconstructionLabReport = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  algorithm: {
    reconstructionReviewVersion: 1 | 2;
    templateRendererRevision: number;
    /** Absent for legacy front output and reports saved before output-version diagnostics. */
    roomViewerRendererRevision?: string;
  };
  engine: string;
  engineMetadata: LabEngineMetadata;
  inputFingerprint?: string;
  rawReview?: ReconstructionReview;
  rawSegmentationCandidates?: ReconstructionReview['candidates'];
  pipeline?: CandidatePipeline & {
    model: LocalSceneAnalysis;
    modelReused: boolean;
    modelSourceRunId?: string;
    quality?: ReconstructionQualityEvidence;
  };
  correctionOfRunId?: string;
  /** Exact UI input for this completed result; absent on older/programmatic reports. */
  correctionSnapshot?: LabCorrectionSnapshot;
  execution?: LabExecution;
  /** Read-only per-candidate stages derived from this completed result; absent in older reports. */
  candidateTraces?: LabCandidateTrace[];
  runLog?: DiagnosticRun;
  logStorage?: DiagnosticStorageStatus;
  diagnosticSummary?: ReturnType<typeof buildDiagnosticSummary>;
  reuse?: {
    baseline: {
      reused: boolean;
      sourceRunId?: string;
      cacheKey: string;
      sourceDurationMs?: number;
      compatibility?: 'current' | 'historical-correction';
      sourceEngineMetadata?: LabEngineMetadata;
    };
    model: {
      reused: boolean;
      sourceRunId?: string;
      cacheKey?: string;
      sourceDurationMs?: number;
      compatibility?: 'current' | 'historical-correction';
      sourceEngineMetadata?: LabEngineMetadata;
    };
    newStages: string[];
  };
  timing?: {
    totalMs: number;
    baselineAnalysisMs?: number;
    additionalModelMs: number;
    placementAndPreparationMs?: number;
    renderMs: number;
    scope: string;
  };
  input: {
    name: string;
    width: number;
    height: number;
    bytes: number;
    previewWidth: number;
    previewHeight: number;
    analysisWidth?: number;
    analysisHeight?: number;
  };
  room: RoomDefinition;
  creationMs: number;
  renderMs: number;
  totalMs: number;
  stages: { message: string; elapsedMs: number }[];
  review: ReconstructionReview;
  fixtures: FixtureInstance[];
  output: { width: number; height: number; mime: 'image/png'; renderer?: 'legacy-front' | 'room-view' };
  /** Exact common Before/After view used by this output and saved project, absent on older reports. */
  renderView?: RoomViewState;
  measurement: {
    browser: string;
    hardwareConcurrency?: number;
    mainPageJsHeapPeakBytes?: number;
    mainPageJsHeapEndBytes?: number;
    memoryScope: string;
    segmentation: string;
    cancellation: string;
  };
};
export type ReconstructionLabResult = {
  /** Complete editable resources for an explicit local project action; never serialized in report JSON. */
  projectBundle?: LabProjectBundle;
  /** Oriented upload preview; the report records the original input's dimensions and byte count. */
  original: Blob;
  before: Blob;
  report: ReconstructionLabReport;
};

const cancelled = () => new DOMException('사진 분석 테스트를 취소했어요.', 'AbortError');
function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw cancelled();
}
/** No IndexedDB, shared catalog, BroadcastChannel or server adapter is instantiated. */
export function memoryRepositories() {
  const assets = new Map<string, AssetRecord>();
  const versions = new Map<string, MaterialVersion>();
  const materials = new Map<string, Material>();
  let disposed = false;
  const assertOpen = () => {
    if (disposed) throw new Error('정리된 사진 테스트 자료에는 접근할 수 없어요.');
  };
  const forbidden = async (): Promise<never> => {
    throw new Error('사진 테스트에서는 프로젝트 저장이나 기존 자재 변경을 수행하지 않아요.');
  };
  const repositories: Repositories = {
    // The common interface has two production modes; every implementation below is memory-only.
    mode: 'local',
    projects: {
      list: forbidden,
      load: forbidden,
      create: forbidden,
      save: forbidden,
      duplicate: forbidden,
      remove: forbidden,
    },
    assets: {
      async put(asset) {
        assertOpen();
        assets.set(asset.id, structuredClone(asset));
      },
      async get(id) {
        assertOpen();
        const asset = assets.get(id);
        if (!asset) throw new Error('사진 테스트의 임시 이미지를 찾지 못했어요.');
        return structuredClone(asset);
      },
      removeUnused: forbidden,
    },
    materials: {
      async create(input) {
        assertOpen();
        const id = crypto.randomUUID(),
          materialId = crypto.randomUUID(),
          now = new Date().toISOString();
        const version: MaterialVersion = {
          ...structuredClone(input),
          id,
          materialId,
          version: 1,
          createdAt: now,
        };
        versions.set(id, version);
        materials.set(materialId, {
          id: materialId,
          ownerId: 'lab-memory',
          currentVersionId: id,
          active: true,
          scope: input.scope,
          updatedAt: now,
        });
        return structuredClone(version);
      },
      async list() {
        assertOpen();
        return [...materials.values()].map((material) => ({
          material: structuredClone(material),
          version: structuredClone(versions.get(material.currentVersionId)!),
        }));
      },
      async getVersion(id) {
        assertOpen();
        const version = versions.get(id);
        if (!version) throw new Error('사진 테스트의 임시 자재를 찾지 못했어요.');
        return structuredClone(version);
      },
      update: forbidden,
      setActive: forbidden,
    },
  };
  return {
    repositories,
    snapshot() {
      assertOpen();
      return {
        assets: structuredClone([...assets.values()]),
        versions: structuredClone([...versions.values()]),
      };
    },
    dispose() {
      disposed = true;
      assets.clear();
      versions.clear();
      materials.clear();
    },
  };
}

/** Run the existing browser DeepLab reconstruction with disposable resources, without saving a project. */
export async function runReconstructionLabCase(
  file: File,
  room: RoomDefinition,
  options: {
    signal?: AbortSignal;
    onStage?: (message: string) => void;
    engine?: LabEngineId;
    /** Explicit historical ablation, never an automatic fallback for local quality failures. */
    candidateProfile?: 'legacy-inventory' | 'local-quality-v1';
    /** Explicit experiment; stored corrections retain their original policy. */
    reconstructionPolicy?: 'strict' | 'visible-relations';
    reuseReport?: ReconstructionLabReport;
    understandingOverride?: SceneUnderstanding;
    manualPlacements?: Record<string, ManualCandidatePlacement>;
    toiletLidStates?: Record<string, 'open' | 'closed'>;
    productColors?: Record<string, ProductColorOverride>;
    pedestalShapes?: Record<string, 'round' | 'rectangular'>;
    expectedModelRevision?: string;
  } = {},
): Promise<ReconstructionLabResult> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const signal = controller.signal;
  const memory = memoryRepositories();
  let renderer: PhotoCompositor | undefined;
  let analysisSize: { width: number; height: number } | undefined;
  let rawReview: ReconstructionReview | undefined;
  let rawSegmentationCandidates = options.reuseReport?.rawSegmentationCandidates;
  let pipeline: ReconstructionLabReport['pipeline'];
  let baselineAnalysisMs: number | undefined;
  let additionalModelMs = 0;
  const engineId = options.engine ?? 'baseline';
  const estimatedLayout = !!options.understandingOverride
    ? options.reuseReport?.pipeline?.quality?.placementPolicy === 'visible-relation-estimate'
    : options.reconstructionPolicy === 'visible-relations';
  if (estimatedLayout && (engineId !== 'candidate' || options.candidateProfile === 'legacy-inventory'))
    throw new Error('형태·관계 개선 실험은 정밀 후보 분석에서 선택해 주세요.');
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const diagnostic = createDiagnosticRun(
    runId,
    engineId,
    { name: file.name, bytes: file.size, mime: file.type },
    startedAt,
  );
  diagnostic.checkpoint('room', room);
  const stages: ReconstructionLabReport['stages'] = [];
  let peak: number | undefined;
  const heap = () => {
    const value = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
      ?.usedJSHeapSize;
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      peak = Math.max(peak ?? 0, value);
      return value;
    }
  };
  heap();
  const timer = setInterval(heap, 250);
  const onStage = (message: string) => {
    if (signal.aborted) return;
    diagnostic.progress(message);
    stages.push({ message, elapsedMs: performance.now() - start });
    options.onStage?.(message);
  };
  try {
    checkAbort(signal);
    if (
      engineId === 'baseline' &&
      (options.understandingOverride ||
        options.manualPlacements ||
        options.toiletLidStates ||
        options.productColors ||
        options.pedestalShapes)
    )
      throw new Error('사용자 확인값은 개선 후보 결과에만 적용할 수 있어요.');
    if (options.toiletLidStates && !options.understandingOverride)
      throw new Error('변기 뚜껑 보정은 원래 후보의 사용자 교정에서만 적용할 수 있어요.');
    if (options.productColors && !options.understandingOverride)
      throw new Error('제품 색 보정은 원래 후보의 사용자 교정에서만 적용할 수 있어요.');
    if (options.pedestalShapes && !options.understandingOverride)
      throw new Error('기둥 단면은 원래 후보의 사용자 교정에서만 확인할 수 있어요.');
    const fingerprint = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    diagnostic.checkpoint('inputFingerprint', fingerprint);
    if (options.reuseReport && !sameLabInput(options.reuseReport, fingerprint, room))
      throw new Error('이전 분석과 사진·공간 크기가 달라요. 새 조건으로 분석해 주세요.');
    const historicalCorrection =
      !!options.understandingOverride &&
      !!options.reuseReport &&
      historicalCorrectionCompatible(options.reuseReport, fingerprint, room);
    const baselineCurrent =
      !!options.reuseReport && baselineReuseCompatible(options.reuseReport, fingerprint, room);
    const baselineReused = baselineCurrent || historicalCorrection;
    if (options.reuseReport && !baselineReused)
      throw new Error(
        '이전 분석의 모델·설정·처리 규칙이 현재 버전과 달라요. 기존 결과는 보존하고 새로 분석해 주세요.',
      );
    const modelCurrent =
      !!options.reuseReport?.pipeline &&
      modelReuseCompatible(
        options.reuseReport,
        fingerprint,
        room,
        options.expectedModelRevision,
        estimatedLayout,
      );
    const modelReused = modelCurrent || historicalCorrection;
    if (options.understandingOverride && options.reuseReport?.pipeline && !modelReused)
      throw new Error(
        '교정할 원래 관측 데이터를 검증할 수 없어요. 기존 보고서는 보존하고 손상된 입력을 확인해 주세요. AI를 다시 실행하지 않았어요.',
      );
    if (options.understandingOverride && !options.reuseReport?.pipeline)
      throw new Error('교정할 원래 후보 분석이 없어요.');
    if (
      options.understandingOverride &&
      options.reuseReport?.pipeline?.quality &&
      options.reuseReport.pipeline.quality.revision !== LOCAL_QUALITY_REVISION
    )
      throw new Error(
        '이전 정밀 분석 버전의 관측은 현재 교정에 사용할 수 없어요. 원래 결과를 보존했으며 AI를 다시 실행하지 않았어요. 새 분석을 직접 시작해 주세요.',
      );
    diagnostic.checkpoint('reuseDecision', {
      baselineReused,
      modelReused,
      historicalCorrection,
      sourceRunId: options.reuseReport?.runId,
    });
    diagnostic.phase('baseline');
    // A signal creates a dedicated segmentation worker; cancellation never terminates another edit.
    const project = await createReconstructionProject(file, structuredClone(room), {
      repositories: memory.repositories,
      externalDiagnostics: true,
      signal,
      onStage,
      onRawReview: (review) => {
        rawReview = structuredClone(review);
        diagnostic.checkpoint('baselineReview', review);
      },
      onSegmentationCandidates: (candidates) => {
        rawSegmentationCandidates = structuredClone(candidates);
        diagnostic.checkpoint('rawSegmentationCandidates', candidates);
      },
      reuseAnalysis: baselineReused
        ? (options.reuseReport?.pipeline?.baselineReview ?? options.reuseReport?.rawReview)
        : undefined,
      onBaselineAnalysis: (measurement) => {
        baselineAnalysisMs = measurement.elapsedMs;
        diagnostic.checkpoint('baselineMeasurement', measurement);
        diagnostic.phase('placement');
      },
      transformAnalysis:
        engineId === 'candidate'
          ? async (baseline, photo, image, segmentation) => {
              diagnostic.phase('candidate-model');
              onStage(
                options.understandingOverride
                  ? 'AI 재실행 없이 사용자 확인값으로 모형 준비 중'
                  : '로컬 Qwen으로 설비·설치·관계 분석 중',
              );
              const modelStarted = performance.now();
              const model = modelReused
                ? options.reuseReport!.pipeline!.model
                : (() => { throw new Error('기존 로컬 AI 실험은 종료됐어요. /reconstruction-performance에서 새 분석을 시작해 주세요.'); })();
              additionalModelMs = modelReused ? 0 : performance.now() - modelStarted;
              diagnostic.checkpoint('modelResponse', model);
              diagnostic.phase('placement');
              checkAbort(signal);
              onStage('촬영 시점·공간 위치와 표준 모형 맞춤 확인 중');
              const previousQuality = options.reuseReport?.pipeline?.quality;
              const automatic = previousQuality?.effectiveUnderstanding ?? model.understanding;
              const understanding = options.understandingOverride
                ? validateUserUnderstanding(options.understandingOverride, automatic)
                : automatic;
              const preserveLegacy =
                options.candidateProfile === 'legacy-inventory' ||
                (!!options.understandingOverride && !previousQuality);
              if (!preserveLegacy) {
                const result = await runQualityPipeline({
                  baseline,
                  photo,
                  image,
                  room,
                  inputFingerprint: fingerprint,
                  segmentation,
                  signal,
                  inventory: model,
                  estimatedLayout,
                  refineAppearance: estimatedLayout,
                  // Historical replays keep their recorded stages; only a new experiment can infer more.
                  refineShowerDetails: estimatedLayout && !previousQuality,
                  refineDividerMaterials: estimatedLayout && !previousQuality,
                  reuse:
                    previousQuality?.revision === LOCAL_QUALITY_REVISION && modelReused
                      ? previousQuality
                      : undefined,
                  understandingOverride: options.understandingOverride ? understanding : undefined,
                  manualPlacements: options.manualPlacements,
                  toiletLidStates: options.toiletLidStates,
                  productColors: options.productColors,
                  pedestalShapes: options.pedestalShapes,
                  onStage,
                  onPhase: (phase) => diagnostic.phase(phase),
                  onCheckpoint: (name, value) => diagnostic.checkpoint(name, value),
                });
                additionalModelMs +=
                  (result.evidence.timing.identityMs ?? 0) +
                  result.evidence.timing.installationMs +
                  result.evidence.timing.geometryMs +
                  (result.evidence.timing.appearanceMs ?? 0) +
                  (result.evidence.timing.showerDetailsMs ?? 0) +
                  (result.evidence.timing.showerInstallationMs ?? 0) +
                  (result.evidence.timing.dividerMaterialsMs ?? 0) +
                  (result.evidence.timing.reflectionRecheckMs ?? 0) +
                  (result.evidence.timing.layoutMs ?? 0);
                diagnostic.phase('placement');
                pipeline = {
                  ...result.pipeline,
                  model: structuredClone(model),
                  modelReused,
                  modelSourceRunId: modelReused
                    ? (options.reuseReport?.pipeline?.modelSourceRunId ?? options.reuseReport?.runId)
                    : undefined,
                  quality: result.evidence,
                };
                diagnostic.checkpoint('candidatePipeline', pipeline);
                return result;
              }
              if (
                Object.keys(options.manualPlacements ?? {}).some(
                  (id) => !understanding.candidates.some((item) => item.id === id),
                )
              )
                throw new Error('수동 배치가 알 수 없는 설비를 참조해요.');
              const result = buildCandidatePipeline(
                understanding,
                baseline,
                room,
                image,
                options.manualPlacements,
                model.understanding,
                options.toiletLidStates,
                undefined,
                { candidateInputFingerprint: fingerprint, observationInputFingerprint: fingerprint },
                options.productColors,
                options.pedestalShapes,
              );
              pipeline = {
                ...result.pipeline,
                automaticUnderstanding: structuredClone(model.understanding),
                model: structuredClone(model),
                modelReused,
                modelSourceRunId:
                  modelReused && options.reuseReport?.pipeline
                    ? (options.reuseReport.pipeline.modelSourceRunId ?? options.reuseReport.runId)
                    : undefined,
              };
              diagnostic.checkpoint('candidatePipeline', pipeline);
              return result;
            }
          : undefined,
      onAnalysis: (size) => {
        analysisSize = size;
        diagnostic.checkpoint('analysisSize', size);
      },
    });
    checkAbort(signal);
    const creationMs = performance.now() - start;
    const comparison = project.shared.comparison;
    if (!comparison?.review) throw new Error('사진 분석 테스트의 재구성 결과를 찾지 못했어요.');
    const originalAsset = await memory.repositories.assets.get(comparison.referenceOriginalAssetId);
    const previewAsset = await memory.repositories.assets.get(comparison.referencePreviewAssetId);
    if (originalAsset.kind === 'product-mesh' || previewAsset.kind === 'product-mesh')
      throw new Error('사진 분석 테스트 입력은 이미지여야 해요.');
    diagnostic.phase('render');
    onStage('테스트용 Before 결과 이미지 만드는 중');
    const renderStart = performance.now();
    const versions = await memory.repositories.materials.list();
    checkAbort(signal);
    const before = comparison.before;
    const sourceCamera = estimatedLayout ? pipeline?.estimatedLayout?.camera.value : undefined;
    const renderView = sourceCamera ? sourceRoomView(sourceCamera, room) : undefined;
    if (renderView) project.roomView = structuredClone(renderView);
    const snapshot = {
      scene: project.shared.baseline,
      beforeScene: before,
      materials: Object.fromEntries(versions.map(({ version }) => [version.id, version])),
      ...(renderView ? { roomView: renderView } : {}),
    };
    const edge = Math.min(1600, Math.max(before.imageWidth, before.imageHeight));
    let blob: Blob;
    if (renderView) {
      diagnostic.checkpoint('commonRenderView', {
        source: 'estimated-source-camera',
        rendererRevision: ROOM_VIEWER_RENDERER_REVISION,
        view: renderView,
        note: '배치 계산에 사용한 추정 시점이며 실측 카메라가 아니에요. Before/After에 같은 시점을 사용해요.',
      });
      blob = await renderRoomSnapshotImage(snapshot, (id) => memory.repositories.assets.get(id), {
        renderer: 'room-view',
        mode: 'before',
        longEdge: edge,
        format: 'png',
        view: renderView,
      });
    } else {
      renderer = new PhotoCompositor();
      const supportedEdge = Math.min(edge, renderer.maxOutputEdge);
      const scale = supportedEdge / Math.max(before.imageWidth, before.imageHeight);
      const width = Math.max(1, Math.round(before.imageWidth * scale));
      const height = Math.max(1, Math.round(before.imageHeight * scale));
      await renderer.setSnapshot(snapshot, (id) => memory.repositories.assets.get(id), {
        maxPreviewEdge: supportedEdge,
      });
      checkAbort(signal);
      blob = await canvasBlob(renderer.render(width, height, 'before'), 'image/png');
    }
    checkAbort(signal);
    const outputHeader = readImageHeader(new Uint8Array(await blob.arrayBuffer()));
    const renderMs = performance.now() - renderStart;
    const heapEnd = heap();
    const report: ReconstructionLabReport = {
      schemaVersion: 1,
      runId,
      startedAt,
      algorithm: {
        reconstructionReviewVersion: comparison.review.version,
        templateRendererRevision: TEMPLATE_RENDERER_REVISION,
        ...(renderView ? { roomViewerRendererRevision: ROOM_VIEWER_RENDERER_REVISION } : {}),
      },
      engine:
        engineId === 'baseline'
          ? '기존 분석 · DeepLab ADE20K + 관측 근거 규칙 + 표준 모형'
          : pipeline?.quality
            ? estimatedLayout
              ? '형태·관계 개선 실험 · 설비 재확인 + 관계 기반 추정 배치'
              : '개선 후보 · 로컬 Qwen 설비·설치 관측 + MoGe-2 공간 구조 + 표준 모형'
            : '이전 후보 관측 재생 · Qwen + 표준 모형',
      engineMetadata: {
        id: engineId,
        revision: engineId === 'baseline' ? LAB_BASELINE_REVISION : LAB_CANDIDATE_REVISION,
        modelId: pipeline?.model.modelId ?? 'DeepLab ADE20K',
        modelRevision: pipeline?.model.modelRevision ?? LAB_BASELINE_MODEL_REVISION,
        settings: pipeline
          ? {
              promptRevision: pipeline.model.promptRevision,
              ...(pipeline.model.settings ?? options.reuseReport?.engineMetadata.settings ?? {}),
              outputContract: pipeline.model.outputContract ?? 'scene-understanding-v1',
              candidateInputEdge: 1024,
              segmentation: 'TFJS-WASM-single-thread',
              ...(pipeline.quality
                ? {
                    qualityRevision: pipeline.quality.revision,
                    placementPolicy: pipeline.quality.placementPolicy ?? 'strict',
                    ...(pipeline.quality.appearance
                      ? {
                          appearanceContract: pipeline.quality.appearance.outputContract,
                          appearanceRuleRevision: pipeline.quality.appearance.ruleRevision,
                        }
                      : {}),
                    ...(pipeline.quality.showerDetails
                      ? {
                          showerDetailContract: pipeline.quality.showerDetails.outputContract,
                          showerDetailPromptRevision: pipeline.quality.showerDetails.promptRevision,
                          showerDetailAdoptionRevision: SHOWER_DETAIL_ADOPTION_REVISION,
                        }
                      : {}),
                    ...(pipeline.quality.showerInstallation ? {
                      showerInstallationDecisionRevision: pipeline.quality.showerInstallation.decisionRevision,
                      showerInstallationTargetCount: pipeline.quality.showerInstallation.observations.length,
                    } : {}),
                    ...(pipeline.quality.dividerMaterials
                      ? {
                          dividerMaterialContract: pipeline.quality.dividerMaterials.outputContract,
                          dividerMaterialPromptRevision: pipeline.quality.dividerMaterials.promptRevision,
                          dividerApplicationRevision: pipeline.quality.dividerApplication?.revision,
                        }
                      : {}),
                    ...(pipeline.quality.reflectionRecheck
                      ? { reflectionRecheckRuleRevision: pipeline.quality.reflectionRecheck.ruleRevision }
                      : {}),
                    ...(pipeline.quality.classificationResolution
                      ? { classificationResolutionRevision: pipeline.quality.classificationResolution.revision }
                      : {}),
                    geometryModelId: pipeline.quality.geometry.observation.model.id,
                  }
                : {}),
            }
          : { ...LAB_BASELINE_SETTINGS },
      },
      inputFingerprint: fingerprint,
      rawReview: rawReview ?? structuredClone(comparison.review),
      rawSegmentationCandidates,
      pipeline,
      correctionOfRunId: options.understandingOverride ? options.reuseReport?.runId : undefined,
      reuse: {
        baseline: {
          reused: baselineReused,
          cacheKey:
            historicalCorrection && !baselineCurrent
              ? (options.reuseReport?.reuse?.baseline.cacheKey ??
                'historical:' + options.reuseReport!.runId + ':baseline')
              : baselineCacheKey(fingerprint, room),
          compatibility: historicalCorrection && !baselineCurrent ? 'historical-correction' : 'current',
          sourceEngineMetadata: baselineReused
            ? structuredClone(
                options.reuseReport?.reuse?.baseline.sourceEngineMetadata ??
                  options.reuseReport!.engineMetadata,
              )
            : undefined,
          sourceRunId: baselineReused
            ? (options.reuseReport?.reuse?.baseline.sourceRunId ?? options.reuseReport?.runId)
            : undefined,
          sourceDurationMs: baselineReused
            ? (options.reuseReport?.reuse?.baseline.sourceDurationMs ??
              options.reuseReport?.timing?.baselineAnalysisMs)
            : undefined,
        },
        model: {
          reused: modelReused,
          sourceRunId: pipeline?.modelSourceRunId,
          compatibility: historicalCorrection && !modelCurrent ? 'historical-correction' : 'current',
          sourceEngineMetadata: modelReused
            ? structuredClone(
                options.reuseReport?.reuse?.model.sourceEngineMetadata ?? options.reuseReport!.engineMetadata,
              )
            : undefined,
          sourceDurationMs: modelReused ? pipeline?.model.measurement.requestMs : undefined,
        },
        newStages: [
          'input-preparation',
          ...(!baselineReused ? ['baseline-analysis'] : []),
          ...(pipeline && !modelReused ? ['additional-model'] : []),
          ...(pipeline?.quality && !pipeline.quality.reused
            ? ['installation-observation', 'geometry-observation']
            : []),
          'placement-and-templates',
          'render',
        ],
      },
      timing: {
        totalMs: performance.now() - start,
        baselineAnalysisMs,
        additionalModelMs,
        placementAndPreparationMs:
          baselineAnalysisMs === undefined
            ? undefined
            : Math.max(0, creationMs - baselineAnalysisMs - additionalModelMs),
        renderMs,
        scope:
          '이번 실행만 측정. 기존 분석은 입력 준비 후 픽셀 분석·관측 규칙까지. 추가 모델은 입력 준비·통신·검증 포함. 배치·기타 준비는 사진 검증 및 모형 생성을 포함. 재사용 원본 측정값은 reuse에 별도 보존.',
      },
      input: {
        name: file.name,
        width: originalAsset.width,
        height: originalAsset.height,
        bytes: file.size,
        previewWidth: previewAsset.width,
        previewHeight: previewAsset.height,
        analysisWidth: analysisSize?.width ?? options.reuseReport?.input.analysisWidth,
        analysisHeight: analysisSize?.height ?? options.reuseReport?.input.analysisHeight,
      },
      room: structuredClone(room),
      creationMs,
      renderMs,
      totalMs: performance.now() - start,
      stages: structuredClone(stages),
      review: structuredClone(comparison.review),
      fixtures: structuredClone(before.fixtures),
      output: {
        width: outputHeader.width,
        height: outputHeader.height,
        mime: 'image/png',
        renderer: renderView ? 'room-view' : 'legacy-front',
      },
      ...(renderView ? { renderView: structuredClone(renderView) } : {}),
      measurement: {
        browser: typeof navigator === 'undefined' ? 'unavailable' : navigator.userAgent,
        hardwareConcurrency: typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
        mainPageJsHeapPeakBytes: peak,
        mainPageJsHeapEndBytes: heapEnd,
        memoryScope:
          '메인 페이지 JavaScript heap만 관측하며 분석 Worker·WASM·GPU·전체 프로세스 메모리는 포함하지 않아요.',
        segmentation: 'DeepLab ADE20K / TFJS WASM / single thread / dedicated worker',
        cancellation:
          '분석 중에는 이 테스트의 전용 Worker를 종료하며, 이미지 생성 중에는 현재 비동기 단계 뒤 결과를 버리고 자원을 정리해요.',
      },
    };
    report.execution = labExecution(report);
    report.candidateTraces = labCandidateTraces(report);
    report.diagnosticSummary = buildDiagnosticSummary(report);
    if (report.reuse)
      report.reuse.model.cacheKey =
        historicalCorrection && !modelCurrent
          ? (options.reuseReport?.reuse?.model.cacheKey ??
            'historical:' + options.reuseReport!.runId + ':model')
          : modelCacheKey(report, fingerprint, room);
    if (report.timing) report.timing.totalMs = report.totalMs;
    const resources = memory.snapshot();
    const thumbnailId = crypto.randomUUID();
    const document = structuredClone(project);
    document.thumbnailAssetId = thumbnailId;
    resources.assets.push({
      id: thumbnailId,
      ownerId: 'local',
      name: '사진 테스트 Before.png',
      kind: 'thumbnail',
      mime: 'image/png',
      size: blob.size,
      width: outputHeader.width,
      height: outputHeader.height,
      sourceAssetId: before.originalAssetId,
      createdAt: new Date().toISOString(),
      blob,
    });
    const projectBundle: LabProjectBundle = {
      version: 1,
      runId,
      inputFingerprint: fingerprint,
      document,
      ...resources,
    };
    diagnostic.checkpoint('output', {
      output: report.output,
      execution: report.execution,
      timing: report.timing,
    });
    report.runLog = diagnostic.finish('complete');
    report.logStorage = await saveDiagnosticArchive({
      schemaVersion: 1,
      runId,
      startedAt,
      status: 'complete',
      input: report.runLog.input,
      engine: engineId,
      report,
    });
    return { original: previewAsset.blob, before: blob, report, projectBundle };
  } catch (error) {
    const wasCancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const runLog = diagnostic.finish(wasCancelled ? 'cancelled' : 'failed', error);
    const failure = new ReconstructionDiagnosticError(error, runLog);
    failure.diagnostics.logStorage = await saveDiagnosticArchive({
      schemaVersion: 1,
      runId,
      startedAt,
      status: runLog.status,
      input: runLog.input,
      engine: engineId,
      failure: failure.diagnostics,
    });
    throw failure;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
    // The worker is disposed by segmentRoom on every terminal path; renderer owns its GPU/bitmap caches.
    try {
      renderer?.dispose();
    } finally {
      memory.dispose();
    }
  }
}
