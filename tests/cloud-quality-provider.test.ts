import { resolveClassificationConflicts } from '../src/lib/reconstruction/classification-resolution';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import { parseCloudGemmaExtendedInventory } from '../src/lib/reconstruction/cloud-gemma-coordinates';
import {
  INSTALLATION_OUTPUT_CONTRACT,
  INSTALLATION_PROMPT_REVISION,
  parseInstallationObservation,
} from '../src/lib/reconstruction/installation-observation';
import {
  LAYOUT_OUTPUT_CONTRACT,
  LAYOUT_PROMPT_REVISION,
  parseLayoutObservation,
} from '../src/lib/reconstruction/layout-observation';
import {
  SHOWER_OBSERVATION_CONTRACT,
  SHOWER_OBSERVATION_PROMPT_REVISION,
  parseShowerObservation,
} from '../src/lib/reconstruction/shower-observation';
import {
  SHOWER_INSTALLATION_DECISION_REVISION,
  type ShowerInstallationRecord,
} from '../src/lib/reconstruction/shower-installation-observation';
import { validateShowerInstallationRecord } from '../src/lib/reconstruction/analysis-client';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
vi.mock('../src/lib/reconstruction/analysis-client', async (original) => ({
  ...(await original<typeof import('../src/lib/reconstruction/analysis-client')>()),
  // Receipt/raw/parser validity is exercised by the independent client test file. This is orchestration only.
  validateShowerInstallationRecord: vi.fn(async (value) => structuredClone(value)),
}));
import { CLOUD_GEMMA_APPEARANCE_METADATA } from '../src/lib/reconstruction/cloud-gemma-appearance';
import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
  parseFixtureAppearance,
} from '../src/lib/reconstruction/fixture-appearance-observation';
import { CLOUD_GEMMA_GROUPED_INVENTORY_METADATA } from '../src/lib/reconstruction/cloud-gemma-inventory';
import { cloudOperationCacheIdentity } from '../src/lib/reconstruction/cloud-gemma-cache-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_REVISION,
  CLOUD_GEMMA_IDENTITY,
} from '../src/lib/reconstruction/cloud-gemma-contract';
import { LAB_QWEN_MODEL } from '../src/lib/reconstruction/lab-engine';
import {
  validAnalysisModelPair,
  validAnalysisResponse,
  providerForModel,
} from '../src/lib/reconstruction/analysis-provider';
import {
  CLOUD_BROWSER_QUALITY_REVISION,
  LOCAL_QUALITY_REVISION,
  type ReconstructionQualityEvidence,
} from '../src/lib/reconstruction/quality-contract';
import {
  runQualityPipeline,
  photoFingerprint,
  type QualityDependencies,
  type QualityRunInput,
} from '../src/lib/reconstruction/quality-core';
import {
  BROWSER_GEOMETRY_REVISION,
  LOCAL_GEOMETRY_MODEL,
  LOCAL_GEOMETRY_MODEL_REVISION,
  LOCAL_GEOMETRY_REVISION,
  type LocalGeometryAnalysis,
} from '../src/lib/reconstruction/geometry-contract';
import {
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';
import { skippedIdentityAnalysis } from '../src/lib/reconstruction/identity-observation';
import { skippedInstallationAnalysis } from '../src/lib/reconstruction/installation-observation';
import {
  MOGE_ARTIFACT,
  MOGE_PREPROCESS_VERSION,
  MOGE_NUM_TOKENS,
  MOGE_RUNTIME_VERSION,
} from '../src/lib/reconstruction/moge-browser/artifact';
import { MOGE_POSTPROCESS_VERSION } from '../src/lib/reconstruction/moge-browser/postprocess';
import { MOGE_PLANES_VERSION } from '../src/lib/reconstruction/moge-browser/planes';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';

vi.mock('../src/lib/reconstruction/candidate-pipeline', () => ({
  buildCandidatePipeline: vi.fn((understanding, baseline) => ({
    review: structuredClone(baseline),
    plans: {},
    pipeline: {
      understanding,
      automaticUnderstanding: understanding,
      camera: { status: 'held', reasons: ['mock boundary'] },
    },
  })),
}));
vi.mock('../src/lib/reconstruction/estimated-layout', () => ({
  ESTIMATED_LAYOUT_REVISION: 'test-only-placement',
  buildEstimatedCandidatePipeline: vi.fn(({ strictResult }) => strictResult),
}));
const cloudMetadata = () => ({
  provider: 'cloudflare-workers-ai' as const,
  modelId: CLOUD_GEMMA_MODEL,
  modelRevision: CLOUD_GEMMA_REVISION,
  modelIdentity: { ...CLOUD_GEMMA_IDENTITY },
});
beforeEach(() => vi.clearAllMocks());

describe('provider identity contracts (authored fixtures, not actual model inference)', () => {
  it('accepts genuine provider forms and never reinterprets an Ollama digest as Gemma weights', () => {
    expect(validAnalysisModelPair(LAB_QWEN_MODEL, 'a'.repeat(64))).toBe(true);
    expect(validAnalysisModelPair(CLOUD_GEMMA_MODEL, CLOUD_GEMMA_REVISION)).toBe(true);
    expect(validAnalysisModelPair(CLOUD_GEMMA_MODEL, 'a'.repeat(64))).toBe(false);
    expect(validAnalysisModelPair(LAB_QWEN_MODEL, CLOUD_GEMMA_REVISION)).toBe(false);
    expect(validAnalysisModelPair('other-model', CLOUD_GEMMA_REVISION)).toBe(false);
    expect(providerForModel(CLOUD_GEMMA_MODEL)).toBe('cloudflare-workers-ai');
    expect(() => providerForModel('unknown')).toThrow();
    expect(CLOUD_GEMMA_IDENTITY.revisionKind).toBe('provider-managed');
  });
  it.each([
    { provider: 'local-ollama' },
    { modelId: LAB_QWEN_MODEL },
    { modelRevision: 'a'.repeat(64) },
    { modelIdentity: undefined },
    { modelIdentity: { ...CLOUD_GEMMA_IDENTITY, contractRevision: 'obsolete' } },
    { modelIdentity: { ...CLOUD_GEMMA_IDENTITY, revisionKind: 'weights-sha256' } },
    { modelIdentity: { ...CLOUD_GEMMA_IDENTITY, modelId: LAB_QWEN_MODEL } },
  ])('rejects incorrect provider metadata %j', (mutation) => {
    expect(validAnalysisResponse({ ...cloudMetadata(), ...mutation }, 'cloudflare-workers-ai')).toBe(false);
  });
  it('keeps historical local records valid without requiring cloud fields', () => {
    expect(
      validAnalysisResponse({ modelId: LAB_QWEN_MODEL, modelRevision: 'a'.repeat(64) }, 'local-ollama'),
    ).toBe(true);
    expect(validAnalysisResponse(cloudMetadata(), 'cloudflare-workers-ai')).toBe(true);
    expect(validAnalysisResponse(cloudMetadata(), 'local-ollama')).toBe(false);
  });
});

async function fixture(cloud = true) {
  const photo = new Blob(['same-normalized-photo-for-profile-boundary'], { type: 'image/png' });
  const fingerprint = await photoFingerprint(photo);
  const understanding = parseFixtureInventory(
    '{"items":[]}',
    EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  ).understanding;
  const model = cloud ? cloudMetadata() : { modelId: LAB_QWEN_MODEL, modelRevision: 'b'.repeat(64) };
  const input: QualityRunInput = {
    profile: cloud ? 'cloud-browser-v1' : 'local-quality-v1',
    photo,
    image: { width: 400, height: 300 },
    room: DEFAULT_ROOM,
    inputFingerprint: fingerprint,
    signal: new AbortController().signal,
    baseline: { version: 2, analysis: 'complete', candidates: [], planes: [], warnings: [] },
    segmentation: { width: 8, height: 8, floor: new Uint8Array(64), wall: new Uint8Array(64) },
  };
  const geometry: LocalGeometryAnalysis = {
    inputFingerprint: fingerprint,
    observation: {
      version: 1,
      inputFingerprint: fingerprint,
      image: input.image,
      model: cloud
        ? { id: MOGE_ARTIFACT.repository, revision: MOGE_ARTIFACT.revision }
        : { id: LOCAL_GEOMETRY_MODEL, revision: LOCAL_GEOMETRY_MODEL_REVISION },
      coordinateSystem: 'opencv-camera',
      scale: 'model-estimated-metres',
      intrinsics: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
      floor: null,
      walls: [],
    },
    measurement: {
      requestMs: 1,
      modelLoadMs: 1,
      inferenceMs: 1,
      planeExtractionMs: 1,
      cacheHit: false,
      modelCacheHit: true,
      modelDownload: cloud ? 'cache' : 'not-performed-cached-model-required',
      memoryScope: 'Mock geometry; no model was run',
      ...(cloud
        ? {
            backend: 'wasm' as const,
            wasmThreads: 1,
            downloadMs: 0,
            cacheMs: 1,
            preprocessingMs: 1,
            postprocessingMs: 1,
          }
        : {}),
    },
    evidence: cloud
      ? {
          revision: BROWSER_GEOMETRY_REVISION,
          artifactSha256: MOGE_ARTIFACT.sha256,
          preprocessRevision: MOGE_PREPROCESS_VERSION,
          postprocessRevision: MOGE_POSTPROCESS_VERSION,
          planeAlgorithmRevision: MOGE_PLANES_VERSION,
          precision: 'fp32',
          numTokens: MOGE_NUM_TOKENS,
          inputWidth: 400,
          inputHeight: 300,
          runtimeVersion: MOGE_RUNTIME_VERSION,
        }
      : { revision: LOCAL_GEOMETRY_REVISION },
  };
  const dependencies: QualityDependencies = {
    inventory: vi.fn().mockResolvedValue({
      ...model,
      ...(cloud ? CLOUD_GEMMA_GROUPED_INVENTORY_METADATA : {}),
      outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
      promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
      rawText: cloud
        ? JSON.stringify({
            sanitary: [],
            mirrors_storage: [],
            partitions: [],
            showers_shelves: [],
            openings: [],
          })
        : '{"items":[]}',
      understanding,
      measurement: {
        requestMs: 1,
        inputWidth: 400,
        inputHeight: 300,
        memoryScope: 'Mock Gemma/Ollama boundary',
        modelDownload: cloud ? 'provider-managed' : 'not-performed-cached-model-required',
      },
    }),
    identity: vi
      .fn()
      .mockResolvedValue({ ...skippedIdentityAnalysis(understanding), ...model, modelRevision: null }),
    installation: vi
      .fn()
      .mockResolvedValue({ ...skippedInstallationAnalysis(understanding), ...model, modelRevision: null }),
    geometry: vi.fn().mockResolvedValue(geometry),
    segmentation: vi.fn().mockResolvedValue(input.segmentation),
  };
  return { input, dependencies, geometry };
}
function noInference(deps: QualityDependencies) {
  expect(deps.inventory).not.toHaveBeenCalled();
  expect(deps.identity).not.toHaveBeenCalled();
  expect(deps.installation).not.toHaveBeenCalled();
  expect(deps.geometry).not.toHaveBeenCalled();
}
describe('common quality engine profile isolation (mock observations and placement)', () => {
  it('labels a validated cloud/browser result with the cloud revision and reuses only that same contract', async () => {
    const { input, dependencies } = await fixture();
    const first = await runQualityPipeline(input, dependencies);
    expect(first.review.analysisProfile).toBe('cloud-browser-v1');
    expect(first.review.analysisSummary).toMatchObject({
      profile: 'cloud-browser-v1',
      revision: CLOUD_BROWSER_QUALITY_REVISION,
      modelId: CLOUD_GEMMA_MODEL,
      geometryModelId: MOGE_ARTIFACT.repository,
    });
    expect(first.evidence.revision).toBe(CLOUD_BROWSER_QUALITY_REVISION);
    vi.clearAllMocks();
    const second = await runQualityPipeline({ ...input, reuse: first.evidence }, dependencies);
    expect(second.evidence.reused).toBe(true);
    noInference(dependencies);
  });
  it.each([true, false])(
    'refuses cross-profile cached evidence without running AI again (cloud=%s)',
    async (cloud) => {
      const { input, dependencies } = await fixture(cloud);
      const previous = await runQualityPipeline(input, dependencies);
      vi.clearAllMocks();
      await expect(
        runQualityPipeline(
          { ...input, profile: cloud ? 'local-quality-v1' : 'cloud-browser-v1', reuse: previous.evidence },
          dependencies,
        ),
      ).rejects.toThrow('재사용');
      noInference(dependencies);
      expect(buildCandidatePipeline).not.toHaveBeenCalled();
    },
  );
  it('rejects local model observations in a newly requested cloud profile before more model calls', async () => {
    const { input, dependencies } = await fixture(false);
    await expect(runQualityPipeline({ ...input, profile: 'cloud-browser-v1' }, dependencies)).rejects.toThrow();
    expect(dependencies.identity).not.toHaveBeenCalled();
    expect(dependencies.geometry).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
  it('rejects Python geometry even when its photo hash matches a fresh cloud profile', async () => {
    const { input, dependencies } = await fixture();
    const local = await fixture(false);
    vi.mocked(dependencies.geometry).mockResolvedValue(local.geometry);
    await expect(runQualityPipeline(input, dependencies)).rejects.toThrow();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
  it.each<[string, (e: ReconstructionQualityEvidence) => void]>([
    [
      'missing grouped protocol',
      (e) => {
        delete e.inventory.providerInventoryContract;
      },
    ],
    [
      'obsolete grouped schema',
      (e) => {
        e.inventory.providerInventorySchemaRevision = 0;
      },
    ],
    [
      'obsolete grouped transform',
      (e) => {
        e.inventory.providerInventoryTransform = 'old';
      },
    ],
    [
      'historical flat provider raw text',
      (e) => {
        e.inventory.rawText = '{"items":[]}';
      },
    ],
    [
      'raw observation mismatch',
      (e) => {
        const raw = JSON.parse(e.inventory.rawText);
        raw.openings.push({
          kind: 'window',
          bbox_2d: [100, 200, 300, 400],
          view: 'direct',
          basin: null,
          note: 'Synthetic visible opening',
        });
        e.inventory.rawText = JSON.stringify(raw);
      },
    ],
    [
      'provider metadata',
      (e) => {
        Object.assign(e.inventory, { provider: 'local-ollama' });
      },
    ],
    [
      'missing managed model identity',
      (e) => {
        Object.assign(e.inventory, { modelIdentity: undefined });
      },
    ],
    [
      'managed API contract revision',
      (e) => {
        Object.assign(e.inventory, {
          modelIdentity: { ...CLOUD_GEMMA_IDENTITY, contractRevision: 'obsolete' },
        });
      },
    ],
    [
      'provider revision',
      (e) => {
        e.inventory.modelRevision = 'a'.repeat(64);
      },
    ],
    [
      'Python geometry',
      (e) => {
        e.geometry.observation.model.id = LOCAL_GEOMETRY_MODEL;
      },
    ],
    [
      'artifact digest',
      (e) => {
        e.geometry.evidence.artifactSha256 = 'a'.repeat(64);
      },
    ],
    [
      'precision',
      (e) => {
        e.geometry.evidence.precision = 'fp16';
      },
    ],
    [
      'token count',
      (e) => {
        e.geometry.evidence.numTokens = 999;
      },
    ],
    [
      'preprocess revision',
      (e) => {
        e.geometry.evidence.preprocessRevision = 'obsolete';
      },
    ],
    [
      'postprocess revision',
      (e) => {
        e.geometry.evidence.postprocessRevision = 'obsolete';
      },
    ],
    [
      'plane algorithm revision',
      (e) => {
        e.geometry.evidence.planeAlgorithmRevision = 'obsolete';
      },
    ],
    [
      'profile revision',
      (e) => {
        e.revision = LOCAL_QUALITY_REVISION;
      },
    ],
  ])('rejects cached %s mismatch without fresh analysis', async (_name, mutate) => {
    const { input, dependencies } = await fixture();
    const first = await runQualityPipeline(input, dependencies);
    mutate(first.evidence);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: first.evidence }, dependencies)).rejects.toThrow(
      '재사용',
    );
    noInference(dependencies);
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
});

describe('stage cache prompt identity', () => {
  it('separates inventory versions and pins the executed prompt and provider API contract', () => {
    const simple = cloudOperationCacheIdentity('inventory');
    const extended = cloudOperationCacheIdentity('inventory-extended');
    expect(simple).not.toBe(extended);
    expect(JSON.parse(extended)).toMatchObject({
      modelId: CLOUD_GEMMA_MODEL,
      modelRevision: CLOUD_GEMMA_REVISION,
      ...CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
      outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
      promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
      settings: { max_completion_tokens: 4096, enable_thinking: false },
    });
    expect(
      new Set(
        [
          'inventory',
          'inventory-extended',
          'identity',
          'installation',
          'layout',
          'appearance',
          'shower-detail',
          'divider-material',
          'target-existence',
        ].map(cloudOperationCacheIdentity),
      ).size,
    ).toBe(9);
  });
  it('does not treat unknown or inherited object properties as valid analysis stages', () => {
    for (const operation of [null, 'other', '__proto__', 'toString'])
      expect(() => cloudOperationCacheIdentity(operation)).toThrow();
  });
});

it.each([true, false])('passes the actual provider into candidate provenance (cloud=%s)', async (cloud) => {
  const { input, dependencies } = await fixture(cloud);
  await runQualityPipeline(input, dependencies);
  expect(vi.mocked(buildCandidatePipeline).mock.calls[0][12]).toBe(cloud ? 'gemma' : 'qwen');
});

it('reuses a historical local inventory without cloud identity metadata', async () => {
  const { input, dependencies } = await fixture(false);
  const first = await runQualityPipeline(input, dependencies);
  expect(first.evidence.inventory).not.toHaveProperty('modelIdentity');
  vi.clearAllMocks();
  const restored = await runQualityPipeline({ ...input, reuse: first.evidence }, dependencies);
  expect(restored.evidence.reused).toBe(true);
  noInference(dependencies);
});

async function evidenceWithAppearance(cloud = true) {
  const { input, dependencies } = await fixture(cloud);
  const first = await runQualityPipeline(input, dependencies);
  const rawText = JSON.stringify({ schemaVersion: 1, observations: [] });
  first.evidence.appearance = {
    ...first.evidence.inventory,
    ...(cloud ? CLOUD_GEMMA_APPEARANCE_METADATA : {}),
    ...parseFixtureAppearance(rawText, first.evidence.installation.understanding),
    outputContract: FIXTURE_APPEARANCE_CONTRACT,
    promptRevision: FIXTURE_APPEARANCE_PROMPT_REVISION,
    rawText,
    photoFingerprint: first.evidence.photoFingerprint,
  };
  if (cloud)
    first.evidence.classificationResolution = resolveClassificationConflicts({
      appearance: first.evidence.appearance,
      effective: first.evidence.effectiveUnderstanding,
      protectedCandidateIds: new Set(),
    }).record;
  vi.clearAllMocks();
  return { input: { ...input, estimatedLayout: true, reuse: first.evidence }, dependencies };
}

it.each([true, false])(
  'reuses current cloud appearance or historical Qwen without changing inventory/geometry (cloud=%s)',
  async (cloud) => {
    const { input, dependencies } = await evidenceWithAppearance(cloud);
    const preserved = structuredClone(input.reuse);
    const reused = await runQualityPipeline(input, dependencies);
    expect(reused.evidence.reused).toBe(true);
    expect(reused.evidence.inventory).toEqual(preserved.inventory);
    expect(reused.evidence.geometry).toEqual(preserved.geometry);
    expect(reused.evidence.appearance).toEqual(preserved.appearance);
    expect(input.reuse).toEqual(preserved);
    if (!cloud) expect(reused.evidence.appearance).not.toHaveProperty('providerAppearanceContract');
    noInference(dependencies);
  },
);

it.each([
  { providerAppearanceContract: undefined },
  { providerAppearanceContract: 'obsolete' },
  { providerAppearancePromptRevision: undefined },
  { providerAppearancePromptRevision: 1 },
])(
  'rejects stale v7 appearance during whole-quality reuse without deleting evidence or rerunning AI: %j',
  async (mutation) => {
    const { input, dependencies } = await evidenceWithAppearance();
    for (const [key, value] of Object.entries(mutation)) {
      if (value === undefined) delete (input.reuse.appearance as unknown as Record<string, unknown>)[key];
      else Object.assign(input.reuse.appearance!, { [key]: value });
    }
    const preserved = structuredClone(input.reuse);
    await expect(runQualityPipeline(input, dependencies)).rejects.toThrow('재사용');
    expect(input.reuse).toEqual(preserved);
    noInference(dependencies);
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  },
);

async function installednessFixture() {
  const { input, dependencies } = await fixture();
  input.estimatedLayout = true;
  input.refineShowerDetails = true;
  const seed = await dependencies.inventory(input.photo, input.signal);
  const rawText = JSON.stringify({
    sanitary: [],
    mirrors_storage: [],
    partitions: [],
    openings: [],
    showers_shelves: [
      {
        kind: 'shower',
        bbox_2d: [200, 200, 700, 600],
        view: 'direct',
        basin: null,
        note: 'Authored fixture for orchestration boundary',
      },
    ],
  });
  const inventory = {
    ...seed,
    rawText,
    ...parseCloudGemmaExtendedInventory({ ...seed, ...CLOUD_GEMMA_GROUPED_INVENTORY_METADATA, rawText }),
  };
  vi.mocked(dependencies.inventory).mockResolvedValue(inventory);
  dependencies.identity = vi.fn(async (_photo: Blob, scene: SceneUnderstanding) => ({
    ...skippedIdentityAnalysis(scene),
    ...cloudMetadata(),
    modelRevision: null,
  }));
  dependencies.installation = vi.fn(async (_photo: Blob, scene: SceneUnderstanding) => {
    const text = JSON.stringify({
      observations: scene.candidates.map(({ id }) => ({
        id,
        lower_support: 'whole_fixture_suspended_with_gap',
        wall_connection: 'visible_joint',
        note: 'Authored direct wall attachment',
      })),
    });
    return {
      ...inventory,
      ...parseInstallationObservation(text, scene, INSTALLATION_OUTPUT_CONTRACT),
      rawText: text,
      outputContract: INSTALLATION_OUTPUT_CONTRACT,
      promptRevision: INSTALLATION_PROMPT_REVISION,
    };
  });
  dependencies.showerDetails = vi.fn(async (_photo: Blob, scene: SceneUnderstanding) => {
    const text = JSON.stringify({
      schemaVersion: 1,
      observations: scene.candidates.map(({ id }) => ({
        id,
        kind: 'shower',
        context: 'physical',
        style: 'hand-spray',
        observedPart: 'handset',
        note: 'Authored visible handset; independent installedness may disagree',
        visibleParts: {
          handheldHead: 'present',
          overheadHead: 'absent',
          verticalRail: 'absent',
          hose: 'present',
        },
      })),
    });
    return {
      ...inventory,
      ...parseShowerObservation(text, scene),
      rawText: text,
      outputContract: SHOWER_OBSERVATION_CONTRACT,
      promptRevision: SHOWER_OBSERVATION_PROMPT_REVISION,
      photoFingerprint: await photoFingerprint(input.photo),
      modelInputSha256: 'a'.repeat(64),
    };
  });
  dependencies.layout = vi.fn(async (_photo: Blob, scene: SceneUnderstanding) => ({
    ...inventory,
    ...parseLayoutObservation('{"observations":[],"relations":[]}', scene),
    rawText: '{"observations":[],"relations":[]}',
    outputContract: LAYOUT_OUTPUT_CONTRACT,
    promptRevision: LAYOUT_PROMPT_REVISION,
    photoFingerprint: await photoFingerprint(input.photo),
  }));
  dependencies.showerInstallation = vi.fn(async (_photo, context) => ({
    record: {
      version: 1,
      decisionRevision: SHOWER_INSTALLATION_DECISION_REVISION,
      photoFingerprint: await photoFingerprint(input.photo),
      sourceDecisionSignature: context.sourceDecisionSignature,
      modelId: CLOUD_GEMMA_MODEL,
      modelRevision: CLOUD_GEMMA_REVISION,
      requests: [],
      observations: [],
      decisions: [],
      protectedCandidateIds: [...context.protectedCandidateIds].sort(),
    } satisfies ShowerInstallationRecord,
    measurements: [],
  }));
  vi.clearAllMocks();
  return { input, dependencies };
}

describe('installedness quality orchestration (mock inference/receipt boundary, actual upstream parsers)', () => {
  it('runs after shower detail and before layout, exposes extra stage cost and binds prior raw evidence', async () => {
    const { input, dependencies } = await installednessFixture();
    const stages = vi.fn(),
      checkpoints = vi.fn();
    const result = await runQualityPipeline(
      { ...input, refineShowerInstallation: true, onStage: stages, onCheckpoint: checkpoints },
      dependencies,
    );
    expect(dependencies.showerInstallation).toHaveBeenCalledOnce();
    expect(vi.mocked(dependencies.showerDetails!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.showerInstallation!).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(dependencies.showerInstallation!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.layout!).mock.invocationCallOrder[0],
    );
    const context = vi.mocked(dependencies.showerInstallation!).mock.calls[0][1];
    expect(JSON.parse(context.sourceDecisionSignature)).toMatchObject({
      understanding: result.evidence.effectiveUnderstanding,
      showerDetails: { rawText: result.evidence.showerDetails?.rawText },
    });
    expect(stages).toHaveBeenCalledWith(expect.stringContaining('대상별 AI 관측 1단계 추가'));
    expect(checkpoints).toHaveBeenCalledWith(
      'showerInstallationResponse',
      result.evidence.showerInstallation,
    );
    expect(buildEstimatedCandidatePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ showerInstallationDecisions: result.evidence.showerInstallation?.decisions }),
    );
    expect(result.evidence.timing.showerInstallationMs).toBeGreaterThanOrEqual(0);
  });
  it('revalidates current saved observations with no implicit new inference', async () => {
    const { input, dependencies } = await installednessFixture();
    const first = await runQualityPipeline({ ...input, refineShowerInstallation: true }, dependencies);
    vi.clearAllMocks();
    const second = await runQualityPipeline(
      { ...input, refineShowerInstallation: true, reuse: first.evidence },
      dependencies,
    );
    expect(second.evidence.showerInstallation).toEqual(first.evidence.showerInstallation);
    expect(validateShowerInstallationRecord).toHaveBeenCalled();
    noInference(dependencies);
    expect(dependencies.showerInstallation).not.toHaveBeenCalled();
  });
  it('preserves legacy evidence but refuses to trust it as a completed new installation stage', async () => {
    const { input, dependencies } = await installednessFixture();
    const previous = await runQualityPipeline(input, dependencies),
      preserved = structuredClone(previous.evidence);
    expect(previous.evidence.showerInstallation).toBeUndefined();
    vi.clearAllMocks();
    await expect(
      runQualityPipeline({ ...input, refineShowerInstallation: true, reuse: previous.evidence }, dependencies),
    ).rejects.toThrow('AI를 자동 실행하지 않았어요');
    expect(previous.evidence).toEqual(preserved);
    noInference(dependencies);
    expect(dependencies.showerInstallation).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
  });
  it.each(['error', 'abort'] as const)(
    'does not place or run layout after installedness %s',
    async (mode) => {
      const { input, dependencies } = await installednessFixture(),
        controller = new AbortController();
      const original = dependencies.showerInstallation!;
      dependencies.showerInstallation = vi.fn(
        async (...args: Parameters<NonNullable<QualityDependencies['showerInstallation']>>) => {
          if (mode === 'error') throw new Error('Authored independent stage failure');
          const result = await original(...args);
          controller.abort();
          return result;
        },
      );
      await expect(
        runQualityPipeline(
          { ...input, signal: controller.signal, refineShowerInstallation: true },
          dependencies,
        ),
      ).rejects.toThrow();
      expect(dependencies.layout).not.toHaveBeenCalled();
      expect(buildCandidatePipeline).not.toHaveBeenCalled();
    },
  );
});

it.each(['missing', 'tampered'] as const)(
  'rejects %s classification evidence without silently rerunning cloud AI',
  async (mode) => {
    const { input, dependencies } = await evidenceWithAppearance();
    if (mode === 'missing') delete input.reuse.classificationResolution;
    else Object.assign(input.reuse.classificationResolution!, { revision: 'obsolete-policy' });
    const preserved = structuredClone(input.reuse);
    await expect(runQualityPipeline(input, dependencies)).rejects.toThrow('종류 충돌');
    expect(input.reuse).toEqual(preserved);
    noInference(dependencies);
  },
);
