import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import {
  LAYOUT_OUTPUT_CONTRACT,
  LAYOUT_PROMPT_REVISION,
  parseLayoutObservation,
} from '../src/lib/reconstruction/layout-observation';
vi.mock('../src/lib/reconstruction/estimated-layout', () => ({
  ESTIMATED_LAYOUT_REVISION: 'test-layout-revision',
  buildEstimatedCandidatePipeline: vi.fn(({ strictResult }) => ({
    ...strictResult,
    pipeline: { ...strictResult.pipeline, estimatedLayout: { revision: 'test-layout-revision' } },
  })),
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { QualityDependencies, QualityRunInput } from '../src/lib/reconstruction/quality-core';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { LAB_QWEN_MODEL, LAB_QWEN_PROMPT_REVISION } from '../src/lib/reconstruction/lab-engine';
import {
  INVENTORY_OUTPUT_CONTRACT,
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';
import {
  INSTALLATION_OUTPUT_CONTRACT,
  INSTALLATION_V1_OUTPUT_CONTRACT,
  INSTALLATION_PROMPT_REVISION,
  parseInstallationObservation,
  skippedInstallationAnalysis,
} from '../src/lib/reconstruction/installation-observation';
import {
  LOCAL_GEOMETRY_MODEL,
  LOCAL_GEOMETRY_MODEL_REVISION,
  LOCAL_GEOMETRY_REVISION,
  type LocalGeometryAnalysis,
} from '../src/lib/reconstruction/geometry-contract';
import {
  IDENTITY_OUTPUT_CONTRACT,
  IDENTITY_PROMPT_REVISION,
  IDENTITY_RULE_REVISION,
  parseIdentityObservation,
  skippedIdentityAnalysis,
} from '../src/lib/reconstruction/identity-observation';
import type { ReconstructionQualityEvidence } from '../src/lib/reconstruction/quality-contract';

vi.mock('../src/lib/reconstruction/candidate-pipeline', () => ({
  buildCandidatePipeline: vi.fn((understanding, baseline) => ({
    review: structuredClone(baseline),
    plans: {},
    pipeline: {
      understanding,
      automaticUnderstanding: understanding,
      camera: { status: 'held', reasons: ['test camera held'] },
    },
  })),
}));
import { runQualityPipeline, photoFingerprint } from '../src/lib/reconstruction/quality-core';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';

const understanding: SceneUnderstanding = {
  schemaVersion: 1,
  candidates: [],
  relations: [],
  roomLayout: { orthogonal: 'unknown', lines: [], corners: [], evidence: [], uncertainty: [] },
};
const photo = new Blob(['normalized-photo'], { type: 'image/png' });
let input: QualityRunInput;
let deps: QualityDependencies;
beforeEach(async () => {
  vi.clearAllMocks();
  const fingerprint = await photoFingerprint(photo);
  input = {
    photo,
    image: { width: 640, height: 480 },
    room: DEFAULT_ROOM,
    inputFingerprint: 'a'.repeat(64),
    signal: new AbortController().signal,
    baseline: { version: 2, analysis: 'complete', candidates: [], planes: [], warnings: [] },
    segmentation: { width: 2, height: 2, floor: new Uint8Array(4), wall: new Uint8Array(4) },
  };
  const model = {
    outputContract: INVENTORY_OUTPUT_CONTRACT,
    understanding: structuredClone(understanding),
    modelId: LAB_QWEN_MODEL,
    modelRevision: 'b'.repeat(64),
    rawText: '{"items":[]}',
    promptRevision: LAB_QWEN_PROMPT_REVISION,
    measurement: {
      requestMs: 0,
      inputWidth: 640,
      inputHeight: 480,
      memoryScope: 'Mock inference boundary',
      modelDownload: 'not-performed-cached-model-required' as const,
    },
  };
  const geometry: LocalGeometryAnalysis = {
    inputFingerprint: fingerprint,
    observation: {
      version: 1,
      inputFingerprint: fingerprint,
      image: input.image,
      model: { id: LOCAL_GEOMETRY_MODEL, revision: LOCAL_GEOMETRY_MODEL_REVISION },
      coordinateSystem: 'opencv-camera',
      scale: 'model-estimated-metres',
      intrinsics: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
      floor: null,
      walls: [],
    },
    measurement: {
      requestMs: 0,
      modelLoadMs: 0,
      inferenceMs: 0,
      planeExtractionMs: 0,
      cacheHit: false,
      modelCacheHit: true,
      modelDownload: 'not-performed-cached-model-required',
      memoryScope: 'Mock inference boundary',
    },
    evidence: { revision: LOCAL_GEOMETRY_REVISION },
  };
  deps = {
    inventory: vi.fn().mockResolvedValue(model),
    identity: vi.fn().mockImplementation(async (_photo, inventory) => skippedIdentityAnalysis(inventory)),
    installation: vi.fn().mockResolvedValue(skippedInstallationAnalysis(understanding)),
    geometry: vi.fn().mockResolvedValue(geometry),
    segmentation: vi.fn().mockResolvedValue(input.segmentation),
  };
});
async function fixtureEvidence() {
  const rawText = JSON.stringify({
    items: [
      { kind: 'toilet', bbox_2d: [100, 200, 400, 900], view: 'direct', basin: null, note: 'Visible toilet' },
    ],
  });
  const inventory = {
    ...(await deps.inventory(photo, input.signal)),
    rawText,
    understanding: parseFixtureInventory(rawText, INVENTORY_OUTPUT_CONTRACT).understanding,
  };
  const installationText = JSON.stringify({
    observations: [
      {
        id: inventory.understanding.candidates[0].id,
        note: 'Complete visible base rests on floor tiles',
        lower_support: 'full_base_on_floor',
        wall_connection: 'not_visible',
      },
    ],
  });
  vi.mocked(deps.inventory).mockResolvedValue(inventory);
  vi.mocked(deps.installation).mockResolvedValue({
    ...parseInstallationObservation(installationText, inventory.understanding, INSTALLATION_OUTPUT_CONTRACT),
    outputContract: INSTALLATION_OUTPUT_CONTRACT,
    promptRevision: INSTALLATION_PROMPT_REVISION,
    rawText: installationText,
    modelId: inventory.modelId,
    modelRevision: inventory.modelRevision,
    measurement: inventory.measurement,
  });
  return (await runQualityPipeline(input, deps)).evidence;
}
function expectNoInferenceOrPlacement() {
  expect(deps.inventory).not.toHaveBeenCalled();
  expect(deps.identity).not.toHaveBeenCalled();
  expect(deps.installation).not.toHaveBeenCalled();
  expect(deps.geometry).not.toHaveBeenCalled();
  expect(deps.segmentation).not.toHaveBeenCalled();
  expect(buildCandidatePipeline).not.toHaveBeenCalled();
}

describe('local quality orchestration (inference boundaries mocked, not a quality benchmark)', () => {
  it('connects inventory, identity, installation, real geometry argument and placement while preserving inputs', async () => {
    const before = structuredClone(input.baseline);
    const result = await runQualityPipeline(input, deps);
    expect(deps.inventory).toHaveBeenCalledOnce();
    expect(deps.identity).toHaveBeenCalledWith(photo, understanding, input.signal);
    expect(deps.installation).toHaveBeenCalledWith(photo, understanding, input.signal);
    expect(deps.geometry).toHaveBeenCalledWith(photo, input.segmentation, understanding, input.signal);
    expect(deps.segmentation).not.toHaveBeenCalled();
    const arguments_ = vi.mocked(buildCandidatePipeline).mock.calls[0];
    expect(arguments_[7]?.observation).toEqual(result.evidence.geometry.observation);
    expect(arguments_[7]?.inputFingerprint).toBe(await photoFingerprint(photo));
    expect(result.review.analysisProfile).toBe('local-quality-v1');
    expect(input.baseline).toEqual(before);
    expect(result.evidence.reused).toBe(false);
  });
  it('reuses matching observations without AI or masks inference for a new placement pass', async () => {
    const first = await runQualityPipeline(input, deps);
    vi.clearAllMocks();
    const second = await runQualityPipeline({ ...input, reuse: first.evidence }, deps);
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(deps.identity).not.toHaveBeenCalled();
    expect(deps.installation).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(deps.segmentation).not.toHaveBeenCalled();
    expect(second.evidence.reused).toBe(true);
    expect(second.evidence.timing.inventoryMs).toBe(0);
    expect(second.evidence.timing.identityMs).toBe(0);
  });
  it('rejects evidence from another normalized photo and does not silently rerun AI', async () => {
    const first = await runQualityPipeline(input, deps);
    vi.clearAllMocks();
    await expect(
      runQualityPipeline({ ...input, photo: new Blob(['other']), reuse: first.evidence }, deps),
    ).rejects.toThrow('보관된 정밀 관측');
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(deps.identity).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
  it('rejects a geometry response with mismatched image provenance before placement', async () => {
    const checkpoint = vi.fn();
    input.onCheckpoint = checkpoint;
    vi.mocked(deps.geometry).mockImplementation(
      async () =>
        ({
          inputFingerprint: 'f'.repeat(64),
          observation: { inputFingerprint: 'f'.repeat(64), image: input.image },
        }) as never,
    );
    await expect(runQualityPipeline(input, deps)).rejects.toThrow('공간 관측');
    expect(checkpoint).toHaveBeenCalledWith(
      'geometryResponseReceived',
      expect.objectContaining({ inputFingerprint: 'f'.repeat(64) }),
    );
    expect(checkpoint.mock.calls.some(([name]) => name === 'geometryResponse')).toBe(false);
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
  it('does not fabricate geometry or use another engine when installation fails', async () => {
    vi.mocked(deps.installation).mockRejectedValue(new Error('actual inference unavailable'));
    await expect(runQualityPipeline(input, deps)).rejects.toThrow('actual inference unavailable');
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
  it('obtains same-photo masks explicitly when a prior baseline report contains no masks', async () => {
    await runQualityPipeline({ ...input, segmentation: undefined }, deps);
    expect(deps.segmentation).toHaveBeenCalledWith(photo, undefined, {
      quality: 'reconstruction',
      signal: input.signal,
    });
  });
  it('ignores a late stage response after cancellation', async () => {
    const controller = new AbortController();
    input.signal = controller.signal;
    vi.mocked(deps.installation).mockImplementation(async () => {
      controller.abort();
      return { understanding } as never;
    });
    await expect(runQualityPipeline(input, deps)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
  it('accepts current installation raw observations despite different JSON object key order', async () => {
    const evidence = await fixtureEvidence();
    evidence.effectiveUnderstanding = JSON.parse(
      JSON.stringify(evidence.effectiveUnderstanding, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    );
    vi.clearAllMocks();
    const result = await runQualityPipeline({ ...input, reuse: evidence }, deps);
    expect(result.evidence.reused).toBe(true);
    expect(result.evidence.installation.understanding.candidates[0].mounting).toBe('floor');
    expect(result.evidence.installation.understanding.candidates[0].wall).toBe('unknown');
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(deps.identity).not.toHaveBeenCalled();
    expect(deps.installation).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
  });
  it.each<[string, (evidence: ReconstructionQualityEvidence) => void]>([
    [
      'previous installation prompt',
      (e) => {
        e.installation.promptRevision = INSTALLATION_PROMPT_REVISION - 1;
      },
    ],
    [
      'unknown installation output contract',
      (e) => {
        Object.assign(e.installation, { outputContract: 'old-contract' });
      },
    ],
    [
      'different installation model',
      (e) => {
        e.installation.modelId = 'other-model';
      },
    ],
    [
      'different installation weights',
      (e) => {
        e.installation.modelRevision = 'f'.repeat(64);
      },
    ],
    [
      'invalid inventory digest',
      (e) => {
        e.inventory.modelRevision = 'not-a-digest';
      },
    ],
    [
      'nonempty inventory marked skipped',
      (e) => {
        e.installation.skipped = 'empty-inventory';
        e.installation.modelRevision = null;
      },
    ],
  ])('rejects %s without replacing data or automatically rerunning any model', async (_name, corrupt) => {
    const evidence = await fixtureEvidence();
    corrupt(evidence);
    const original = structuredClone(evidence);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('보관된 정밀 관측');
    expect(evidence).toEqual(original);
    expectNoInferenceOrPlacement();
  });
  it.each<[string, (evidence: ReconstructionQualityEvidence) => void]>([
    [
      'previous extraction revision',
      (e) => {
        e.geometry.evidence.revision = 'previous-geometry';
      },
    ],
    [
      'wrong geometry hash',
      (e) => {
        e.geometry.observation.inputFingerprint = 'f'.repeat(64);
      },
    ],
    [
      'wrong geometry dimensions',
      (e) => {
        e.geometry.observation.image.width++;
      },
    ],
    [
      'wrong geometry model ID',
      (e) => {
        e.geometry.observation.model.id = 'other-model';
      },
    ],
    [
      'wrong geometry model revision',
      (e) => {
        e.geometry.observation.model.revision = 'f'.repeat(40);
      },
    ],
    [
      'nonfinite intrinsics',
      (e) => {
        e.geometry.observation.intrinsics.fx = Number.NaN;
      },
    ],
    [
      'nonfinite nested diagnostics',
      (e) => {
        e.geometry.evidence.support = { residual: Number.POSITIVE_INFINITY };
      },
    ],
    [
      'invalid camera scale',
      (e) => {
        e.geometry.observation.intrinsics.fy = 0;
      },
    ],
  ])('rejects %s inside saved geometry before placement', async (_name, corrupt) => {
    const { evidence } = await runQualityPipeline(input, deps);
    corrupt(evidence);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('보관된 정밀 관측');
    expectNoInferenceOrPlacement();
  });
  it.each<[string, (evidence: ReconstructionQualityEvidence) => void]>([
    [
      'transported installation changed',
      (e) => {
        e.installation.understanding.candidates[0].wall = 'left';
      },
    ],
    [
      'effective understanding changed',
      (e) => {
        e.effectiveUnderstanding.candidates[0].wall = 'left';
      },
    ],
    [
      'raw model text changed',
      (e) => {
        e.installation.rawText = '{"observations":[]}';
      },
    ],
    [
      'validation evidence changed',
      (e) => {
        e.installation.validation.appliedCandidateIds = [];
      },
    ],
    [
      'raw model text invalid',
      (e) => {
        e.installation.rawText = '{malformed';
      },
    ],
  ])('reparses raw installation and rejects %s even when candidate IDs match', async (_name, corrupt) => {
    const evidence = await fixtureEvidence();
    corrupt(evidence);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('보관된 정밀 관측');
    expectNoInferenceOrPlacement();
  });
  it('only permits a null installation model revision for a genuinely empty skipped inventory', async () => {
    const { evidence } = await runQualityPipeline(input, deps);
    evidence.installation.modelRevision = evidence.inventory.modelRevision;
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('생략 기록');
    expectNoInferenceOrPlacement();
  });
  it('does not reuse historical v1 installation even when its explicit historical parse is valid', async () => {
    const evidence = await fixtureEvidence();
    const rawText = JSON.stringify({ observations: [], relations: [], roomLayout: null });
    const checked = parseInstallationObservation(
      rawText,
      evidence.inventory.understanding,
      INSTALLATION_V1_OUTPUT_CONTRACT,
    );
    evidence.installation = {
      ...evidence.installation,
      ...checked,
      rawText,
      outputContract: INSTALLATION_V1_OUTPUT_CONTRACT,
      promptRevision: 1,
    };
    evidence.effectiveUnderstanding = structuredClone(checked.understanding);
    const preserved = structuredClone(evidence);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('설치 관측 계약');
    expect(evidence).toEqual(preserved);
    expectNoInferenceOrPlacement();
  });
});

async function identityFixtureEvidence() {
  const rawText = JSON.stringify({
    items: [
      {
        kind: 'basin',
        bbox_2d: [200, 300, 600, 600],
        view: 'direct',
        basin: { shape: 'rectangular', support: 'cabinet', bowls: 1 },
        note: 'A bounded basin initially interpreted as cabinet support',
      },
    ],
  });
  const inventory = {
    ...(await deps.inventory(photo, input.signal)),
    rawText,
    understanding: parseFixtureInventory(rawText, INVENTORY_OUTPUT_CONTRACT).understanding,
  };
  const identityText = JSON.stringify({
    observations: [
      {
        id: inventory.understanding.candidates[0].id,
        note: 'Visible rear wall joint with exposed drain pipe and clear space beneath the bowl',
        structure: 'wall_basin_open_underside',
        context: 'room_fixture',
      },
    ],
  });
  const identity = {
    ...parseIdentityObservation(identityText, inventory.understanding),
    outputContract: IDENTITY_OUTPUT_CONTRACT,
    promptRevision: IDENTITY_PROMPT_REVISION,
    rawText: identityText,
    modelId: inventory.modelId,
    modelRevision: inventory.modelRevision,
    measurement: inventory.measurement,
  };
  const installationText = JSON.stringify({
    observations: [
      {
        id: inventory.understanding.candidates[0].id,
        note: 'The assembly is suspended and its rear edge joins the wall',
        lower_support: 'whole_fixture_suspended_with_gap',
        wall_connection: 'visible_joint',
      },
    ],
  });
  vi.mocked(deps.inventory).mockResolvedValue(inventory);
  vi.mocked(deps.identity).mockResolvedValue(identity);
  vi.mocked(deps.installation).mockImplementation(async (_photo, revised) => ({
    ...parseInstallationObservation(installationText, revised, INSTALLATION_OUTPUT_CONTRACT),
    outputContract: INSTALLATION_OUTPUT_CONTRACT,
    promptRevision: INSTALLATION_PROMPT_REVISION,
    rawText: installationText,
    modelId: inventory.modelId,
    modelRevision: inventory.modelRevision,
    measurement: inventory.measurement,
  }));
  return { inventory, identity, evidence: (await runQualityPipeline(input, deps)).evidence };
}

describe('identity observation in the shared quality chain (mocked inference boundaries)', () => {
  it('passes the separately revised structure to installation and geometry while preserving raw inventory', async () => {
    const { inventory, identity, evidence } = await identityFixtureEvidence();
    expect(inventory.understanding.candidates[0]).toMatchObject({
      basinStyle: 'vanity',
      mounting: 'unknown',
    });
    expect(identity.understanding.candidates[0]).toMatchObject({
      basinStyle: 'wall',
      mounting: 'wall',
      wall: 'unknown',
    });
    expect(identity.validation.proposals[0].ruleRevision).toBe(IDENTITY_RULE_REVISION);
    expect(deps.identity).toHaveBeenCalledWith(photo, inventory.understanding, input.signal);
    expect(deps.installation).toHaveBeenCalledWith(photo, identity.understanding, input.signal);
    expect(deps.geometry).toHaveBeenCalledWith(
      photo,
      input.segmentation,
      evidence.installation.understanding,
      input.signal,
    );
    expect(evidence.inventory).toEqual(inventory);
    expect(evidence.identity).toEqual(identity);
    expect(evidence.effectiveUnderstanding.candidates[0]).toMatchObject({
      basinStyle: 'wall',
      mounting: 'wall',
      wall: 'unknown',
    });
    expect(evidence.effectiveUnderstanding.candidates[0].bounds).toEqual(
      inventory.understanding.candidates[0].bounds,
    );
    expect(vi.mocked(deps.identity).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.installation).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(deps.installation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.geometry).mock.invocationCallOrder[0],
    );
    expect(evidence.timing.identityMs).toBeGreaterThanOrEqual(0);
  });
  it('does not invoke later models or placement when identity inference fails', async () => {
    vi.mocked(deps.identity).mockRejectedValue(new Error('identity worker failed'));
    await expect(runQualityPipeline(input, deps)).rejects.toThrow('identity worker failed');
    expect(deps.installation).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(deps.segmentation).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
  it('ignores identity that returns after cancellation and does not proceed to installation', async () => {
    const controller = new AbortController();
    input.signal = controller.signal;
    const checkpoint = vi.fn();
    input.onCheckpoint = checkpoint;
    vi.mocked(deps.identity).mockImplementation(async (_photo, inventory) => {
      controller.abort();
      return skippedIdentityAnalysis(inventory);
    });
    await expect(runQualityPipeline(input, deps)).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.installation).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
    expect(checkpoint.mock.calls.some(([name]) => name === 'qualityEvidence')).toBe(false);
  });
  it('does not reuse historical evidence missing the identity stage or silently run a missing stage', async () => {
    const { evidence } = await identityFixtureEvidence();
    delete evidence.identity;
    const preserved = structuredClone(evidence);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('보관된 정밀 관측');
    expect(evidence).toEqual(preserved);
    expectNoInferenceOrPlacement();
  });
  it('reparses identity against the original inventory before installation when reusing evidence', async () => {
    const { evidence } = await identityFixtureEvidence();
    vi.clearAllMocks();
    const result = await runQualityPipeline({ ...input, reuse: evidence }, deps);
    expect(result.evidence.reused).toBe(true);
    expect(result.evidence.inventory.understanding.candidates[0].basinStyle).toBe('vanity');
    expect(result.evidence.identity?.understanding.candidates[0].basinStyle).toBe('wall');
    expect(result.evidence.installation.understanding.candidates[0].basinStyle).toBe('wall');
    expect(result.evidence.timing.identityMs).toBe(0);
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(deps.identity).not.toHaveBeenCalled();
    expect(deps.installation).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(deps.segmentation).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).toHaveBeenCalledOnce();
  });
  it.each<[string, (evidence: ReconstructionQualityEvidence) => void]>([
    [
      'identity prompt revision changed',
      (e) => {
        e.identity!.promptRevision = IDENTITY_PROMPT_REVISION - 1;
      },
    ],
    [
      'identity rule revision changed',
      (e) => {
        Object.assign(e.identity!.validation.proposals[0], { ruleRevision: 'fixture-identity-rules-v1' });
      },
    ],
    [
      'identity output contract changed',
      (e) => {
        Object.assign(e.identity!, { outputContract: 'fixture-identity-old' });
      },
    ],
    [
      'identity model ID changed',
      (e) => {
        e.identity!.modelId = 'other-model';
      },
    ],
    [
      'identity digest differs from inventory',
      (e) => {
        e.identity!.modelRevision = 'f'.repeat(64);
      },
    ],
    [
      'identity digest malformed',
      (e) => {
        e.identity!.modelRevision = 'bad-digest';
      },
    ],
    [
      'identity raw text changed',
      (e) => {
        e.identity!.rawText = '{"observations":[]}';
      },
    ],
    [
      'identity raw text malformed',
      (e) => {
        e.identity!.rawText = '{broken';
      },
    ],
    [
      'identity proposed shape changed',
      (e) => {
        e.identity!.understanding.candidates[0].basinStyle = 'pedestal';
      },
    ],
    [
      'identity validation changed',
      (e) => {
        e.identity!.validation.appliedCandidateIds = [];
      },
    ],
    [
      'eligible identity marked skipped',
      (e) => {
        e.identity!.skipped = 'no-eligible-candidates';
        e.identity!.modelRevision = null;
      },
    ],
    [
      'identity updated box changed',
      (e) => {
        e.identity!.understanding.candidates[0].bounds.right += 0.05;
      },
    ],
  ])('rejects %s without changing stored observations or rerunning models', async (_name, corrupt) => {
    const { evidence } = await identityFixtureEvidence();
    corrupt(evidence);
    const preserved = structuredClone(evidence);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('보관된 정밀 관측');
    expect(evidence).toEqual(preserved);
    expectNoInferenceOrPlacement();
  });
  it('accepts equivalent JSON key order without confusing it with changed identity evidence', async () => {
    const { evidence } = await identityFixtureEvidence();
    evidence.identity = JSON.parse(
      JSON.stringify(evidence.identity, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    );
    vi.clearAllMocks();
    expect((await runQualityPipeline({ ...input, reuse: evidence }, deps)).evidence.reused).toBe(true);
    expect(deps.identity).not.toHaveBeenCalled();
  });
  it('only permits a null skipped identity digest when no identity targets exist', async () => {
    const { evidence } = await runQualityPipeline(input, deps);
    expect(evidence.identity?.skipped).toBe('no-eligible-candidates');
    expect(evidence.identity?.modelRevision).toBeNull();
    evidence.identity!.modelRevision = evidence.inventory.modelRevision;
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, reuse: evidence }, deps)).rejects.toThrow('보관된 정밀 관측');
    expectNoInferenceOrPlacement();
  });
  it('rejects a fresh identity response from different model weights before downstream analysis', async () => {
    const { identity } = await identityFixtureEvidence();
    vi.clearAllMocks();
    vi.mocked(deps.identity).mockResolvedValue({ ...identity, modelRevision: 'f'.repeat(64) });
    await expect(runQualityPipeline(input, deps)).rejects.toThrow();
    expect(deps.installation).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
  });
});

describe('estimated quality opt-in (AI and solver boundaries mocked)', () => {
  async function layoutFor(evidence: ReconstructionQualityEvidence) {
    const rawText = JSON.stringify({
      observations: [
        { id: 'item_01', wall: 'back', orientation: 'toward-camera', note: 'Visible rear tank against wall' },
      ],
      relations: [],
    });
    return {
      ...evidence.inventory,
      ...parseLayoutObservation(rawText, evidence.effectiveUnderstanding),
      rawText,
      outputContract: LAYOUT_OUTPUT_CONTRACT,
      promptRevision: LAYOUT_PROMPT_REVISION,
      photoFingerprint: evidence.photoFingerprint,
    };
  }
  it('keeps the historical default strict without a relationship request', async () => {
    deps.layout = vi.fn();
    const result = await fixtureEvidence();
    expect(deps.layout).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
    expect(result.placementPolicy).toBe('strict');
  });
  it('runs the separate actual relationship boundary only for an explicit new estimation', async () => {
    const baseline = await fixtureEvidence();
    const layout = await layoutFor(baseline);
    deps.layout = vi.fn().mockResolvedValue(layout);
    vi.clearAllMocks();
    const result = await runQualityPipeline({ ...input, estimatedLayout: true }, deps);
    expect(deps.layout).toHaveBeenCalledWith(photo, baseline.effectiveUnderstanding, input.signal);
    expect(buildEstimatedCandidatePipeline).toHaveBeenCalledOnce();
    expect(result.evidence.placementPolicy).toBe('visible-relation-estimate');
    expect(result.evidence.layout?.rawText).toBe(layout.rawText);
    expect(vi.mocked(buildEstimatedCandidatePipeline).mock.calls.at(-1)?.[0].depthWallEvidence).toEqual({
      observation: result.evidence.geometry.observation,
      expectedInputFingerprint: await photoFingerprint(photo),
    });
    expect(result.evidence.geometry.observation.inputFingerprint).not.toBe(input.inputFingerprint);
    expect(result.review.analysisSummary?.placementPolicy).toBe('visible-relation-estimate');
  });
  it('replays historical evidence without secretly adding a relationship inference', async () => {
    const baseline = await fixtureEvidence();
    deps.layout = vi.fn();
    vi.clearAllMocks();
    const result = await runQualityPipeline({ ...input, estimatedLayout: true, reuse: baseline }, deps);
    expect(deps.layout).not.toHaveBeenCalled();
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(result.evidence.layout).toBeUndefined();
    expect(result.evidence.timing.layoutMs).toBe(0);
    expect(buildEstimatedCandidatePipeline).toHaveBeenCalledOnce();
  });
  it.each(['photo', 'candidate', 'model', 'raw'])(
    'rejects an unrelated %s observation before estimated placement',
    async (field) => {
      const baseline = await fixtureEvidence();
      const layout = await layoutFor(baseline);
      if (field === 'photo') layout.photoFingerprint = 'a'.repeat(64);
      if (field === 'candidate') layout.inventorySignature = 'another inventory';
      if (field === 'model') layout.modelRevision = 'a'.repeat(64);
      if (field === 'raw') layout.observations[0].wall = 'left';
      vi.clearAllMocks();
      await expect(
        runQualityPipeline(
          { ...input, estimatedLayout: true, reuse: baseline, layoutObservation: layout },
          deps,
        ),
      ).rejects.toThrow('공간 관계');
      expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
      expect(deps.inventory).not.toHaveBeenCalled();
      expect(baseline.layout).toBeUndefined();
    },
  );
  it('preserves saved observations and cancels before solver application', async () => {
    const baseline = await fixtureEvidence();
    const layout = await layoutFor(baseline);
    const controller = new AbortController();
    deps.layout = vi.fn().mockImplementation(async () => {
      controller.abort();
      return layout;
    });
    vi.clearAllMocks();
    await expect(
      runQualityPipeline({ ...input, signal: controller.signal, estimatedLayout: true }, deps),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
  });
});

import {
  FIXTURE_APPEARANCE_CONTRACT,
  FIXTURE_APPEARANCE_PROMPT_REVISION,
  parseFixtureAppearance,
  type LocalFixtureAppearanceAnalysis,
} from '../src/lib/reconstruction/fixture-appearance-observation';
async function appearanceEvidence(
  previous: ReconstructionQualityEvidence,
): Promise<LocalFixtureAppearanceAnalysis> {
  const rawText = JSON.stringify({
    schemaVersion: 1,
    observations: previous.installation.understanding.candidates.map((c) => ({
      id: c.id,
      note: 'Visible physical fixture independently examined in the photo.',
      kind: 'toilet',
      context: 'physical',
      sameObjectAs: null,
      shape: 'unknown',
      counterSupport: 'unknown',
    })),
  });
  return {
    ...previous.inventory,
    ...parseFixtureAppearance(rawText, previous.installation.understanding),
    rawText,
    outputContract: FIXTURE_APPEARANCE_CONTRACT,
    promptRevision: FIXTURE_APPEARANCE_PROMPT_REVISION,
    photoFingerprint: previous.photoFingerprint,
  };
}
describe('appearance refinement evidence boundary (mock model, not photo quality)', () => {
  it('preserves raw installation while attaching verified appearance and passes model options to the solver', async () => {
    const previous = await fixtureEvidence(),
      appearance = await appearanceEvidence(previous);
    vi.clearAllMocks();
    const result = await runQualityPipeline(
      { ...input, reuse: previous, estimatedLayout: true, appearanceObservation: appearance },
      deps,
    );
    expect(result.evidence.installation).toEqual(previous.installation);
    expect(result.evidence.effectiveUnderstanding).toEqual(appearance.understanding);
    expect(result.evidence.appearance).toEqual(appearance);
    expect(vi.mocked(buildEstimatedCandidatePipeline).mock.calls.at(-1)?.[0].appearance).toEqual(appearance);
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(result.evidence.timing.appearanceMs).toBe(0);
  });
  it('reuses the exact same appearance decisions without inference on a later placement pass', async () => {
    const previous = await fixtureEvidence(),
      appearance = await appearanceEvidence(previous);
    const first = await runQualityPipeline(
      { ...input, reuse: previous, estimatedLayout: true, appearanceObservation: appearance },
      deps,
    );
    vi.clearAllMocks();
    deps.appearance = vi.fn();
    deps.layout = vi.fn();
    const second = await runQualityPipeline(
      { ...input, reuse: first.evidence, estimatedLayout: true, refineAppearance: true },
      deps,
    );
    expect(second.evidence.effectiveUnderstanding).toEqual(first.evidence.effectiveUnderstanding);
    expect(deps.appearance).not.toHaveBeenCalled();
    expect(deps.layout).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
  });
  it('rejects a forged duplicate/options/result, model digest, photo fingerprint or original candidate binding', async () => {
    const previous = await fixtureEvidence(),
      appearance = await appearanceEvidence(previous);
    for (const patch of [
      { modelRevision: 'f'.repeat(64) },
      { photoFingerprint: 'f'.repeat(64) },
      { inventorySignature: 'other' },
      { duplicates: [{ candidateId: 'item_01', canonicalId: 'missing', reason: 'forged' }] },
      { modelOptions: { item_01: { mirrorShape: 'oval' } } },
      { understanding: { ...appearance.understanding, candidates: [] } },
    ]) {
      vi.clearAllMocks();
      await expect(
        runQualityPipeline(
          {
            ...input,
            reuse: previous,
            estimatedLayout: true,
            appearanceObservation: { ...appearance, ...patch } as LocalFixtureAppearanceAnalysis,
          },
          deps,
        ),
      ).rejects.toThrow(/형태/);
      expectNoInferenceOrPlacement();
    }
  });
  it('does not silently refine legacy evidence or enable refinement on the old path', async () => {
    const previous = await fixtureEvidence();
    vi.clearAllMocks();
    deps.appearance = vi.fn();
    await expect(
      runQualityPipeline({ ...input, reuse: previous, estimatedLayout: true, refineAppearance: true }, deps),
    ).rejects.toThrow('AI를 자동 재실행하지 않았어요');
    await expect(runQualityPipeline({ ...input, refineAppearance: true }, deps)).rejects.toThrow('명시적으로');
    expectNoInferenceOrPlacement();
    expect(deps.appearance).not.toHaveBeenCalled();
  });
  it('runs explicit new refinement before layout and saves both separate timings', async () => {
    const previous = await fixtureEvidence(),
      appearance = await appearanceEvidence(previous);
    vi.clearAllMocks();
    deps.appearance = vi.fn().mockResolvedValue(appearance);
    deps.layout = vi.fn(async (_photo, scene) => ({
      ...previous.inventory,
      understanding: scene,
      outputContract: LAYOUT_OUTPUT_CONTRACT,
      promptRevision: LAYOUT_PROMPT_REVISION,
      rawText: '{"observations":[],"relations":[]}',
      ...parseLayoutObservation('{"observations":[],"relations":[]}', scene),
      photoFingerprint: previous.photoFingerprint,
    }));
    const result = await runQualityPipeline({ ...input, estimatedLayout: true, refineAppearance: true }, deps);
    expect(deps.appearance).toHaveBeenCalledOnce();
    expect(deps.layout).toHaveBeenCalledWith(photo, appearance.understanding, input.signal);
    expect(result.evidence.timing.appearanceMs).toBeGreaterThanOrEqual(0);
    expect(result.evidence.appearance?.rawText).toBe(appearance.rawText);
  });
});

// These exercise orchestration and real parsers. Model inference, solver and the browser
// crop-preparation boundary are mocked; authored receipts are not photo-quality evidence.
import sharp from 'sharp';
import {
  prepareReflectionRecheckRequests,
  type LocalShowerAnalysis,
} from '../src/lib/reconstruction/analysis-client';
import {
  parseShowerObservation,
  SHOWER_OBSERVATION_CONTRACT,
  SHOWER_OBSERVATION_PROMPT_REVISION,
} from '../src/lib/reconstruction/shower-observation';
import { EXTENDED_INVENTORY_OUTPUT_CONTRACT } from '../src/lib/reconstruction/inventory-observation';
import { layoutInventorySignature } from '../src/lib/reconstruction/layout-observation';
import {
  applyReflectionRechecks,
  reflectionRecheckSignature,
  type ReflectionRecheckContext,
  type ReflectionRecheckEvidence,
} from '../src/lib/reconstruction/reflection-recheck';
import {
  createTargetExistenceReceipt,
  targetExistenceCropTransform,
  validateTargetExistenceAnalysis,
  type TargetExistenceObservation,
} from '../src/lib/reconstruction/target-existence-observation';

vi.mock('../src/lib/reconstruction/analysis-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/reconstruction/analysis-client')>();
  return { ...actual, prepareReflectionRecheckRequests: vi.fn() };
});

async function detailStages(kind: 'shower' | 'mirror') {
  const original = await deps.inventory(input.photo, input.signal);
  const rawText = JSON.stringify({
    items: [
      {
        kind,
        bbox_2d: [200, 200, 600, 700],
        view: 'direct',
        basin: null,
        note: 'Authored visible fixture for stage-boundary verification.',
      },
    ],
  });
  const inventory = {
    ...original,
    rawText,
    outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
    understanding: parseFixtureInventory(rawText, EXTENDED_INVENTORY_OUTPUT_CONTRACT).understanding,
  };
  vi.mocked(deps.inventory).mockResolvedValue(inventory);
  if (kind === 'mirror') {
    const text = JSON.stringify({
      observations: [
        {
          id: 'item_01',
          structure: 'flat_reflective_panel',
          context: 'room_fixture',
          note: 'Authored directly bounded mirror panel.',
        },
      ],
    });
    vi.mocked(deps.identity).mockResolvedValue({
      ...inventory,
      ...parseIdentityObservation(text, inventory.understanding),
      rawText: text,
      outputContract: IDENTITY_OUTPUT_CONTRACT,
      promptRevision: IDENTITY_PROMPT_REVISION,
    });
  }
  vi.mocked(deps.installation).mockImplementation(async (_photo, scene) => {
    const text = JSON.stringify({
      observations: scene.candidates.map(({ id }) => ({
        id,
        lower_support: 'whole_fixture_suspended_with_gap',
        wall_connection: 'visible_joint',
        note: 'Authored visible wall attachment with an open underside.',
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
  deps.showerDetails = vi.fn();
  deps.reflectionRecheck = vi.fn();
  deps.layout = vi.fn(async (_photo, scene) => {
    const text = '{"observations":[],"relations":[]}';
    return {
      ...inventory,
      ...parseLayoutObservation(text, scene),
      rawText: text,
      outputContract: LAYOUT_OUTPUT_CONTRACT,
      promptRevision: LAYOUT_PROMPT_REVISION,
      photoFingerprint: await photoFingerprint(input.photo),
    };
  });
  const previous = (await runQualityPipeline(input, deps)).evidence;
  vi.clearAllMocks();
  return previous;
}

async function authoredShower(previous: ReconstructionQualityEvidence): Promise<LocalShowerAnalysis> {
  const rawText = JSON.stringify({
    schemaVersion: 1,
    observations: [
      {
        id: 'item_01',
        kind: 'shower',
        context: 'physical',
        style: 'hand-spray',
        observedPart: 'handset',
        note: 'Authored small spray head and visibly connected hose.',
        visibleParts: {
          handheldHead: 'present',
          overheadHead: 'absent',
          verticalRail: 'absent',
          hose: 'present',
        },
      },
    ],
  });
  return {
    ...previous.inventory,
    ...parseShowerObservation(rawText, previous.effectiveUnderstanding),
    rawText,
    outputContract: SHOWER_OBSERVATION_CONTRACT,
    promptRevision: SHOWER_OBSERVATION_PROMPT_REVISION,
    photoFingerprint: previous.photoFingerprint,
    // Model preview bytes and normalized source bytes are distinct contracts.
    modelInputSha256: await photoFingerprint(new Blob(['authored-model-preview'])),
  };
}

describe('shower detail orchestration (mock inference, real structured validation)', () => {
  it('requests fresh details only explicitly and forwards the observed part before layout/solver', async () => {
    const previous = await detailStages('shower');
    const detail = await authoredShower(previous);
    vi.mocked(deps.showerDetails!).mockResolvedValue(detail);
    await runQualityPipeline({ ...input, estimatedLayout: true }, deps);
    expect(deps.showerDetails).not.toHaveBeenCalled();
    vi.clearAllMocks();
    const result = await runQualityPipeline(
      { ...input, estimatedLayout: true, refineShowerDetails: true },
      deps,
    );
    expect(deps.showerDetails).toHaveBeenCalledWith(
      input.photo,
      previous.effectiveUnderstanding,
      input.signal,
    );
    expect(vi.mocked(deps.showerDetails!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.layout!).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(buildEstimatedCandidatePipeline).mock.calls[0][0].showerDetails).toEqual(
      detail.observations,
    );
    expect(result.evidence.showerDetails).toEqual(detail);
    expect(result.evidence.installation).toEqual(previous.installation);
    expect(result.evidence.effectiveUnderstanding).toEqual(previous.effectiveUnderstanding);
    expect(result.evidence.timing.showerDetailsMs).toBeGreaterThanOrEqual(0);
    expect(detail.modelInputSha256).not.toBe(result.evidence.photoFingerprint);
  });

  it('replays legacy observations without a new detail call and rejects an explicit missing-stage replay', async () => {
    const previous = await detailStages('shower');
    const result = await runQualityPipeline({ ...input, estimatedLayout: true, reuse: previous }, deps);
    expect(result.evidence.showerDetails).toBeUndefined();
    expect(deps.showerDetails).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await expect(
      runQualityPipeline(
        {
          ...input,
          estimatedLayout: true,
          reuse: previous,
          refineShowerDetails: true,
        },
        deps,
      ),
    ).rejects.toThrow('새 분석을 명시적으로');
    await expect(runQualityPipeline({ ...input, refineShowerDetails: true }, deps)).rejects.toThrow(
      '명시적으로',
    );
    expectNoInferenceOrPlacement();
    expect(deps.showerDetails).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
  });

  it.each<[string, (value: LocalShowerAnalysis) => void]>([
    [
      'source photo SHA',
      (v) => {
        v.photoFingerprint = 'c'.repeat(64);
      },
    ],
    [
      'model-input SHA format',
      (v) => {
        v.modelInputSha256 = 'invalid';
      },
    ],
    [
      'model identity',
      (v) => {
        v.modelId = 'other-model';
      },
    ],
    [
      'model weights',
      (v) => {
        v.modelRevision = 'c'.repeat(64);
      },
    ],
    [
      'candidate signature',
      (v) => {
        v.inventorySignature = 'different-candidates';
      },
    ],
    [
      'raw/parsed disagreement',
      (v) => {
        v.observations[0].observedPart = 'whole-kit';
      },
    ],
  ])('rejects fresh %s mismatch before downstream layout or solver', async (_name, corrupt) => {
    const previous = await detailStages('shower');
    const detail = await authoredShower(previous);
    corrupt(detail);
    const preserved = structuredClone(detail);
    vi.mocked(deps.showerDetails!).mockResolvedValue(detail);
    await expect(
      runQualityPipeline(
        {
          ...input,
          estimatedLayout: true,
          refineShowerDetails: true,
        },
        deps,
      ),
    ).rejects.toThrow('샤워 세부');
    expect(detail).toEqual(preserved);
    expect(deps.layout).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
  });

  it('drops a late shower response after cancellation without publishing evidence', async () => {
    const previous = await detailStages('shower');
    const detail = await authoredShower(previous);
    const controller = new AbortController(),
      checkpoint = vi.fn();
    vi.mocked(deps.showerDetails!).mockImplementation(async () => {
      controller.abort();
      return detail;
    });
    await expect(
      runQualityPipeline(
        {
          ...input,
          signal: controller.signal,
          onCheckpoint: checkpoint,
          estimatedLayout: true,
          refineShowerDetails: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.layout).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
    expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('showerDetailsResponse');
    expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('qualityEvidence');
  });

  it('roundtrips saved raw details without inference, then rejects a tampered saved observation', async () => {
    const previous = await detailStages('shower');
    const detail = await authoredShower(previous);
    const first = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        reuse: previous,
        showerDetailsObservation: detail,
      },
      deps,
    );
    const saved: ReconstructionQualityEvidence = JSON.parse(JSON.stringify(first.evidence));
    vi.clearAllMocks();
    const second = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        reuse: saved,
        refineShowerDetails: true,
      },
      deps,
    );
    expect(second.evidence.showerDetails).toEqual(detail);
    expect(second.evidence.timing.showerDetailsMs).toBe(0);
    expect(deps.showerDetails).not.toHaveBeenCalled();
    expect(deps.layout).not.toHaveBeenCalled();
    expect(deps.geometry).not.toHaveBeenCalled();
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(vi.mocked(buildEstimatedCandidatePipeline).mock.calls[0][0].showerDetails).toEqual(
      detail.observations,
    );
    saved.showerDetails!.observations[0].style = 'overhead-set';
    const preserved = structuredClone(saved);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, estimatedLayout: true, reuse: saved }, deps)).rejects.toThrow(
      '보관된 정밀 관측',
    );
    expect(saved).toEqual(preserved);
    expectNoInferenceOrPlacement();
    expect(deps.showerDetails).not.toHaveBeenCalled();
  });
});

async function reflectionStages() {
  // Synthetic pixels permit authentic byte receipts; browser crop preparation remains mocked.
  const pixels = await sharp({
    create: {
      ...input.image,
      channels: 3,
      background: '#c0d0e0',
    },
  })
    .png()
    .toBuffer();
  input.photo = new Blob([new Uint8Array(pixels)], { type: 'image/png' });
  const fingerprint = await photoFingerprint(input.photo);
  const geometry = await deps.geometry(input.photo, input.segmentation!, understanding, input.signal);
  geometry.inputFingerprint = fingerprint;
  geometry.observation.inputFingerprint = fingerprint;
  vi.mocked(deps.geometry).mockResolvedValue(geometry);
  const previous = await detailStages('mirror');
  const rawText = JSON.stringify({
    schemaVersion: 1,
    observations: [
      {
        id: 'item_01',
        kind: 'mirror',
        context: 'reflected',
        shape: 'oval',
        note: 'Authored appearance conflict for a bounded mirror panel.',
        counterSupport: 'unknown',
        sameObjectAs: null,
      },
    ],
  });
  const appearance: LocalFixtureAppearanceAnalysis = {
    ...previous.inventory,
    ...parseFixtureAppearance(rawText, previous.installation.understanding),
    rawText,
    outputContract: FIXTURE_APPEARANCE_CONTRACT,
    promptRevision: FIXTURE_APPEARANCE_PROMPT_REVISION,
    photoFingerprint: fingerprint,
  };
  const context: ReflectionRecheckContext = {
    identity: previous.identity!.understanding,
    installation: previous.installation.understanding,
    appearance,
    protectedCandidateIds: new Set(),
  };
  const boxes = appearance.understanding.candidates.map(({ id, bounds }) => ({ id, bounds }));
  const cropTransform = targetExistenceCropTransform(input.image, boxes[0].bounds);
  const full = await sharp(pixels).jpeg({ quality: 95 }).toBuffer();
  const crop = await sharp(pixels).extract(cropTransform).jpeg({ quality: 95 }).toBuffer();
  const receipt = await createTargetExistenceReceipt({
    photoBytes: pixels,
    normalizedFullBytes: full,
    cropBytes: crop,
    expectedPhotoFingerprint: fingerprint,
    targetId: boxes[0].id,
    boxes,
    cropTransform,
    sourceDecisionSignature: reflectionRecheckSignature(context),
    modelId: LAB_QWEN_MODEL,
    modelRevision: previous.inventory.modelRevision,
  });
  const row: TargetExistenceObservation = {
    id: boxes[0].id,
    kind: 'mirror',
    note: 'Authored visible bounded reflective panel.',
    targetExistence: 'directly-visible-surface',
    objectScope: 'whole-object',
    showerStyle: 'unknown',
    lowerSupport: 'uncertain',
    sameObjectAs: null,
    partOf: null,
    visibleStructure: {
      cabinetBody: 'uncertain',
      cabinetDoors: 'uncertain',
      basinBowl: 'uncertain',
      pedestalToFloor: 'uncertain',
      toiletBowl: 'uncertain',
      toiletTank: 'uncertain',
      transparentPanel: 'uncertain',
      reflectivePanel: 'present',
    },
  };
  const observation = await validateTargetExistenceAnalysis(
    { receipt, rawText: JSON.stringify(row) },
    receipt,
  );
  const correction = await applyReflectionRechecks({
    ...context,
    expected: {
      photoFingerprint: fingerprint,
      image: input.image,
      modelId: LAB_QWEN_MODEL,
      modelRevision: previous.inventory.modelRevision,
      requests: [receipt],
    },
    observations: [observation],
  });
  const prepared = {
    requests: [receipt],
    inputs: [
      {
        receipt,
        fullPhoto: new Blob([new Uint8Array(full)], { type: 'image/jpeg' }),
        cropPhoto: new Blob([new Uint8Array(crop)], { type: 'image/jpeg' }),
      },
    ],
    photoFingerprint: fingerprint,
    image: input.image,
  };
  vi.mocked(prepareReflectionRecheckRequests).mockResolvedValue(prepared);
  deps.appearance = vi.fn().mockResolvedValue(appearance);
  vi.mocked(deps.reflectionRecheck!).mockResolvedValue({ ...correction, measurements: [] });
  vi.clearAllMocks();
  return { previous, appearance, context, correction, prepared };
}

describe('reflection orchestration (mock model/crop boundary, real receipt and decision validation)', () => {
  it('protects manually placed current candidates from reflection calls and preserves their transforms', async () => {
    const { appearance } = await reflectionStages();
    const manualPlacements = { item_01: {
      face: 'back' as const, u: 0.42, v: 0.2, baseHeightMm: 1150,
      widthMm: 630, heightMm: 810, depthMm: 45, yawDegrees: 0,
    } };
    const preserved = structuredClone({ appearance, manualPlacements });
    const result = await runQualityPipeline({
      ...input, estimatedLayout: true, refineAppearance: true, refineReflection: true, manualPlacements,
    }, deps);
    expect(deps.reflectionRecheck).not.toHaveBeenCalled();
    expect(prepareReflectionRecheckRequests).not.toHaveBeenCalled();
    expect(result.evidence.effectiveUnderstanding).toEqual(appearance.understanding);
    expect(result.evidence.appearance).toEqual(preserved.appearance);
    expect(manualPlacements).toEqual(preserved.manualPlacements);
    expect(vi.mocked(buildCandidatePipeline).mock.calls[0][4]).toEqual(preserved.manualPlacements);
    expect(vi.mocked(buildEstimatedCandidatePipeline).mock.calls[0][0].manualIdSet).toEqual(new Set(['item_01']));
    vi.clearAllMocks();
    const reused = await runQualityPipeline({
      ...input, estimatedLayout: true, refineReflection: true, manualPlacements, reuse: result.evidence,
    }, deps);
    expect(reused.evidence.reused).toBe(true);
    expect(deps.reflectionRecheck).not.toHaveBeenCalled();
    expect(manualPlacements).toEqual(preserved.manualPlacements);
  });

  it('excludes placement IDs outside appearance from its protection signature, preserving the existing placement validation', async () => {
    await reflectionStages();
    const manualPlacements = { removed_id: { face: 'back' as const, u: 0.2, v: 0.3, baseHeightMm: 900 } };
    const preserved = structuredClone(manualPlacements);
    await expect(runQualityPipeline({
      ...input, estimatedLayout: true, refineAppearance: true, refineReflection: true, manualPlacements,
    }, deps)).rejects.toThrow('수동 배치가 알 수 없는 설비');
    expect(deps.reflectionRecheck).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.reflectionRecheck!).mock.calls[0][1].protectedCandidateIds).toEqual(new Set());
    expect(manualPlacements).toEqual(preserved);
  });

  it('does not reapply an old reflection correction after the candidate becomes manually placed', async () => {
    const { appearance, correction } = await reflectionStages();
    const result = await runQualityPipeline({
      ...input, estimatedLayout: true, appearanceObservation: appearance, reflectionRecheckObservation: correction.record,
    }, deps);
    const preserved = structuredClone(result.evidence);
    const manualPlacements = { item_01: { face: 'back' as const, u: 0.42, v: 0.2, baseHeightMm: 1150 } };
    vi.clearAllMocks();
    await expect(runQualityPipeline({
      ...input, estimatedLayout: true, manualPlacements, reuse: result.evidence,
    }, deps)).rejects.toThrow('재사용');
    expect(result.evidence).toEqual(preserved);
    expectNoInferenceOrPlacement();
    expect(deps.reflectionRecheck).not.toHaveBeenCalled();
  });

  it('corrects effective reflection before fresh layout while preserving raw appearance and original installation', async () => {
    const { previous, appearance, context, correction } = await reflectionStages();
    const preserved = structuredClone(appearance);
    const result = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        refineAppearance: true,
        refineReflection: true,
      },
      deps,
    );
    expect(deps.reflectionRecheck).toHaveBeenCalledWith(
      input.photo,
      context,
      input.signal,
      previous.inventory.modelRevision,
    );
    expect(prepareReflectionRecheckRequests).toHaveBeenCalledWith(
      input.photo,
      context,
      previous.inventory.modelRevision,
      input.signal,
      'local-ollama',
    );
    expect(deps.layout).toHaveBeenCalledWith(input.photo, correction.understanding, input.signal);
    expect(result.evidence.layout!.inventorySignature).toBe(
      layoutInventorySignature(correction.understanding),
    );
    expect(result.evidence.layout!.inventorySignature).not.toBe(
      layoutInventorySignature(appearance.understanding),
    );
    expect(vi.mocked(deps.reflectionRecheck!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.layout!).mock.invocationCallOrder[0],
    );
    expect(result.evidence.appearance).toEqual(preserved);
    expect(appearance).toEqual(preserved);
    expect(result.evidence.installation).toEqual(previous.installation);
    expect(result.evidence.effectiveUnderstanding).toEqual(correction.understanding);
    const args = vi.mocked(buildEstimatedCandidatePipeline).mock.calls[0][0];
    expect(args.understanding.candidates[0].reflection).toBe('physical');
    expect(args.appearance?.modelOptions).toEqual(appearance.modelOptions);
    expect(args.appearance?.decisions[0].effective.reflection).toBe('reflected');
  });

  it('does not request conflict rechecks without explicit refinement or silently upgrade legacy evidence', async () => {
    const { previous, appearance } = await reflectionStages();
    const fresh = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        appearanceObservation: appearance,
      },
      deps,
    );
    expect(fresh.evidence.effectiveUnderstanding.candidates[0].reflection).toBe('reflected');
    expect(deps.reflectionRecheck).not.toHaveBeenCalled();
    const legacy = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        reuse: previous,
        appearanceObservation: appearance,
      },
      deps,
    );
    vi.clearAllMocks();
    await expect(
      runQualityPipeline(
        {
          ...input,
          estimatedLayout: true,
          reuse: legacy.evidence,
          refineReflection: true,
        },
        deps,
      ),
    ).rejects.toThrow('새 분석을 명시적으로');
    await expect(runQualityPipeline({ ...input, refineReflection: true }, deps)).rejects.toThrow('명시적으로');
    expectNoInferenceOrPlacement();
    expect(deps.reflectionRecheck).not.toHaveBeenCalled();
    expect(prepareReflectionRecheckRequests).not.toHaveBeenCalled();
  });

  it('roundtrips a corrected record and revalidates its receipts without a model call', async () => {
    const { previous, appearance, correction } = await reflectionStages();
    const first = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        reuse: previous,
        appearanceObservation: appearance,
        reflectionRecheckObservation: correction.record,
      },
      deps,
    );
    const saved: ReconstructionQualityEvidence = JSON.parse(JSON.stringify(first.evidence));
    vi.clearAllMocks();
    const second = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        reuse: saved,
        refineReflection: true,
      },
      deps,
    );
    expect(second.evidence.reflectionRecheck).toEqual(correction.record);
    expect(second.evidence.appearance).toEqual(appearance);
    expect(second.evidence.effectiveUnderstanding).toEqual(correction.understanding);
    expect(second.evidence.timing.reflectionRecheckMs).toBe(0);
    expect(prepareReflectionRecheckRequests).toHaveBeenCalled();
    for (const stage of [
      deps.inventory,
      deps.identity,
      deps.installation,
      deps.geometry,
      deps.appearance,
      deps.reflectionRecheck,
      deps.showerDetails,
      deps.layout,
    ])
      expect(stage).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).toHaveBeenCalledOnce();
  });

  it.each<[string, (record: ReflectionRecheckEvidence) => void]>([
    [
      'legacy rule revision',
      (r) => {
        r.ruleRevision = 'reflection-one-field-v1';
      },
    ],
    [
      'saved decision',
      (r) => {
        r.decisions[0].effectiveReflection = 'reflected';
      },
    ],
    [
      'saved request byte SHA',
      (r) => {
        r.requests[0].cropSha256 = 'c'.repeat(64);
      },
    ],
    [
      'saved raw response',
      (r) => {
        r.observations[0].rawText = '{"kind":"mirror"}';
      },
    ],
  ])('rejects a tampered %s before placement without overwriting stored evidence', async (_name, corrupt) => {
    const { previous, appearance, correction } = await reflectionStages();
    const first = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        reuse: previous,
        appearanceObservation: appearance,
        reflectionRecheckObservation: correction.record,
      },
      deps,
    );
    const saved = structuredClone(first.evidence);
    corrupt(saved.reflectionRecheck!);
    const preserved = structuredClone(saved);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, estimatedLayout: true, reuse: saved }, deps)).rejects.toThrow(
      '보관된 정밀 관측',
    );
    expect(saved).toEqual(preserved);
    expectNoInferenceOrPlacement();
    expect(deps.reflectionRecheck).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
  });

  it.each(['model', 'receipt-preparation'] as const)(
    'drops a late %s completion after cancellation before fresh layout/evidence',
    async (stage) => {
      const { appearance, correction, prepared } = await reflectionStages();
      const controller = new AbortController(),
        checkpoint = vi.fn();
      if (stage === 'model') {
        vi.mocked(deps.reflectionRecheck!).mockImplementation(async () => {
          controller.abort();
          return { ...correction, measurements: [] };
        });
      } else {
        vi.mocked(prepareReflectionRecheckRequests).mockImplementation(async () => {
          controller.abort();
          return prepared;
        });
      }
      await expect(
        runQualityPipeline(
          {
            ...input,
            signal: controller.signal,
            onCheckpoint: checkpoint,
            estimatedLayout: true,
            appearanceObservation: appearance,
            refineReflection: true,
          },
          deps,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(deps.layout).not.toHaveBeenCalled();
      expect(buildCandidatePipeline).not.toHaveBeenCalled();
      expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
      expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('reflectionRecheckValidated');
      expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('qualityEvidence');
    },
  );
});

