import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryOperations } from '../src/lib/repositories/contracts';
import type { ProjectDocument, RenderSnapshot, ImageAssetRecord } from '../src/lib/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
const hooks = vi.hoisted(() => ({
  create: vi.fn(),
  setSnapshot: vi.fn(),
  render: vi.fn(),
  dispose: vi.fn(),
  blob: vi.fn(),
  ctor: vi.fn(),
  account: '',
  archive: vi.fn(),
}));
vi.mock('../src/lib/repositories', () => ({ getRepositoryUserId: () => hooks.account }));
vi.mock('../src/lib/reconstruction/index', () => ({ createReconstructionProject: hooks.create }));
vi.mock('../src/lib/reconstruction/templates', () => ({ TEMPLATE_RENDERER_REVISION: 7 }));
vi.mock('../src/lib/images', async (original) => ({
  ...(await original<typeof import('../src/lib/images')>()),
  canvasBlob: hooks.blob,
}));
vi.mock('../src/lib/render/compositor', () => ({
  PhotoCompositor: class {
    maxOutputEdge = 2048;
    constructor() {
      hooks.ctor();
    }
    setSnapshot(...args: unknown[]) {
      return hooks.setSnapshot(...args);
    }
    render(...args: unknown[]) {
      return hooks.render(...args);
    }
    dispose() {
      hooks.dispose();
    }
  },
}));
import { runReconstructionLabCase } from '../src/lib/reconstruction/lab';
import { baselineReuseCompatible, modelReuseCompatible } from '../src/lib/reconstruction/lab-cache';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
let used: RepositoryOperations;
let generated: ProjectDocument;
const original = new Blob(['oriented'], { type: 'image/png' });
// Header-only output fixture: GPU encoding is mocked; header validation remains real.
function pngOutput(width = 1600, height = 1067) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}
const before = pngOutput();
const file = () => new File(['input'], '욕실.png', { type: 'image/png' });
function asset(id: string): ImageAssetRecord {
  return {
    id,
    kind: 'preview',
    ownerId: 'local',
    name: 'input',
    mime: 'image/png',
    blob: original,
    size: original.size,
    width: id === 'original' ? 3000 : 2048,
    height: id === 'original' ? 2000 : 1365,
    createdAt: new Date().toISOString(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  hooks.account = '';
  hooks.archive.mockImplementation(async () => Response.json({ stored: true }));
  vi.stubGlobal('fetch', hooks.archive);
  hooks.ctor.mockImplementation(() => {});
  hooks.setSnapshot.mockResolvedValue(undefined);
  hooks.render.mockImplementation((width: number, height: number) => ({ width, height }));
  hooks.blob.mockResolvedValue(before);
  vi.stubGlobal('indexedDB', {
    open: vi.fn(() => {
      throw new Error('Persistent storage forbidden');
    }),
  });
  vi.stubGlobal('navigator', { userAgent: 'test browser', hardwareConcurrency: 4 });
  hooks.create.mockImplementation(
    async (
      _file: File,
      _room: unknown,
      options: {
        repositories: RepositoryOperations;
        onStage: (message: string) => void;
        onAnalysis: (size: { width: number; height: number }) => void;
        signal: AbortSignal;
      },
    ) => {
      used = options.repositories;
      expect(options.signal).toBeInstanceOf(AbortSignal);
      await used.assets.put(asset('original'));
      await used.assets.put(asset('preview'));
      options.onStage('actual pipeline stage');
      options.onAnalysis({ width: 512, height: 341 });
      const scene = { imageWidth: 4096, imageHeight: 2731, fixtures: [] };
      generated = {
        shared: {
          baseline: scene,
          comparison: {
            before: scene,
            referenceOriginalAssetId: 'original',
            referencePreviewAssetId: 'preview',
            review: { version: 2, analysis: 'complete', candidates: [], planes: [], warnings: [] },
          },
        },
      } as unknown as ProjectDocument;
      return generated;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());
describe('disposable reconstruction lab orchestration (model/renderer mocked)', () => {
  it('uses the existing pipeline with isolated repositories, reports actual resolution stages, and releases them', async () => {
    hooks.account = 'analysis-member';
    const stage = vi.fn();
    const result = await runReconstructionLabCase(file(), DEFAULT_ROOM, { onStage: stage });
    expect(result.original).toEqual(original);
    expect(result.before).toBe(before);
    expect(result.projectBundle?.runId).toBe(result.report.runId);
    expect(result.projectBundle?.inputFingerprint).toBe(result.report.inputFingerprint);
    expect(result.projectBundle?.document.shared).toEqual(generated.shared);
    expect(result.projectBundle?.assets.find((asset) => asset.id === 'original')?.blob).toEqual(original);
    expect(result.projectBundle?.assets.find((asset) => asset.kind === 'thumbnail')?.blob).toEqual(before);
    expect(JSON.stringify(result.report)).not.toContain('projectBundle');
    expect(result.report.input).toMatchObject({
      name: '욕실.png',
      width: 3000,
      height: 2000,
      previewWidth: 2048,
      previewHeight: 1365,
      analysisWidth: 512,
      analysisHeight: 341,
      bytes: 5,
    });
    expect(result.report.output).toEqual({
      width: 1600,
      height: 1067,
      mime: 'image/png',
      renderer: 'legacy-front',
    });
    expect(result.report.algorithm).toEqual({ reconstructionReviewVersion: 2, templateRendererRevision: 7 });
    expect(result.report.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(result.report.startedAt)).not.toBeNaN();
    expect(result.report.measurement.memoryScope).toContain('Worker');
    expect(hooks.render).toHaveBeenCalledWith(1600, 1067, 'before');
    const snapshot = hooks.setSnapshot.mock.calls[0][0] as RenderSnapshot;
    expect(snapshot.beforeScene).toBe(generated.shared.comparison!.before);
    expect(hooks.dispose).toHaveBeenCalledOnce();
    await expect(used.assets.get('original')).rejects.toThrow('정리된');
    await expect(used.projects.create(generated)).rejects.toThrow('프로젝트 저장');
    // Only the account diagnostic API persists this report; project/material stores stay isolated.
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(hooks.archive).toHaveBeenCalledOnce();
    expect(hooks.archive.mock.calls[0][0]).toBe('/api/reconstruction/diagnostics');
    expect(hooks.archive.mock.calls[0][1].headers['X-SJN-User-Id']).toBe('analysis-member');
    expect(result.report.runLog?.status).toBe('complete');
    expect(result.report.diagnosticSummary?.runId).toBe(result.report.runId);
    expect(stage).toHaveBeenCalledWith('actual pipeline stage');
    result.report.review.warnings.push('changed');
    expect(generated.shared.comparison!.review!.warnings).toEqual([]);
  });
  it('records encoded PNG dimensions instead of assuming the requested render size', async () => {
    hooks.blob.mockResolvedValueOnce(pngOutput(800, 533));
    const result = await runReconstructionLabCase(file(), DEFAULT_ROOM);
    expect(hooks.render).toHaveBeenCalledWith(1600, 1067, 'before');
    expect(result.report.output).toEqual({
      width: 800,
      height: 533,
      mime: 'image/png',
      renderer: 'legacy-front',
    });
    expect(result.projectBundle?.assets.find((asset) => asset.kind === 'thumbnail')).toMatchObject({
      width: 800,
      height: 533,
    });
  });
  it('rejects unreadable output bytes and still releases the renderer and temporary assets', async () => {
    hooks.blob.mockResolvedValueOnce(new Blob(['not a PNG'], { type: 'image/png' }));
    await expect(runReconstructionLabCase(file(), DEFAULT_ROOM)).rejects.toThrow('올바른 JPG, PNG, WebP');
    expect(hooks.dispose).toHaveBeenCalledOnce();
    await expect(used.assets.get('preview')).rejects.toThrow('정리된');
  });
  it('keeps partial observed candidates and progress when a later pipeline stage fails', async () => {
    hooks.create.mockImplementation(async (_file, _room, options) => {
      options.onSegmentationCandidates([{ id: 'observed-sink', kind: 'basin' }]);
      options.onStage('template preparation reached');
      throw new Error('template failed');
    });
    const error = (await runReconstructionLabCase(file(), DEFAULT_ROOM).catch(
      (failure: unknown) => failure,
    )) as Error & {
      diagnostics: {
        runLog: { status: string; checkpoints: Record<string, unknown>; events: { message: string }[] };
      };
    };
    expect(error.message).toBe('template failed');
    expect(error.diagnostics.runLog.status).toBe('failed');
    expect(error.diagnostics.runLog.checkpoints.rawSegmentationCandidates).toEqual([
      { id: 'observed-sink', kind: 'basin' },
    ]);
    expect(
      error.diagnostics.runLog.events.some((entry) => entry.message === 'template preparation reached'),
    ).toBe(true);
    expect(hooks.render).not.toHaveBeenCalled();
  });
  it('supports in-memory asset/material round trips without leaking mutable records', async () => {
    const previous = hooks.create.getMockImplementation()!;
    hooks.create.mockImplementation(async (...args) => {
      const project = await previous(...args);
      const repos = args[2].repositories as RepositoryOperations;
      const version = await repos.materials.create({
        name: 'test',
        scope: 'personal',
        textureAssetIds: ['preview'],
        views: [],
      } as never);
      version.name = 'modified copy';
      expect((await repos.materials.getVersion(version.id)).name).toBe('test');
      expect((await repos.materials.list())[0].material.currentVersionId).toBe(version.id);
      await expect(repos.materials.update(version.materialId, version, version.id)).rejects.toThrow(
        '기존 자재 변경',
      );
      await expect(repos.projects.save(project, 0)).rejects.toThrow('프로젝트 저장');
      return project;
    });
    await runReconstructionLabCase(file(), DEFAULT_ROOM);
    await expect(used.materials.list()).rejects.toThrow('정리된');
  });
  it('releases memory on pipeline errors without trying to render partial results', async () => {
    hooks.create.mockImplementation(async (_f, _r, options) => {
      used = options.repositories;
      await used.assets.put(asset('original'));
      throw new Error('model failed');
    });
    await expect(runReconstructionLabCase(file(), DEFAULT_ROOM)).rejects.toThrow('model failed');
    expect(hooks.ctor).not.toHaveBeenCalled();
    await expect(used.assets.get('original')).rejects.toThrow('정리된');
  });
  it('releases renderer and memory on WebGL preparation or PNG failure', async () => {
    hooks.setSnapshot.mockRejectedValueOnce(new Error('WebGL failed'));
    await expect(runReconstructionLabCase(file(), DEFAULT_ROOM)).rejects.toThrow('WebGL failed');
    expect(hooks.dispose).toHaveBeenCalledOnce();
    await expect(used.assets.get('preview')).rejects.toThrow('정리된');
    hooks.blob.mockRejectedValueOnce(new Error('PNG failed'));
    await expect(runReconstructionLabCase(file(), DEFAULT_ROOM)).rejects.toThrow('PNG failed');
    expect(hooks.dispose).toHaveBeenCalledTimes(2);
  });
  it('rejects an already aborted case before starting work and discards a late result on abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runReconstructionLabCase(file(), DEFAULT_ROOM, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(hooks.create).not.toHaveBeenCalled();
    const next = new AbortController();
    const previous = hooks.create.getMockImplementation()!;
    hooks.create.mockImplementation(async (...args) => {
      const project = await previous(...args);
      next.abort();
      return project;
    });
    await expect(
      runReconstructionLabCase(file(), DEFAULT_ROOM, { signal: next.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(hooks.ctor).not.toHaveBeenCalled();
    await expect(used.assets.get('original')).rejects.toThrow('정리된');
  });
  it('does not publish a PNG completed after cancellation', async () => {
    const controller = new AbortController();
    hooks.blob.mockImplementationOnce(async () => {
      controller.abort();
      return before;
    });
    await expect(
      runReconstructionLabCase(file(), DEFAULT_ROOM, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(hooks.dispose).toHaveBeenCalledOnce();
    await expect(used.assets.get('original')).rejects.toThrow('정리된');
  });
});

describe('historical correction orchestration without model inference', () => {
  function runActualTransformHook() {
    const previous = hooks.create.getMockImplementation()!;
    hooks.create.mockImplementation(async (...args) => {
      const project = await previous(...args);
      const options = args[2];
      options.onBaselineAnalysis?.({
        elapsedMs: options.reuseAnalysis ? 0 : 18,
        reused: !!options.reuseAnalysis,
      });
      if (options.transformAnalysis) {
        const result = await options.transformAnalysis(options.reuseAnalysis, original, {
          width: 2048,
          height: 1365,
        });
        project.shared.comparison.review = result.review;
      }
      return project;
    });
  }
  async function historicalSource() {
    const source = (await runReconstructionLabCase(file(), DEFAULT_ROOM)).report;
    const understanding: SceneUnderstanding = {
      schemaVersion: 1,
      candidates: [
        {
          id: 'sink',
          kind: 'basin',
          bounds: { left: 0.2, top: 0.3, right: 0.5, bottom: 0.7 },
          mounting: 'wall',
          wall: 'left',
          basinStyle: 'wall',
          shape: 'rectangular',
          reflection: 'physical',
          evidence: ['wall attached basin'],
          uncertainty: [],
          bowlCount: 1,
        },
      ],
      relations: [],
      roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
    };
    source.engineMetadata = {
      id: 'candidate',
      revision: 'historical-code',
      modelId: 'qwen3-vl:4b-instruct-q4_K_M',
      modelRevision: 'a'.repeat(64),
      settings: { promptRevision: 5 },
    };
    source.pipeline = {
      baselineReview: structuredClone(source.review),
      understanding,
      automaticUnderstanding: structuredClone(understanding),
      model: {
        understanding: structuredClone(understanding),
        rawText: JSON.stringify(understanding),
        modelId: 'qwen3-vl:4b-instruct-q4_K_M',
        modelRevision: 'a'.repeat(64),
        promptRevision: 5,
        settings: { temperature: 0 },
        measurement: {
          requestMs: 32000,
          inputWidth: 2048,
          inputHeight: 1365,
          memoryScope: 'unit fixture; no measurement',
          modelDownload: 'not-performed-cached-model-required',
        },
      },
      modelReused: false,
      resolution: {
        rawCount: 1,
        organizedCount: 1,
        duplicateCount: 0,
        componentCount: 0,
        entries: [],
        assemblies: [],
      },
      camera: {
        status: 'held',
        method: 'none',
        intrinsics: 'unresolved',
        reasons: ['unit: camera unknown'],
        assumptions: [],
      },
      placements: [],
      modelChecks: [],
      evidenceChecks: [],
      warnings: [],
    };
    delete source.reuse;
    return source;
  }
  it('revalidates historical observations for a correction without promoting cache or altering original', async () => {
    runActualTransformHook();
    const source = await historicalSource(),
      frozen = structuredClone(source);
    const corrected = structuredClone(source.pipeline!.understanding);
    corrected.candidates[0].bowlCount = 2;
    corrected.candidates[0].provenance = { bowlCount: 'user' };
    const network = vi.fn(() => {
      throw new Error('Model network must not run');
    });
    vi.stubGlobal('fetch', network);
    const result = await runReconstructionLabCase(file(), DEFAULT_ROOM, {
      engine: 'candidate',
      reuseReport: source,
      understandingOverride: corrected,
    });
    expect(network).not.toHaveBeenCalled();
    expect(result.report.pipeline!.understanding.candidates[0].bowlCount).toBe(2);
    expect(result.report.pipeline!.automaticUnderstanding.candidates[0].bowlCount).toBe(1);
    expect(result.report.pipeline!.model.rawText).toBe(frozen.pipeline!.model.rawText);
    expect(result.report.correctionOfRunId).toBe(source.runId);
    expect(result.report.reuse?.baseline).toMatchObject({
      reused: true,
      compatibility: 'historical-correction',
      sourceRunId: source.runId,
    });
    expect(result.report.reuse?.model).toMatchObject({
      reused: true,
      compatibility: 'historical-correction',
      sourceDurationMs: 32000,
      sourceEngineMetadata: { revision: 'historical-code' },
    });
    expect(result.report.timing).toMatchObject({ baselineAnalysisMs: 0, additionalModelMs: 0 });
    expect(baselineReuseCompatible(result.report, source.inputFingerprint!, DEFAULT_ROOM)).toBe(false);
    expect(modelReuseCompatible(result.report, source.inputFingerprint!, DEFAULT_ROOM)).toBe(false);
    expect(source).toEqual(frozen);
  });
  it('does not run installation or depth models when correcting an incompatible quality revision', async () => {
    runActualTransformHook();
    const source = await historicalSource();
    source.pipeline!.quality = { version: 1, revision: 'previous-quality-revision' } as never;
    const network = vi.fn(() => {
      throw new Error('No model may run');
    });
    vi.stubGlobal('fetch', network);
    const count = hooks.create.mock.calls.length;
    await expect(
      runReconstructionLabCase(file(), DEFAULT_ROOM, {
        engine: 'candidate',
        reuseReport: source,
        understandingOverride: source.pipeline!.understanding,
      }),
    ).rejects.toThrow('이전 정밀 분석 버전');
    expect(network).not.toHaveBeenCalled();
    expect(hooks.create.mock.calls.length).toBe(count);
  });
  it('rejects historical automatic cache reuse and mismatched correction photos before starting work', async () => {
    runActualTransformHook();
    const source = await historicalSource();
    const count = hooks.create.mock.calls.length;
    await expect(
      runReconstructionLabCase(file(), DEFAULT_ROOM, { engine: 'candidate', reuseReport: source }),
    ).rejects.toThrow('처리 규칙');
    await expect(
      runReconstructionLabCase(new File(['other'], 'same.png'), DEFAULT_ROOM, {
        engine: 'candidate',
        reuseReport: source,
        understandingOverride: source.pipeline!.understanding,
      }),
    ).rejects.toThrow('사진·공간');
    expect(hooks.create.mock.calls.length).toBe(count);
  });
});
