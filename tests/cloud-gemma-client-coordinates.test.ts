import { CLOUD_GEMMA_GROUPED_INVENTORY_METADATA } from '../src/lib/reconstruction/cloud-gemma-inventory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeExtendedScene } from '../src/lib/reconstruction/analysis-client';
import { fetchAnalysis } from '../src/lib/reconstruction/analysis-transport';
import {
  CLOUD_GEMMA_IDENTITY,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_PROVIDER,
  CLOUD_GEMMA_REVISION,
} from '../src/lib/reconstruction/cloud-gemma-contract';
import {
  EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  EXTENDED_INVENTORY_PROMPT_REVISION,
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';
import { LAB_QWEN_MODEL } from '../src/lib/reconstruction/lab-engine';

vi.mock('../src/lib/reconstruction/analysis-transport', () => ({ fetchAnalysis: vi.fn() }));
vi.mock('../src/lib/images', () => ({
  canvasBlob: vi.fn(async () => new Blob(['synthetic-jpeg'], { type: 'image/jpeg' })),
}));

// Synthetic asymmetric coordinates; no corpus photo coordinates or real model/network invocation.
const canonicalBox = [130, 270, 640, 920];
const nativeBox = [270, 130, 920, 640];
const expectedBounds = { left: 0.13, top: 0.27, right: 0.64, bottom: 0.92 };
const text = (box: number[]) =>
  '\n  ' +
  JSON.stringify({
    items: [{ kind: 'mirror', bbox_2d: box, view: 'direct', basin: null, note: 'Synthetic visible panel' }],
  }) +
  '\n';
const canonicalUnderstanding = () =>
  parseFixtureInventory(text(canonicalBox), EXTENDED_INVENTORY_OUTPUT_CONTRACT).understanding;
const groupedText = (box: number[]) => '\n  ' + JSON.stringify({ sanitary: [], mirrors_storage: JSON.parse(text(box)).items, partitions: [], showers_shelves: [], openings: [] }) + '\n';
const cloudPayload = (cacheHit = false) => ({
  ...CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
  provider: CLOUD_GEMMA_PROVIDER,
  modelId: CLOUD_GEMMA_MODEL,
  modelRevision: CLOUD_GEMMA_REVISION,
  modelIdentity: CLOUD_GEMMA_IDENTITY,
  outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
  promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
  rawText: groupedText(nativeBox),
  understanding: canonicalUnderstanding(),
  measurement: { requestMs: cacheHit ? 0 : 12, cacheHit, inferenceCalls: cacheHit ? 0 : 1 },
  completion: { done: true, doneReason: 'stop', outputTokens: 40, outputTokenLimit: 4096 },
});
const close = vi.fn();
const forbiddenFetch = vi.fn(() => {
  throw new Error('Network is forbidden in this client-coordinate unit test');
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', forbiddenFetch);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 600, height: 960, close })),
  );
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {}, drawImage() {}, fillStyle: '' }),
    }),
  });
});
afterEach(() => {
  expect(forbiddenFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('provider-specific client inventory reparse (mock transport; no AI)', () => {
  it.each([false, true])(
    'preserves native raw bytes and canonical server bounds when cacheHit=%s',
    async (cacheHit) => {
      const source = cloudPayload(cacheHit);
      const originalRawBytes = new TextEncoder().encode(source.rawText);
      vi.mocked(fetchAnalysis).mockResolvedValueOnce(Response.json(source));
      const signal = new AbortController().signal;
      const result = await analyzeExtendedScene(new Blob(), signal, CLOUD_GEMMA_PROVIDER);

      // The old unadapted reparse silently replaced the correct server bounds with these wrong axes.
      expect(() => parseFixtureInventory(source.rawText, EXTENDED_INVENTORY_OUTPUT_CONTRACT)).toThrow();
      expect(result.understanding.candidates[0].bounds).toEqual(expectedBounds);
      expect(result.understanding).toEqual(source.understanding);
      expect(result.rawText).toBe(source.rawText);
      expect(new TextEncoder().encode(result.rawText)).toEqual(originalRawBytes);
      expect(result.measurement).toEqual(source.measurement);
      expect(result.completion).toEqual(source.completion);
      expect(fetchAnalysis).toHaveBeenCalledOnce();
      expect(fetchAnalysis).toHaveBeenCalledWith(
        CLOUD_GEMMA_PROVIDER,
        expect.objectContaining({ method: 'POST', signal, body: expect.any(FormData) }),
      );
      const request = vi.mocked(fetchAnalysis).mock.calls[0][1];
      expect((request.body as FormData).get('operation')).toBe('inventory-extended');
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('revalidates native text independently of transported normalized understanding', async () => {
    const source = cloudPayload();
    source.understanding.candidates[0].bounds = { left: 0.01, top: 0.02, right: 0.03, bottom: 0.04 };
    vi.mocked(fetchAnalysis).mockResolvedValueOnce(Response.json(source));
    const result = await analyzeExtendedScene(
      new Blob(),
      new AbortController().signal,
      CLOUD_GEMMA_PROVIDER,
    );
    expect(result.understanding.candidates[0].bounds).toEqual(expectedBounds);
    expect(result.understanding).not.toEqual(source.understanding);
    expect(result.rawText).toBe(source.rawText);
  });

  it.each(['providerInventoryContract', 'providerInventorySchemaRevision', 'providerInventoryTransform'] as const)('rejects a missing grouped %s instead of guessing from the envelope', async field => {
    const source: Record<string, unknown> = cloudPayload();
    delete source[field];
    vi.mocked(fetchAnalysis).mockResolvedValueOnce(Response.json(source));
    await expect(analyzeExtendedScene(new Blob(), new AbortController().signal, CLOUD_GEMMA_PROVIDER)).rejects.toThrow('구조화');
  });

  it('rejects historical flat provider text even when current metadata is attached', async () => {
    vi.mocked(fetchAnalysis).mockResolvedValueOnce(Response.json({ ...cloudPayload(), rawText: text(nativeBox) }));
    await expect(analyzeExtendedScene(new Blob(), new AbortController().signal, CLOUD_GEMMA_PROVIDER)).rejects.toThrow('구조화');
  });

  it('parses recorded Ollama xyxy bytes with a mocked transport without applying the Gemma permutation', async () => {
    const rawText = text(canonicalBox);
    vi.mocked(fetchAnalysis).mockResolvedValueOnce(
      Response.json({
        modelId: LAB_QWEN_MODEL,
        modelRevision: 'a'.repeat(64),
        outputContract: EXTENDED_INVENTORY_OUTPUT_CONTRACT,
        promptRevision: EXTENDED_INVENTORY_PROMPT_REVISION,
        rawText,
        understanding: { candidates: [] },
        measurement: { requestMs: 12 },
      }),
    );
    const result = await analyzeExtendedScene(
      new Blob(),
      new AbortController().signal,
      'local-ollama',
    );
    expect(result.understanding.candidates[0].bounds).toEqual(expectedBounds);
    expect(result.understanding.candidates[0].bounds).not.toEqual({
      left: 0.27,
      top: 0.13,
      right: 0.92,
      bottom: 0.64,
    });
    expect(result.rawText).toBe(rawText);
    expect(fetchAnalysis).toHaveBeenCalledWith(
      'local-ollama',
      expect.anything(),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