// Authored fixed-region material observations exercise orchestration, not actual AI recognition.
import type { LocalDividerAnalysis } from '../src/lib/reconstruction/analysis-client';
import {
  parseDividerObservation,
  DIVIDER_OBSERVATION_CONTRACT,
  DIVIDER_OBSERVATION_PROMPT_REVISION,
  dividerTargetsSignature,
} from '../src/lib/reconstruction/divider-observation';
import { dividerObservationTargets } from '../src/lib/reconstruction/divider-application';

async function dividerStages() {
  await detailStages('shower');
  const original = await deps.inventory(input.photo, input.signal);
  const value = JSON.parse(original.rawText);
  value.items.push({
    kind: 'glassPartition',
    bbox_2d: [620, 100, 900, 900],
    view: 'direct',
    basin: null,
    note: 'Authored fixed region eligible for a separate material observation.',
  });
  const rawText = JSON.stringify(value);
  const inventory = {
    ...original,
    rawText,
    understanding: parseFixtureInventory(rawText, EXTENDED_INVENTORY_OUTPUT_CONTRACT).understanding,
  };
  vi.mocked(deps.inventory).mockResolvedValue(inventory);
  deps.dividerMaterials = vi.fn();
  const previous = (await runQualityPipeline(input, deps)).evidence;
  vi.clearAllMocks();
  return previous;
}
async function authoredDivider(previous: ReconstructionQualityEvidence): Promise<LocalDividerAnalysis> {
  const targets = dividerObservationTargets(previous.effectiveUnderstanding, previous.appearance);
  const rawText = JSON.stringify({
    schemaVersion: 1,
    observations: targets.map(({ id }) => ({
      id,
      note: 'Authored flexible hanging sheet with visible rod attachment; not photo-quality evidence.',
      context: 'physical',
      dividerMaterial: 'fabric-curtain',
      visibleExtent: 'whole',
      support: 'rod',
    })),
  });
  return {
    ...parseDividerObservation(rawText, targets),
    outputContract: DIVIDER_OBSERVATION_CONTRACT,
    promptRevision: DIVIDER_OBSERVATION_PROMPT_REVISION,
    modelId: previous.inventory.modelId,
    modelRevision: previous.inventory.modelRevision,
    measurement: { ...previous.inventory.measurement, memoryScope: 'Mock divider inference boundary' },
    rawText,
    photoFingerprint: previous.photoFingerprint,
    modelInputSha256: await photoFingerprint(new Blob(['authored-divider-model-preview'])),
    inventorySignature: layoutInventorySignature(previous.effectiveUnderstanding),
  };
}
async function freshDividerEvidence() {
  const previous = await dividerStages();
  const shower = await authoredShower(previous),
    divider = await authoredDivider(previous);
  vi.mocked(deps.showerDetails!).mockResolvedValue(shower);
  vi.mocked(deps.dividerMaterials!).mockResolvedValue(divider);
  const result = await runQualityPipeline(
    { ...input, estimatedLayout: true, refineShowerDetails: true, refineDividerMaterials: true },
    deps,
  );
  return { previous, shower, divider, result };
}
function expectNoOptionalDetailInference() {
  for (const fn of [
    deps.appearance,
    deps.reflectionRecheck,
    deps.showerDetails,
    deps.dividerMaterials,
    deps.layout,
  ])
    if (fn) expect(fn).not.toHaveBeenCalled();
}

