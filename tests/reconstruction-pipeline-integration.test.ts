import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssetRecord,
  ImageAssetRecord,
  MaterialInput,
  MaterialVersion,
  RenderSnapshot,
} from '../src/lib/types';
import type { Repositories } from '../src/lib/repositories/contracts';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { LocalSceneAnalysis } from '../src/lib/reconstruction/analysis-client';
const hooks = vi.hoisted(() => ({
  segment: vi.fn(),
  qwen: vi.fn(),
  identity: vi.fn(),
  installation: vi.fn(),
  layout: vi.fn(),
  appearance: vi.fn(),
  showerInstallation: vi.fn(() => {
    throw new Error('Unexpected installation-state inference on historical path');
  }),
  validateShowerInstallation: vi.fn(() => {
    throw new Error('Unexpected installation-state receipt on historical path');
  }),
  extendedInventory: vi.fn(),
  review: vi.fn(),
  map: vi.fn(),
  renderModel: vi.fn(),
  setSnapshot: vi.fn(),
  render: vi.fn(),
  dispose: vi.fn(),
  getRepositories: vi.fn(),
}));
vi.mock('../src/lib/segmentation', () => ({ segmentRoom: hooks.segment }));
vi.mock('../src/lib/reconstruction/analysis-client', () => ({
  analyzeScene: hooks.qwen,
  analyzeIdentity: hooks.identity,
  analyzeInstallation: hooks.installation,
  analyzeLayout: hooks.layout,
  analyzeFixtureAppearance: hooks.appearance,
  analyzeExtendedScene: hooks.extendedInventory,
  analyzeShowerInstallations: hooks.showerInstallation,
  validateShowerInstallationRecord: hooks.validateShowerInstallation,
  analyzeDividerMaterials: vi.fn(() => {
    throw new Error('Unexpected optional divider inference on historical path');
  }),
  analyzeShowerDetails: vi.fn(() => {
    throw new Error('Unexpected optional shower inference on historical path');
  }),
  analyzeReflectionRechecks: vi.fn(() => {
    throw new Error('Unexpected optional mirror inference on historical path');
  }),
  prepareReflectionRecheckRequests: vi.fn(() => {
    throw new Error('Unexpected mirror receipt on historical path');
  }),
}));
vi.mock('../src/lib/repositories', () => ({ getRepositories: hooks.getRepositories }));
vi.mock('../src/lib/reconstruction/analysis', async (original) => ({
  ...(await original<typeof import('../src/lib/reconstruction/analysis')>()),
  reviewFromSegmentation: hooks.review,
}));
vi.mock('../src/lib/reconstruction/installation', async (original) => ({
  ...(await original<typeof import('../src/lib/reconstruction/installation')>()),
  inspectReconstructionCandidateMapping: (...args: unknown[]) => ({
    placement: hooks.map(...args),
    reasons: [],
  }),
}));
vi.mock('../src/lib/reconstruction/templates', async (original) => ({
  ...(await original<typeof import('../src/lib/reconstruction/templates')>()),
  renderReconstructionTemplate: hooks.renderModel,
}));
vi.mock('../src/lib/room-background', () => ({
  renderRoomBackground: async () => ({ blob: new Blob(['background'], { type: 'image/png' }) }),
}));
vi.mock('../src/lib/images', async (original) => ({
  ...(await original<typeof import('../src/lib/images')>()),
  canvasBlob: async () => pngOutput(),
  makeAsset: async (blob: Blob, name: string, kind: string) => ({
    id: crypto.randomUUID(),
    ownerId: 'local',
    name,
    kind,
    mime: blob.type,
    size: blob.size,
    blob,
    width: 200,
    height: 200,
    createdAt: new Date().toISOString(),
  }),
  importImage: async (file: File, _kind: string, assets: Repositories['assets']) => {
    const background = file.name === '비교 공간 배경.png';
    const make = (kind: 'original' | 'preview'): ImageAssetRecord => ({
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: file.name,
      kind,
      mime: file.type,
      size: file.size,
      blob: file,
      width: background ? 1600 : 1200,
      height: background ? 1067 : 1000,
      createdAt: new Date().toISOString(),
    });
    const original = make('original'),
      preview = make('preview');
    await assets.put(original);
    await assets.put(preview);
    return { original, preview };
  },
}));
vi.mock('../src/lib/room-fixtures', async (original) => ({
  ...(await original<typeof import('../src/lib/room-fixtures')>()),
  createRoomPlacement: async (material: MaterialVersion, asset: ImageAssetRecord, face: string) => ({
    face,
    u: 0.5,
    v: 0.5,
    scale: 1,
    widthMm: material.widthMm,
    heightMm: material.heightMm,
    imageAspect: asset.width / asset.height,
    contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
  }),
}));
vi.mock('../src/lib/render/compositor', () => ({
  PhotoCompositor: class {
    maxOutputEdge = 4096;
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
import { createReconstructionProject } from '../src/lib/reconstruction/index';
import { runReconstructionLabCase } from '../src/lib/reconstruction/lab';

const file = () => new File(['private user bytes'], 'room.png', { type: 'image/png' });
function rawReview(): ReconstructionReview {
  return {
    version: 2,
    analysis: 'partial',
    warnings: ['untouched baseline evidence'],
    planes: [],
    candidates: [
      {
        id: 'baseline-basin',
        kind: 'basin',
        source: 'deeplab',
        bounds: { left: 0.3, top: 0.3, right: 0.5, bottom: 0.8 },
        foot: { x: 0.4, y: 0.8 },
        color: '#eeeeee',
        pixels: 1200,
        evidence: { semanticPixels: 1200, meanMargin: 3.5 },
        status: 'unplaced',
        installation: {
          mode: 'floor',
          basinVariant: 'pedestal',
          reason: 'observed support',
          source: 'inferred',
        },
      },
    ],
  };
}
function understanding(): SceneUnderstanding {
  return {
    schemaVersion: 1,
    roomLayout: { backWallQuad: null, orthogonal: true, evidence: [], uncertainty: ['missing room corners'] },
    relations: [],
    candidates: [
      {
        id: 'candidate-basin',
        kind: 'basin',
        bounds: { left: 0.3, top: 0.3, right: 0.5, bottom: 0.8 },
        mounting: 'floor',
        wall: 'unknown',
        basinStyle: 'pedestal',
        shape: 'round',
        reflection: 'physical',
        evidence: ['synthetic model response'],
        uncertainty: [],
      },
    ],
  };
}
function model(): LocalSceneAnalysis {
  return {
    understanding: understanding(),
    rawText: '{}',
    modelId: 'qwen3-vl:4b-instruct-q4_K_M',
    modelRevision: 'a'.repeat(64),
    promptRevision: 3,
    measurement: {
      requestMs: 100,
      inputWidth: 1024,
      inputHeight: 853,
      memoryScope: 'mock, not a real measurement',
      modelDownload: 'not-performed-cached-model-required',
    },
  };
}
/** A saved observation fixture, constructed without any retired model execution. */
async function recordedLocalResult() {
  const result = await runReconstructionLabCase(file(), DEFAULT_ROOM);
  const observation = model();
  result.report.pipeline = {
    ...buildCandidatePipeline(observation.understanding, result.report.rawReview!, DEFAULT_ROOM,
      { width: result.report.input.previewWidth, height: result.report.input.previewHeight }).pipeline,
    automaticUnderstanding: structuredClone(observation.understanding),
    model: observation, modelReused: true,
  };
  return result;
}
function repositories() {
  const assets = new Map<string, AssetRecord>(),
    versions = new Map<string, MaterialVersion>();
  const forbidden = vi.fn(async () => {
    throw new Error('persistent writes forbidden');
  });
  const repos = {
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
      put: async (asset: AssetRecord) => {
        assets.set(asset.id, structuredClone(asset));
      },
      get: async (id: string) => structuredClone(assets.get(id)!),
      removeUnused: forbidden,
    },
    materials: {
      create: async (input: MaterialInput) => {
        const value = {
          ...structuredClone(input),
          id: crypto.randomUUID(),
          materialId: crypto.randomUUID(),
          version: 1,
          createdAt: new Date().toISOString(),
        };
        versions.set(value.id, value);
        return structuredClone(value);
      },
      list: async () => [...versions.values()].map((version) => ({ version })),
      getVersion: async (id: string) => structuredClone(versions.get(id)),
      update: forbidden,
      setActive: forbidden,
    },
  } as unknown as Repositories;
  return { repos, assets, versions, forbidden };
}
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
beforeEach(() => {
  vi.clearAllMocks();
  hooks.segment.mockResolvedValue({ width: 2, height: 2 });
  hooks.qwen.mockImplementation(async () => model());
  for (const [name, mock] of Object.entries({
    identity: hooks.identity,
    installation: hooks.installation,
    layout: hooks.layout,
    appearance: hooks.appearance,
    extendedInventory: hooks.extendedInventory,
  })) {
    mock.mockImplementation(() => {
      throw new Error(`Legacy path must not run ${name}`);
    });
  }
  hooks.review.mockImplementation(() => rawReview());
  hooks.map.mockReturnValue({ face: 'floor', u: 0.5, v: 0.5 });
  hooks.renderModel.mockResolvedValue({
    blob: new Blob(['template'], { type: 'image/png' }),
    anchor: { x: 0.5, y: 1 },
  });
  hooks.render.mockImplementation((width: number, height: number) => ({ width, height }));
  hooks.setSnapshot.mockResolvedValue(undefined);
  hooks.getRepositories.mockImplementation(() => {
    throw new Error('must inject disposable repositories');
  });
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 2,
      height: 2,
      getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(16) }) }),
    }),
  });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1200, height: 1000, close: vi.fn() }));
  vi.stubGlobal('indexedDB', {
    open: vi.fn(() => {
      throw new Error('IDB forbidden');
    }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(hooks.identity).not.toHaveBeenCalled();
  expect(hooks.installation).not.toHaveBeenCalled();
  expect(hooks.layout).not.toHaveBeenCalled();
  expect(hooks.appearance).not.toHaveBeenCalled();
  expect(hooks.extendedInventory).not.toHaveBeenCalled();
  expect(hooks.showerInstallation).not.toHaveBeenCalled();
  expect(hooks.validateShowerInstallation).not.toHaveBeenCalled();
});

describe('real project/lab integration with mocked inference and GPU boundaries', () => {
  it('leaves normal project creation on DeepLab and preserves the common camera and empty After', async () => {
    const storage = repositories();
    const project = await createReconstructionProject(file(), DEFAULT_ROOM, { repositories: storage.repos });
    expect(hooks.segment).toHaveBeenCalledOnce();
    expect(hooks.qwen).not.toHaveBeenCalled();
    expect(hooks.identity).not.toHaveBeenCalled();
    expect(hooks.map).toHaveBeenCalledOnce();
    expect(project.shared.comparison!.before.fixtures).toHaveLength(1);
    expect(project.shared.baseline.fixtures).toEqual([]);
    expect(project.designs[0].scene.fixtures).toEqual([]);
    expect(project.shared.comparison!.cameraVersion).toBe(1);
    expect(project.shared.comparison!.before.room).toEqual(project.shared.baseline.room);
    expect(project.shared.comparison!.before.imageWidth).toBe(project.shared.baseline.imageWidth);
    expect(project.shared.comparison!.before.imageHeight).toBe(project.shared.baseline.imageHeight);
    expect(project.shared.baseline.surfaces).toHaveLength(4);
    expect(project.shared.comparison!.before.surfaces.map((surface) => surface.quad)).toEqual(
      project.shared.baseline.surfaces.map((surface) => surface.quad),
    );
    expect([...storage.versions.values()].every((version) => version.pricing === undefined)).toBe(true);
    expect(storage.forbidden).not.toHaveBeenCalled();
    expect(hooks.getRepositories).not.toHaveBeenCalled();
  });
  it('keeps null custom plans held and clones raw/reused review before any generation mutation', async () => {
    const storage = repositories(),
      original = rawReview(),
      copy = structuredClone(original),
      observed: ReconstructionReview[] = [];
    const transform = vi.fn(async (review: ReconstructionReview) => {
      expect(review.warnings).toEqual(copy.warnings);
      return { review, plans: { 'baseline-basin': null } };
    });
    const project = await createReconstructionProject(file(), DEFAULT_ROOM, {
      repositories: storage.repos,
      reuseAnalysis: original,
      onRawReview: (review) => {
        observed.push(review);
        review.warnings.push('callback mutation');
      },
      transformAnalysis: transform,
    });
    expect(hooks.segment).not.toHaveBeenCalled();
    expect(hooks.map).not.toHaveBeenCalled();
    expect(hooks.renderModel).not.toHaveBeenCalled();
    expect(project.shared.comparison!.before.fixtures).toEqual([]);
    expect(project.shared.comparison!.review!.candidates[0]).toMatchObject({ status: 'unplaced' });
    expect(project.shared.comparison!.review!.candidates[0].trace!.at(-1)!.outcome).toBe('held');
    expect(original).toEqual(copy);
    expect(observed).toHaveLength(1);
  });
  it('generates only the explicit standard model while preserving common scene coordinates and source asset references', async () => {
    const storage = repositories();
    const review = rawReview();
    review.candidates[0].kind = 'mirrorCabinet';
    const project = await createReconstructionProject(file(), DEFAULT_ROOM, {
      repositories: storage.repos,
      reuseAnalysis: review,
      transformAnalysis: async (raw) => ({
        review: raw,
        plans: {
          'baseline-basin': {
            kind: 'mirrorCabinet',
            version: 2,
            face: 'back',
            u: 0.5,
            v: 0.5,
            baseHeightMm: 1200,
            widthMm: 800,
            heightMm: 700,
            depthMm: 150,
            doorCount: 2,
          },
        },
      }),
    });
    const fixture = project.shared.comparison!.before.fixtures[0];
    expect(fixture.reconstruction).toMatchObject({
      version: 2,
      kind: 'mirrorCabinet',
      doorCount: 2,
      baseHeightMm: 1200,
    });
    expect(fixture.reconstruction!.appearanceAssetId).toBeUndefined();
    expect(project.shared.baseline.fixtures).toEqual([]);
    expect(storage.assets.has(project.shared.comparison!.referenceOriginalAssetId)).toBe(true);
    expect(storage.assets.has(project.shared.comparison!.referencePreviewAssetId)).toBe(true);
    expect(review.candidates[0].fixtureId).toBeUndefined();
  });
  it('rejects new retired candidate inference without local or cloud calls', async () => {
    await expect(runReconstructionLabCase(file(), DEFAULT_ROOM, {
      engine: 'candidate', candidateProfile: 'legacy-inventory',
    })).rejects.toThrow('종료');
    expect(hooks.qwen).not.toHaveBeenCalled();
    expect(hooks.extendedInventory).not.toHaveBeenCalled();
    expect(hooks.setSnapshot).not.toHaveBeenCalled();
    expect(hooks.getRepositories).not.toHaveBeenCalled();
  });
  it('reuses immutable model and raw analysis for manual correction without another AI call', async () => {
    const first = await recordedLocalResult();
    const firstCopy = structuredClone(first.report),
      corrected = structuredClone(first.report.pipeline!.understanding);
    corrected.candidates[0].shape = 'rectangular';
    corrected.candidates[0].provenance = { shape: 'user' };
    const second = await runReconstructionLabCase(file(), DEFAULT_ROOM, {
      engine: 'candidate',
      candidateProfile: 'legacy-inventory',
      reuseReport: first.report,
      understandingOverride: corrected,
      manualPlacements: {
        'candidate-basin': { face: 'floor', u: 0.5, v: 0.5, baseHeightMm: 0, widthMm: 650 },
      },
    });
    expect(hooks.segment).toHaveBeenCalledOnce();
    expect(hooks.qwen).not.toHaveBeenCalled();
    expect(hooks.identity).not.toHaveBeenCalled();
    expect(second.report.correctionOfRunId).toBe(first.report.runId);
    expect(second.report.fixtures).toHaveLength(1);
    expect(second.projectBundle?.document.shared.comparison?.before.fixtures).toEqual(second.report.fixtures);
    expect(second.projectBundle?.document.designs[0].scene.fixtures).toEqual([]);
    const capturedVersion = second.projectBundle?.versions.find(
      (version) => version.id === second.report.fixtures[0].materialVersionId,
    );
    expect(capturedVersion).toBeDefined();
    expect(second.projectBundle?.assets.some((asset) => asset.id === capturedVersion?.views[0].assetId)).toBe(
      true,
    );
    expect(second.projectBundle?.runId).not.toBe(first.projectBundle?.runId);
    expect(second.report.fixtures[0].reconstruction).toMatchObject({
      basinShape: 'rectangular',
      widthMm: 650,
      provenance: { shape: 'user', position: 'user', dimensions: 'user' },
    });
    expect(second.report.pipeline!.automaticUnderstanding.candidates[0].shape).toBe('round');
    expect(second.report.pipeline!.understanding.candidates[0].shape).toBe('rectangular');
    expect(first.report).toEqual(firstCopy);
    second.report.pipeline!.baselineReview.warnings.push('new report mutation');
    expect(first.report.rawReview!.warnings).toEqual(firstCopy.rawReview!.warnings);
    expect((hooks.setSnapshot.mock.calls[1][0] as RenderSnapshot).scene.fixtures).toEqual([]);
    expect(hooks.dispose).toHaveBeenCalledTimes(2);
    expect(indexedDB.open).toHaveBeenCalledWith('sjn-reconstruction-diagnostics', 1);
    expect(
      vi.mocked(indexedDB.open).mock.calls.every(([name]) => name === 'sjn-reconstruction-diagnostics'),
    ).toBe(true);
  });
  it('rejects reuse for a different photograph or room before invoking any new analysis', async () => {
    const first = await recordedLocalResult();
    await expect(
      runReconstructionLabCase(new File(['different'], 'room.png'), DEFAULT_ROOM, {
        engine: 'candidate',
        candidateProfile: 'legacy-inventory',
        reuseReport: first.report,
      }),
    ).rejects.toThrow('사진·공간');
    await expect(
      runReconstructionLabCase(
        file(),
        { ...DEFAULT_ROOM, widthMm: 3000 },
        { engine: 'candidate', candidateProfile: 'legacy-inventory', reuseReport: first.report },
      ),
    ).rejects.toThrow('사진·공간');
    expect(hooks.segment).toHaveBeenCalledOnce();
    expect(hooks.qwen).not.toHaveBeenCalled();
    expect(hooks.identity).not.toHaveBeenCalled();
  });
  it('honors cancellation before a retired candidate can run', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runReconstructionLabCase(file(), DEFAULT_ROOM, {
      engine: 'candidate', candidateProfile: 'legacy-inventory', signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(hooks.qwen).not.toHaveBeenCalled();
    expect(hooks.setSnapshot).not.toHaveBeenCalled();
    expect(hooks.renderModel).not.toHaveBeenCalled();
  });

});

it('holds an invalid custom photo plan unchanged while creating an independent valid plan', async () => {
  const storage = repositories(),
    review = rawReview();
  review.candidates.push({ ...structuredClone(review.candidates[0]), id: 'second', kind: 'toilet' });
  const untouched = structuredClone(review);
  const project = await createReconstructionProject(file(), DEFAULT_ROOM, {
    repositories: storage.repos,
    reuseAnalysis: review,
    transformAnalysis: async (raw) => ({
      review: raw,
      plans: {
        'baseline-basin': {
          kind: 'basin',
          basinVariant: 'wall',
          version: 2,
          face: 'back',
          u: 0.01,
          v: 0.5,
          baseHeightMm: 1200,
          widthMm: 3100,
          heightMm: 180,
          depthMm: 420,
          provenance: { width: 'user', dimensions: 'user' },
        },
        second: {
          kind: 'toilet',
          version: 2,
          face: 'floor',
          u: 0.48,
          v: 0.64,
          widthMm: 411,
          heightMm: 805,
          depthMm: 690,
          baseHeightMm: 0,
        },
      },
    }),
  });
  expect(project.shared.comparison!.before.fixtures).toHaveLength(1);
  const held = project.shared.comparison!.review!.candidates[0];
  expect(held).toMatchObject({
    status: 'unplaced',
    requiresReview: true,
    placementReview: {
      status: 'held',
      requested: { u: 0.01, widthMm: 3100, baseHeightMm: 1200, provenance: { width: 'user' } },
    },
  });
  expect(held.fixtureId).toBeUndefined();
  expect(held.trace!.at(-1)!.outcome).toBe('held');
  const placed = project.shared.comparison!.before.fixtures[0];
  expect(placed.roomPlacement).toMatchObject({ u: 0.48, v: 0.64, scale: 1 });
  expect(placed.reconstruction).toMatchObject({
    widthMm: 411,
    heightMm: 805,
    depthMm: 690,
    placementPolicy: 'preserve',
  });
  expect(review).toEqual(untouched);
  expect(hooks.segment).not.toHaveBeenCalled();
  expect(hooks.qwen).not.toHaveBeenCalled();
});
