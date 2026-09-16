import { labCandidateTraces } from '../src/lib/reconstruction/lab-candidate-trace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { fetchAnalysis } from '../src/lib/reconstruction/analysis-transport';
import {
  CLOUD_GEMMA_IDENTITY,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_REVISION,
} from '../src/lib/reconstruction/cloud-gemma-contract';
import {
  analyzeShowerInstallations,
  prepareShowerInstallationRequests,
  validateShowerInstallationRecord,
} from '../src/lib/reconstruction/analysis-client';
import {
  SHOWER_INSTALLATION_CONTRACT,
  SHOWER_INSTALLATION_PROMPT_REVISION,
  type ShowerInstallationContext,
} from '../src/lib/reconstruction/shower-installation-observation';
import type { SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

// Authored mock responses and synthetic pixels only. No model, HTTP server, or browser is started.
vi.mock('../src/lib/reconstruction/analysis-transport', () => ({ fetchAnalysis: vi.fn() }));
vi.mock('../src/lib/images', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/images')>()),
  canvasBlob: vi.fn(async (canvas: HTMLCanvasElement) => {
    const bytes = await sharp({
      create: { width: canvas.width, height: canvas.height, channels: 3, background: '#c0d0e0' },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  }),
}));
const candidate = (id = 'shower-a', changes: Partial<SceneCandidate> = {}): SceneCandidate => ({
  id,
  kind: 'shower',
  mounting: 'wall',
  wall: 'unknown',
  reflection: 'physical',
  basinStyle: 'unknown',
  shape: 'unknown',
  bounds: { left: 0.2, top: 0.2, right: 0.6, bottom: 0.7 },
  evidence: ['Authored test observation'],
  uncertainty: [],
  provenance: { kind: 'model' },
  ...changes,
});
const context = (...candidates: SceneCandidate[]): ShowerInstallationContext => ({
  understanding: {
    schemaVersion: 1,
    candidates: candidates.length ? candidates : [candidate()],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  },
  sourceDecisionSignature: 'authored original inventory and shower detail signature',
  protectedCandidateIds: new Set(),
});
const rawText = JSON.stringify({
  schemaVersion: 1,
  note: 'Authored open pipe and temporary line test; no installed head or finished controls.',
  installationState: 'unfinished-plumbing',
  view: 'direct',
  scope: 'multiple-targets',
  visibleHardware: {
    recognizableSprayHeadBody: 'absent',
    sprayOutletFace: 'absent',
    headMountOrSupport: 'absent',
    finishedUserControl: 'absent',
    flexibleWaterHose: 'present',
    unfinishedPipeEnd: 'present',
    looseServiceLoop: 'absent',
  },
});
let photo: Blob;
const close = vi.fn();
const canvases: { width: number; height: number }[] = [];
const signal = () => new AbortController().signal;
function mockProvider(transform: (value: Record<string, unknown>) => void = () => {}) {
  vi.mocked(fetchAnalysis).mockImplementation(async (_provider, init) => {
    const form = init!.body as FormData;
    expect(form.get('operation')).toBe('shower-installation');
    expect([...form.keys()].sort()).toEqual(['crop', 'operation', 'photo', 'receipt']);
    const value = {
      provider: 'cloudflare-workers-ai',
      modelId: CLOUD_GEMMA_MODEL,
      modelRevision: CLOUD_GEMMA_REVISION,
      modelIdentity: CLOUD_GEMMA_IDENTITY,
      outputContract: SHOWER_INSTALLATION_CONTRACT,
      promptRevision: SHOWER_INSTALLATION_PROMPT_REVISION,
      receipt: JSON.parse(String(form.get('receipt'))),
      rawText,
      measurement: {
        requestMs: 2,
        inferenceCalls: 1,
        modelDownload: 'provider-managed',
        memoryScope: 'Synthetic offline mock, no AI',
      },
    };
    transform(value);
    return Response.json(value);
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  canvases.length = 0;
  photo = new Blob(
    [
      new Uint8Array(
        await sharp({ create: { width: 120, height: 100, channels: 3, background: '#c0d0e0' } })
          .png()
          .toBuffer(),
      ),
    ],
    { type: 'image/png' },
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 120, height: 100, close })),
  );
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }),
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  mockProvider();
});
afterEach(() => vi.unstubAllGlobals());