describe('divider material orchestration (mock model, real fixed-target validation and application)', () => {
  it('keeps the new stage opt-in and rejects it outside the explicitly selected estimated path', async () => {
    const previous = await dividerStages();
    const result = await runQualityPipeline({ ...input, estimatedLayout: true }, deps);
    expect(deps.dividerMaterials).not.toHaveBeenCalled();
    expect(result.evidence.dividerMaterials).toBeUndefined();
    expect(result.evidence.dividerApplication).toBeUndefined();
    expect(result.evidence.timing.dividerMaterialsMs).toBe(0);
    expect(result.evidence.effectiveUnderstanding).toEqual(previous.effectiveUnderstanding);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, refineDividerMaterials: true }, deps)).rejects.toThrow(
      '명시적으로',
    );
    await expect(
      runQualityPipeline({ ...input, dividerMaterialsObservation: await authoredDivider(previous) }, deps),
    ).rejects.toThrow('명시적으로');
    expectNoInferenceOrPlacement();
    expectNoOptionalDetailInference();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
  });
  it('does not request divider material inference when no eligible fixed target exists', async () => {
    const previous = await detailStages('shower');
    deps.dividerMaterials = vi.fn();
    expect(dividerObservationTargets(previous.effectiveUnderstanding)).toEqual([]);
    const result = await runQualityPipeline(
      { ...input, estimatedLayout: true, refineDividerMaterials: true },
      deps,
    );
    expect(deps.dividerMaterials).not.toHaveBeenCalled();
    expect(result.evidence.dividerMaterials).toBeUndefined();
    expect(result.evidence.effectiveUnderstanding).toEqual(previous.effectiveUnderstanding);
  });
  it('runs after shower details and before fresh layout, preserving original inventory and separate source signatures', async () => {
    const previous = await dividerStages();
    const shower = await authoredShower(previous),
      divider = await authoredDivider(previous);
    const original = structuredClone(previous),
      rawDetail = structuredClone(divider),
      checkpoint = vi.fn();
    vi.mocked(deps.showerDetails!).mockResolvedValue(shower);
    vi.mocked(deps.dividerMaterials!).mockResolvedValue(divider);
    const result = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        refineShowerDetails: true,
        refineDividerMaterials: true,
        onCheckpoint: checkpoint,
      },
      deps,
    );
    const targets = dividerObservationTargets(previous.effectiveUnderstanding);
    expect(deps.showerDetails).toHaveBeenCalledWith(
      input.photo,
      previous.effectiveUnderstanding,
      input.signal,
    );
    expect(deps.dividerMaterials).toHaveBeenCalledWith(
      input.photo,
      previous.effectiveUnderstanding,
      targets,
      input.signal,
    );
    expect(vi.mocked(deps.showerDetails!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.dividerMaterials!).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(deps.dividerMaterials!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.layout!).mock.invocationCallOrder[0],
    );
    const effective = result.evidence.effectiveUnderstanding;
    expect(effective.candidates[1]).toMatchObject({
      id: 'item_02',
      kind: 'showerCurtain',
      mounting: 'suspended',
      wall: 'unknown',
    });
    expect(effective.candidates[1].bounds).toEqual(previous.effectiveUnderstanding.candidates[1].bounds);
    expect(effective.candidates[0]).toEqual(previous.effectiveUnderstanding.candidates[0]);
    expect(deps.layout).toHaveBeenCalledWith(input.photo, effective, input.signal);
    expect(result.evidence.layout!.inventorySignature).toBe(layoutInventorySignature(effective));
    expect(result.evidence.layout!.inventorySignature).not.toBe(divider.inventorySignature);
    expect(divider.targetsSignature).toBe(dividerTargetsSignature(targets));
    expect(result.evidence.dividerMaterials).toEqual(divider);
    expect(result.evidence.showerDetails!.inventorySignature).toBe(
      layoutInventorySignature(previous.effectiveUnderstanding),
    );
    expect(result.evidence.dividerApplication!.modelOptions.item_02).toEqual({
      curtainHardware: 'rod',
      provenance: { curtainHardware: 'model' },
    });
    const args = vi.mocked(buildEstimatedCandidatePipeline).mock.calls.at(-1)![0];
    expect(args.understanding).toEqual(effective);
    expect(args.dividerApplication).toEqual(result.evidence.dividerApplication);
    expect(args.showerDetails).toEqual(shower.observations);
    expect(result.evidence.inventory).toEqual(previous.inventory);
    expect(result.evidence.identity).toEqual(previous.identity);
    expect(result.evidence.installation).toEqual(previous.installation);
    expect(result.evidence.timing.dividerMaterialsMs).toBeGreaterThanOrEqual(0);
    const names = checkpoint.mock.calls.map(([name]) => name);
    expect(names.indexOf('showerDetailsResponse')).toBeLessThan(names.indexOf('dividerMaterialsResponse'));
    expect(names.indexOf('dividerApplication')).toBeLessThan(names.indexOf('layoutResponse'));
    expect(names).toContain('qualityEvidence');
    expect(previous).toEqual(original);
    expect(divider).toEqual(rawDetail);
  });
  it('does not silently run the new model step when reusing older evidence without material details', async () => {
    const previous = await dividerStages(),
      copy = structuredClone(previous);
    const replay = await runQualityPipeline({ ...input, estimatedLayout: true, reuse: previous }, deps);
    expect(replay.evidence.dividerMaterials).toBeUndefined();
    expectNoOptionalDetailInference();
    vi.clearAllMocks();
    await expect(
      runQualityPipeline(
        { ...input, estimatedLayout: true, reuse: previous, refineDividerMaterials: true },
        deps,
      ),
    ).rejects.toThrow('새 분석을 명시적으로');
    expectNoInferenceOrPlacement();
    expectNoOptionalDetailInference();
    expect(previous).toEqual(copy);
  });
  it('accepts an explicitly supplied validated material observation without calling inference', async () => {
    const previous = await dividerStages(),
      divider = await authoredDivider(previous);
    const result = await runQualityPipeline(
      { ...input, estimatedLayout: true, reuse: previous, dividerMaterialsObservation: divider },
      deps,
    );
    expect(result.evidence.dividerMaterials).toEqual(divider);
    expect(result.evidence.effectiveUnderstanding.candidates[1].kind).toBe('showerCurtain');
    expect(result.evidence.timing.dividerMaterialsMs).toBe(0);
    expect(deps.dividerMaterials).not.toHaveBeenCalled();
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(deps.layout).not.toHaveBeenCalled();
  });
  it('roundtrips both detail stages without AI and validates shower signatures against the pre-curtain inventory', async () => {
    const { previous, shower, divider, result } = await freshDividerEvidence();
    const saved: ReconstructionQualityEvidence = JSON.parse(JSON.stringify(result.evidence));
    const copy = structuredClone(saved);
    expect(saved.showerDetails!.inventorySignature).toBe(
      layoutInventorySignature(previous.effectiveUnderstanding),
    );
    expect(saved.showerDetails!.inventorySignature).not.toBe(
      layoutInventorySignature(saved.effectiveUnderstanding),
    );
    vi.clearAllMocks();
    const replay = await runQualityPipeline(
      {
        ...input,
        estimatedLayout: true,
        reuse: saved,
        refineShowerDetails: true,
        refineDividerMaterials: true,
      },
      deps,
    );
    expect(replay.evidence.showerDetails).toEqual(shower);
    expect(replay.evidence.dividerMaterials).toEqual(divider);
    expect(replay.evidence.dividerApplication).toEqual(saved.dividerApplication);
    expect(replay.evidence.effectiveUnderstanding).toEqual(saved.effectiveUnderstanding);
    expect(replay.evidence.layout).toEqual(saved.layout);
    expect(replay.evidence.timing.dividerMaterialsMs).toBe(0);
    expect(replay.evidence.timing.showerDetailsMs).toBe(0);
    expect(replay.evidence.timing.layoutMs).toBe(0);
    for (const fn of [deps.inventory, deps.identity, deps.installation, deps.geometry, deps.segmentation])
      expect(fn).not.toHaveBeenCalled();
    expectNoOptionalDetailInference();
    expect(vi.mocked(buildEstimatedCandidatePipeline).mock.calls[0][0].dividerApplication).toEqual(
      saved.dividerApplication,
    );
    expect(saved).toEqual(copy);
  });
  it.each<[string, (value: LocalDividerAnalysis) => void]>([
    [
      'source photo hash',
      (v) => {
        v.photoFingerprint = 'c'.repeat(64);
      },
    ],
    [
      'model preview hash format',
      (v) => {
        v.modelInputSha256 = 'invalid';
      },
    ],
    [
      'model id',
      (v) => {
        v.modelId = 'another-model';
      },
    ],
    [
      'model revision',
      (v) => {
        v.modelRevision = 'c'.repeat(64);
      },
    ],
    [
      'source inventory signature',
      (v) => {
        v.inventorySignature = 'different';
      },
    ],
    [
      'target bounds signature',
      (v) => {
        v.targetsSignature = JSON.stringify([
          { id: 'item_02', bounds: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 } },
        ]);
      },
    ],
    [
      'raw target identity',
      (v) => {
        v.rawText = v.rawText.replace('item_02', 'item_99');
      },
    ],
    [
      'raw/parsed disagreement',
      (v) => {
        v.observations[0].support = 'track';
      },
    ],
    [
      'raw warning mismatch',
      (v) => {
        v.warnings.push({
          candidateId: 'item_02',
          code: 'target-not-confirmed-direct',
          action: 'retain-raw-do-not-apply',
        });
      },
    ],
  ])('rejects fresh %s before application, layout or the solver', async (_name, corrupt) => {
    const previous = await dividerStages(),
      detail = await authoredDivider(previous);
    corrupt(detail);
    const preserved = structuredClone(detail),
      checkpoint = vi.fn();
    vi.mocked(deps.dividerMaterials!).mockResolvedValue(detail);
    await expect(
      runQualityPipeline(
        { ...input, estimatedLayout: true, refineDividerMaterials: true, onCheckpoint: checkpoint },
        deps,
      ),
    ).rejects.toThrow('칸막이');
    expect(deps.layout).not.toHaveBeenCalled();
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
    expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('dividerApplication');
    expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('qualityEvidence');
    expect(detail).toEqual(preserved);
  });
  it.each<[string, (value: ReconstructionQualityEvidence) => void]>([
    [
      'saved raw material answer',
      (v) => {
        v.dividerMaterials!.rawText = v.dividerMaterials!.rawText.replace('fabric-curtain', 'rigid-glass');
      },
    ],
    [
      'saved target signature',
      (v) => {
        v.dividerMaterials!.targetsSignature = 'another-target';
      },
    ],
    [
      'saved model revision',
      (v) => {
        v.dividerMaterials!.modelRevision = 'e'.repeat(64);
      },
    ],
    [
      'derived model hardware',
      (v) => {
        v.dividerApplication!.modelOptions.item_02.curtainHardware = 'track';
      },
    ],
    [
      'derived effective candidate',
      (v) => {
        v.dividerApplication!.understanding.candidates[1].bounds.left += 0.01;
      },
    ],
    [
      'derived decision',
      (v) => {
        v.dividerApplication!.decisions[0].status = 'held';
      },
    ],
    [
      'missing raw observation',
      (v) => {
        delete v.dividerMaterials;
      },
    ],
  ])('rejects %s from saved quality evidence without silently rerunning AI', async (_name, corrupt) => {
    const { result } = await freshDividerEvidence();
    const saved: ReconstructionQualityEvidence = JSON.parse(JSON.stringify(result.evidence));
    corrupt(saved);
    const copy = structuredClone(saved);
    vi.clearAllMocks();
    await expect(runQualityPipeline({ ...input, estimatedLayout: true, reuse: saved }, deps)).rejects.toThrow(
      '보관된 정밀 관측',
    );
    expectNoInferenceOrPlacement();
    expectNoOptionalDetailInference();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
    expect(saved).toEqual(copy);
  });
  it('rejects a layout signed for the old glass inventory after material application without reusing its camera relations', async () => {
    const { previous, result } = await freshDividerEvidence();
    const saved: ReconstructionQualityEvidence = JSON.parse(JSON.stringify(result.evidence));
    saved.layout!.inventorySignature = layoutInventorySignature(previous.effectiveUnderstanding);
    const copy = structuredClone(saved),
      checkpoint = vi.fn();
    vi.clearAllMocks();
    await expect(
      runQualityPipeline({ ...input, estimatedLayout: true, reuse: saved, onCheckpoint: checkpoint }, deps),
    ).rejects.toThrow('공간 관계 관측');
    expectNoOptionalDetailInference();
    expect(deps.inventory).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
    expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('layoutResponse');
    expect(checkpoint.mock.calls.map(([name]) => name)).not.toContain('qualityEvidence');
    expect(saved).toEqual(copy);
  });
  it('drops a late divider response after cancellation before applying or publishing it', async () => {
    const previous = await dividerStages(),
      divider = await authoredDivider(previous);
    const controller = new AbortController(),
      checkpoint = vi.fn();
    vi.mocked(deps.dividerMaterials!).mockImplementation(async () => {
      controller.abort();
      return divider;
    });
    await expect(
      runQualityPipeline(
        {
          ...input,
          signal: controller.signal,
          estimatedLayout: true,
          refineDividerMaterials: true,
          onCheckpoint: checkpoint,
        },
        deps,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(buildCandidatePipeline).not.toHaveBeenCalled();
    expect(buildEstimatedCandidatePipeline).not.toHaveBeenCalled();
    expect(deps.layout).not.toHaveBeenCalled();
    const names = checkpoint.mock.calls.map(([name]) => name);
    expect(names).not.toContain('dividerMaterialsResponse');
    expect(names).not.toContain('dividerApplication');
    expect(names).not.toContain('qualityEvidence');
  });
});
