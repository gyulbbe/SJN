import { createReconstructionProject, type ReconstructionModelProgress } from './index';
import { mogeLoadEvent } from '../ai-progress';
import type { CandidatePipeline } from './candidate-pipeline';
import type { ReconstructionReview } from './types';
import { importImage } from '../images';
import { memoryRepositories } from './lab';
import { analyzeExtendedScene } from './analysis-client';
import { browserGeometryInput, geometryAnalysisFromBrowser } from './geometry-browser-client';
import { MogeBrowserClient, type MogeExecutionMode, type MogeBrowserResult } from './moge-browser/client';
import { segmentReconstructionCached } from './segmentation-cache';
import { renderRoomSnapshotImage } from '../room-viewer/render-snapshot';
import { getActiveScene } from '../comparison';
import { projectDesignPreviewRoomContext } from '../render/design-preview-context';
import type { SceneUnderstanding } from './pipeline-contract';
import type { RoomDefinition } from '../room-types';
import type { ReconstructionQualityEvidence } from './quality-contract';

export type BrowserAnalysisTestKind = 'gemma' | 'geometry' | 'full';
export type BrowserAnalysisTestResult = { original: Blob; before?: Blob; geometry?: MogeBrowserResult; report: Record<string, unknown> };
const emptyUnderstanding: SceneUnderstanding = { schemaVersion: 1, candidates: [], relations: [], roomLayout: { backWallQuad: null, lines: [], corners: [], evidence: [], orthogonal: 'unknown', uncertainty: [] } };

/** Real clients, same oriented import and project preparation path. No project/catalog writes. */
export async function runBrowserAnalysisTest(file: File, kind: BrowserAnalysisTestKind, room: RoomDefinition,
  options: { mode: MogeExecutionMode; signal: AbortSignal; onStage: (message: string) => void;
    onModelProgress?: (update: ReconstructionModelProgress) => void }): Promise<BrowserAnalysisTestResult> {
  const started = performance.now(), memory = memoryRepositories();
  let geometry: MogeBrowserResult | undefined;
  try {
    if (kind === 'full') {
      let quality: ReconstructionQualityEvidence | undefined;
      let baselineReview: ReconstructionReview | undefined;
      let pipeline: CandidatePipeline | undefined;
      const project = await createReconstructionProject(file, room, {
        repositories: memory.repositories, externalDiagnostics: true, analysisProfile: 'cloud-browser-v1',
        mogeMode: options.mode, signal: options.signal, onStage: options.onStage, onModelProgress: options.onModelProgress,
        onRawReview: review => { baselineReview = structuredClone(review); },
        onQuality: result => { quality = result.evidence; pipeline = structuredClone(result.pipeline); },
        onMogeGeometry: value => { geometry = value; },
      });
      options.signal.throwIfAborted();
      const comparison = project.shared.comparison;
      if (!comparison) throw new Error('Before 결과가 없어요.');
      const original = await memory.repositories.assets.get(comparison.referencePreviewAssetId);
      const versions = await memory.repositories.materials.list();
      // Use the editor's renderer and shared design fit; source-photo view is a separate concern.
      const scene = getActiveScene(project), roomContext = projectDesignPreviewRoomContext(project);
      const renderer = roomContext ? 'room-view' : 'legacy-front';
      const before = await renderRoomSnapshotImage({ scene, beforeScene: comparison.before,
        materials: Object.fromEntries(versions.map(({ version }) => [version.id, version])), roomView: project.roomView },
        id => memory.repositories.assets.get(id), { renderer, mode: 'before', longEdge: 1024,
          ...(roomContext ? { view: roomContext.view, fitScenes: roomContext.fitScenes } : {}) });
      options.signal.throwIfAborted();
      return { original: original.blob, before, geometry, report: { kind, profile: 'cloud-browser-v1', totalMs: performance.now() - started,
        review: comparison.review, quality, projectSaved: false,
        // Keep actual selected/alternative proposals, relation scores and raw semantic baseline.
        // This is test-report data only; no project, source image or generated asset is rewritten.
        analysisDiagnostics: { schemaVersion: 1, baselineReview, pipeline },
        rendering: { renderer, mode: 'before', frame: { width: scene.imageWidth, height: scene.imageHeight },
          selection: 'normal-editor', commonDesignFit: !!roomContext },
        photoTransfer: 'Cloudflare fixture analysis only', memory: '측정 불가' } };
    }
    const photo = await importImage(file, 'original', memory.repositories.assets);
    options.signal.throwIfAborted();
    if (kind === 'gemma') {
      options.onStage('Cloudflare에서 설비 목록 분석 중');
      const result = await analyzeExtendedScene(photo.preview.blob, options.signal, 'cloudflare-workers-ai');
      return { original: photo.preview.blob, report: { kind, totalMs: performance.now() - started, ...result, memory: '서버 메모리 측정 불가' } };
    }
    const segmentation = await segmentReconstructionCached(photo.preview.blob, options.onStage, options.signal,
      options.onModelProgress && (event => options.onModelProgress?.({ model: 'deeplab', index: 1, count: 2, event })));
    const input = await browserGeometryInput(photo.preview.blob, segmentation, emptyUnderstanding);
    const client = new MogeBrowserClient();
    try {
      geometry = await client.run(photo.preview.blob, { mode: options.mode, signal: options.signal, geometry: input,
        onProgress: progress => {
          if (!options.onModelProgress)
            return options.onStage(progress.total && progress.loaded !== undefined ? `${progress.message} ${Math.round(progress.loaded / progress.total * 100)}%` : progress.message);
          options.onModelProgress({ model: 'moge', index: 2, count: 2, event: mogeLoadEvent(progress) });
          options.onStage(progress.message);
        } });
      options.onModelProgress?.({ model: 'moge', index: 2, count: 2, event: { phase: 'ready' } });
      options.signal.throwIfAborted();
      return { original: photo.preview.blob, geometry, report: { kind, totalMs: performance.now() - started,
        geometry: geometryAnalysisFromBrowser(geometry, input), timings: geometry.timings, metadata: geometry.metadata,
        backend: geometry.backend, requestedMode: geometry.requestedMode, cacheSource: geometry.cacheSource, fallbackReason: geometry.fallbackReason,
        externalPhotoTransfer: false, memory: '측정 불가' } };
    } finally { client.dispose(); }
  } finally { memory.dispose(); }
}