describe('shower installedness client / saved evidence (offline mock boundary)', () => {
  it('prepares exact byte receipts without HTTP and releases the bitmap and canvases', async () => {
    const prepared = await prepareShowerInstallationRequests(
      photo,
      context(),
      CLOUD_GEMMA_REVISION,
      signal(),
    );
    expect(prepared.requests).toHaveLength(1);
    expect(prepared.requests[0]).toMatchObject({
      targetId: 'shower-a',
      sourceImage: { width: 120, height: 100 },
      targetBounds: candidate().bounds,
    });
    expect(fetchAnalysis).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(canvases.every((value) => value.width === 1 && value.height === 1)).toBe(true);
  });
  it('calls once per unprotected physical shower, retains raw text and measures each call once', async () => {
    const ctx = context(
      candidate(),
      candidate('manual'),
      candidate('reflection', { reflection: 'reflected' }),
      candidate('user', { provenance: { kind: 'user' } }),
      candidate('other', { kind: 'toilet' }),
    );
    ctx.protectedCandidateIds = new Set(['manual']);
    const original = structuredClone(ctx),
      measured = vi.fn();
    const result = await analyzeShowerInstallations(photo, ctx, signal(), CLOUD_GEMMA_REVISION, measured);
    expect(fetchAnalysis).toHaveBeenCalledOnce();
    expect(measured).toHaveBeenCalledOnce();
    expect(result.measurements).toHaveLength(1);
    expect(result.record.requests.map((value) => value.targetId)).toEqual(['shower-a']);
    expect(result.record.observations[0].rawText).toBe(rawText);
    expect(result.record.decisions[0]).toMatchObject({
      action: 'hold',
      proposedAfter: { candidate: candidate(), placement: 'hold-for-review' },
    });
    expect(ctx).toEqual(original);
  });
  it('revalidates saved bytes/raw/decisions without a second call and recomputes new manual protection', async () => {
    const ctx = context(),
      first = await analyzeShowerInstallations(photo, ctx, signal(), CLOUD_GEMMA_REVISION);
    const snapshot = structuredClone(first.record);
    const saved = await validateShowerInstallationRecord(
      first.record,
      photo,
      ctx,
      CLOUD_GEMMA_REVISION,
      signal(),
    );
    expect(saved).toEqual(first.record);
    ctx.protectedCandidateIds = new Set(['shower-a']);
    const protectedRecord = await validateShowerInstallationRecord(
      first.record,
      photo,
      ctx,
      CLOUD_GEMMA_REVISION,
      signal(),
    );
    expect(protectedRecord.decisions[0]).toMatchObject({
      action: 'unchanged',
      reasons: ['protected-user-candidate'],
    });
    expect(fetchAnalysis).toHaveBeenCalledOnce();
    expect(first.record).toEqual(snapshot);
  });
  it('rejects a missing eligible observation and performs no implicit recovery call', async () => {
    const ctx = context(),
      first = await analyzeShowerInstallations(photo, ctx, signal(), CLOUD_GEMMA_REVISION);
    first.record.requests = [];
    first.record.observations = [];
    first.record.decisions = [];
    await expect(
      validateShowerInstallationRecord(first.record, photo, ctx, CLOUD_GEMMA_REVISION, signal()),
    ).rejects.toThrow('명시적으로');
    expect(fetchAnalysis).toHaveBeenCalledOnce();
  });
  it.each(['decision', 'raw', 'photo', 'source'] as const)(
    'rejects stale or forged %s evidence without calling AI',
    async (mode) => {
      const ctx = context(),
        first = await analyzeShowerInstallations(photo, ctx, signal(), CLOUD_GEMMA_REVISION);
      let currentPhoto = photo;
      if (mode === 'decision') first.record.decisions[0].action = 'keep';
      if (mode === 'raw')
        first.record.observations[0].rawText = rawText.replace('unfinished-plumbing', 'temporary-services');
      if (mode === 'source') ctx.sourceDecisionSignature = 'changed original decision';
      if (mode === 'photo')
        currentPhoto = new Blob(
          [
            new Uint8Array(
              await sharp({ create: { width: 120, height: 100, channels: 3, background: '#fff' } })
                .png()
                .toBuffer(),
            ),
          ],
          { type: 'image/png' },
        );
      await expect(
        validateShowerInstallationRecord(first.record, currentPhoto, ctx, CLOUD_GEMMA_REVISION, signal()),
      ).rejects.toThrow();
      expect(fetchAnalysis).toHaveBeenCalledOnce();
    },
  );
  it.each(['model', 'receipt', 'raw'] as const)(
    'rejects the provider %s boundary with no fallback',
    async (mode) => {
      mockProvider((value) => {
        if (mode === 'model') value.modelRevision = 'obsolete';
        if (mode === 'receipt') (value.receipt as Record<string, unknown>).targetId = 'foreign-target';
        if (mode === 'raw') value.rawText = '{}';
      });
      await expect(
        analyzeShowerInstallations(photo, context(), signal(), CLOUD_GEMMA_REVISION),
      ).rejects.toThrow('검증');
      expect(fetchAnalysis).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );
  it('cancels before preparation without HTTP and refuses a response delivered after abort', async () => {
    const before = new AbortController();
    before.abort();
    await expect(
      analyzeShowerInstallations(photo, context(), before.signal, CLOUD_GEMMA_REVISION),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchAnalysis).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
    const pending = new AbortController();
    mockProvider(() => pending.abort());
    await expect(
      analyzeShowerInstallations(photo, context(), pending.signal, CLOUD_GEMMA_REVISION),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchAnalysis).toHaveBeenCalledOnce();
  });
  it('does no HTTP for a scene with no eligible showers', async () => {
    const ctx = context(candidate('toilet', { kind: 'toilet' }));
    const result = await analyzeShowerInstallations(photo, ctx, signal(), CLOUD_GEMMA_REVISION);
    expect(result.record.requests).toEqual([]);
    expect(result.measurements).toEqual([]);
    await expect(
      validateShowerInstallationRecord(result.record, photo, ctx, CLOUD_GEMMA_REVISION, signal()),
    ).resolves.toEqual(result.record);
    expect(fetchAnalysis).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});

describe('shower installation placement integration (synthetic mock evidence, no model)', () => {
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    planes: [],
    candidates: [],
    warnings: [],
  };
  async function placementInput() {
    const ctx = context(),
      result = await analyzeShowerInstallations(photo, ctx, signal(), CLOUD_GEMMA_REVISION);
    const understanding = ctx.understanding,
      image = { width: 120, height: 100 },
      room = DEFAULT_ROOM;
    return {
      understanding,
      image,
      room,
      baseline,
      strictResult: buildCandidatePipeline(understanding, baseline, room, image),
      showerInstallationDecisions: result.record.decisions,
    };
  }
  it('keeps the original candidate and raw observation while holding its plan for review', async () => {
    const input = await placementInput(),
      original = structuredClone(input.understanding);
    const output = buildEstimatedCandidatePipeline(input);
    expect(output.plans['shower-a']).toBeNull();
    expect(
      output.pipeline?.estimatedLayout?.nodes.find((value) => value.candidateId === 'shower-a'),
    ).toMatchObject({ status: 'held' });
    expect(output.review.candidates.find((value) => value.id === 'shower-a')).toMatchObject({
      status: 'unplaced',
      requiresReview: true,
      warning: expect.stringContaining('미설치'),
    });
    expect(output.pipeline?.estimatedLayout?.showerInstallationDecisions?.[0].analysis.rawText).toBe(rawText);
    const trace = labCandidateTraces({
      review: output.review,
      fixtures: [],
      pipeline: output.pipeline as NonNullable<Parameters<typeof labCandidateTraces>[0]['pipeline']>,
    })
      .find((value) => value.candidateId === 'shower-a')
      ?.stages.find((value) => value.id === 'showerInstallation');
    expect(trace).toMatchObject({
      status: 'held',
      input: { receipt: input.showerInstallationDecisions[0].analysis.receipt },
      output: { rawText, placementStatus: 'held' },
    });
    expect(trace?.reasons.join(' ')).toContain('미설치');
    expect(input.understanding).toEqual(original);
  });
  it('checks latest manual protection at placement even if the earlier async decision proposed hold', async () => {
    const input = await placementInput();
    const output = buildEstimatedCandidatePipeline({ ...input, manualIdSet: new Set(['shower-a']) });
    expect(
      output.pipeline?.estimatedLayout?.nodes
        .find((value) => value.candidateId === 'shower-a')
        ?.reasons.join(' '),
    ).not.toContain('미설치 배관');
    expect(input.showerInstallationDecisions[0].action).toBe('hold');
  });
  it('does not apply a hold against changed candidate evidence', async () => {
    const input = await placementInput();
    input.understanding.candidates[0].evidence.push('newly verified candidate detail');
    const output = buildEstimatedCandidatePipeline(input);
    expect(
      output.pipeline?.estimatedLayout?.nodes
        .find((value) => value.candidateId === 'shower-a')
        ?.reasons.join(' '),
    ).not.toContain('미설치 배관');
  });
});
