import { getD1Actor } from '../src/lib/auth/d1';
beforeEach(() => vi.mocked(getD1Actor).mockResolvedValue({ id: 'test-account', isAdmin: false }));
vi.mock('../src/lib/auth/d1', () => ({
  getD1Actor: vi.fn().mockResolvedValue({ id: 'test-account', isAdmin: false }),
}));
import {
  CLOUD_GEMMA_APPEARANCE_METADATA,
  cloudGemmaFixtureAppearancePrompt,
} from '../src/lib/reconstruction/cloud-gemma-appearance';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { canvasBlob, readImageHeader } from '../src/lib/images';
import { fetchAnalysis } from '../src/lib/reconstruction/analysis-transport';
import {
  buildCloudFixtureCropBoard,
  cloudFixtureCropLayout,
  createCloudFixtureCropReceipt,
  validateCloudFixtureCropReceipt,
  CLOUD_FIXTURE_CROP_PROMPT,
} from '../src/lib/reconstruction/cloud-fixture-crops';
import { runCloudGemmaModel } from '../src/lib/reconstruction/cloud-gemma-server';
import {
  CLOUD_GEMMA_IDENTITY,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_PROVIDER,
  CLOUD_GEMMA_REVISION,
} from '../src/lib/reconstruction/cloud-gemma-contract';
import { parseFixtureInventory } from '../src/lib/reconstruction/inventory-observation';
import { analyzeFixtureAppearance } from '../src/lib/reconstruction/analysis-client';

vi.mock('../src/lib/images', async () => ({
  ...(await vi.importActual('../src/lib/images')),
  canvasBlob: vi.fn(),
}));
vi.mock('../src/lib/reconstruction/analysis-transport', () => ({ fetchAnalysis: vi.fn() }));
function jpeg(width: number, height: number, extra = 0) {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([255, 216, 255, 192, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3]);
  return bytes;
}
const photoBytes = () => jpeg(768, 1024);
const inventory = () =>
  parseFixtureInventory(
    JSON.stringify({
      items: [
        {
          kind: 'toilet',
          bbox_2d: [625, 483, 824, 855],
          view: 'direct',
          basin: null,
          note: 'private prior detector evidence',
        },
      ],
    }),
  ).understanding;
const rawText = JSON.stringify({
  schemaVersion: 1,
  observations: [
    {
      id: 'item_01',
      note: 'Visible fixture',
      kind: 'toilet',
      context: 'physical',
      sameObjectAs: null,
      shape: 'unknown',
      counterSupport: 'unknown',
    },
  ],
});
async function pair() {
  const source = inventory();
  const photo = photoBytes();
  const board = jpeg(1020, 1024);
  return {
    source,
    photo,
    board,
    receipt: await createCloudFixtureCropReceipt(photo, board, source.candidates),
  };
}
async function call(mutate?: (form: FormData) => void, operation = 'appearance') {
  const input = await pair();
  const form = new FormData();
  form.set('operation', operation);
  form.set('photo', new Blob([input.photo], { type: 'image/jpeg' }), 'photo.jpg');
  form.set('inventory', JSON.stringify(input.source));
  form.set('appearanceBoard', new Blob([input.board], { type: 'image/jpeg' }), 'board.jpg');
  form.set('appearanceReceipt', JSON.stringify(input.receipt));
  mutate?.(form);
  const run = vi.fn(async () =>
    Response.json({
      model: CLOUD_GEMMA_MODEL,
      choices: [{ finish_reason: 'stop', message: { content: rawText } }],
    }),
  );
  const request = new Request('http://127.0.0.1:3000/api/reconstruction/cloud', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:3000' },
    body: form,
  });
  const result = runCloudGemmaModel(request, {
    platform: 'cloudflare',
    APP_ENV: 'development',
    STORAGE_MODE: 'd1',
    AI: { run },
  });
  return { result, run, input };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(canvasBlob).mockReset();
  vi.mocked(fetchAnalysis).mockReset();
});

describe('Cloud fixture crop geometry and receipts', () => {
  it('matches the controlled toilet crop and keeps only ID/bounds', () => {
    const layout = cloudFixtureCropLayout(inventory().candidates, { width: 768, height: 1024 });
    expect(layout.tiles[0].crop).toEqual({ left: 464, top: 456, width: 185, height: 458 });
    expect(JSON.stringify(layout)).not.toContain('toilet');
    expect(JSON.stringify(layout)).not.toContain('private prior');
  });
  it('bounds a 24-candidate grid, clips crops, and preserves input ID order', () => {
    const candidates = Array.from({ length: 24 }, (_, i) => ({
      id: 'item_' + i,
      bounds: { left: 0, top: 0, right: 1, bottom: 1 },
    }));
    const layout = cloudFixtureCropLayout(candidates, { width: 768, height: 1024 });
    expect(layout.boardImage).toEqual({ width: 1536, height: 1536 });
    expect(layout.tiles.map((t) => t.id)).toEqual(candidates.map((c) => c.id));
    for (const t of layout.tiles) {
      expect(t.crop).toEqual({ left: 0, top: 0, width: 768, height: 1024 });
      expect(t.destination.left + t.destination.width).toBeLessThanOrEqual(1536);
      expect(t.destination.top + t.destination.height).toBeLessThanOrEqual(1536);
      expect(t.target.width).toBeGreaterThan(0);
    }
    expect(() =>
      cloudFixtureCropLayout([...candidates, candidates[0]], { width: 768, height: 1024 }),
    ).toThrow();
    expect(() => cloudFixtureCropLayout([], { width: 768, height: 1024 })).toThrow();
  });
  it('rejects invalid, duplicate and out-of-range boxes before decoding', () => {
    const c = { id: 'x', bounds: { left: 0, top: 0, right: 1, bottom: 1 } };
    for (const bounds of [
      { ...c.bounds, left: NaN },
      { ...c.bounds, top: -0.1 },
      { ...c.bounds, right: 0 },
    ])
      expect(() => cloudFixtureCropLayout([{ ...c, bounds }], { width: 768, height: 1024 })).toThrow();
    expect(() => cloudFixtureCropLayout([c, c], { width: 768, height: 1024 })).toThrow();
    expect(() => cloudFixtureCropLayout([c], { width: 1025, height: 1024 })).toThrow();
  });
  it('binds both actual images and exact ordered canonical layout; rejects stale/tampered metadata', async () => {
    const { source, photo, board, receipt } = await pair();
    await expect(validateCloudFixtureCropReceipt(receipt, photo, board, source.candidates)).resolves.toEqual(
      receipt,
    );
    for (const mutate of [
      (r: typeof receipt) => (r.layout.tiles[0].bounds.left += 0.01),
      (r: typeof receipt) => (r.layout.tiles[0].id = 'other'),
      (r: typeof receipt) => r.layout.tiles[0].crop.left++,
      (r: typeof receipt) => (r.boardSha256 = '0'.repeat(64)),
      (r: typeof receipt) => (r.layoutSha256 = '0'.repeat(64)),
    ]) {
      const changed = structuredClone(receipt);
      mutate(changed);
      await expect(
        validateCloudFixtureCropReceipt(changed, photo, board, source.candidates),
      ).rejects.toThrow();
    }
    await expect(
      validateCloudFixtureCropReceipt({ ...receipt, extra: 'unexpected' }, photo, board, source.candidates),
    ).rejects.toThrow();
    await expect(
      validateCloudFixtureCropReceipt(receipt, jpeg(768, 1024, 1), board, source.candidates),
    ).rejects.toThrow();
    await expect(
      validateCloudFixtureCropReceipt(receipt, photo, jpeg(1020, 1024, 1), source.candidates),
    ).rejects.toThrow();
    await expect(createCloudFixtureCropReceipt(photo, jpeg(1024, 1020), source.candidates)).rejects.toThrow();
  });
});

describe('Cloud appearance board server boundary', () => {
  it('sends original plus board once, keeps schema, includes ID-only prompt and receipt diagnostics', async () => {
    const { result, run, input } = await call();
    const response = await result;
    expect(run).toHaveBeenCalledOnce();
    const payload = (
      run.mock.calls[0] as unknown as [
        string,
        {
          messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[];
          response_format: { type: string };
        },
      ]
    )[1];
    expect(payload.messages[0].content).toHaveLength(3);
    expect(payload.messages[0].content[0].text).toContain(CLOUD_FIXTURE_CROP_PROMPT);
    expect(payload.messages[0].content[0].text).not.toContain('private prior detector evidence');
    expect(payload.response_format.type).toBe('json_schema');
    expect(response).toMatchObject({ appearanceReceipt: input.receipt, ...CLOUD_GEMMA_APPEARANCE_METADATA });
    expect(payload.messages[0].content[0].text).toBe(cloudGemmaFixtureAppearancePrompt(input.source));
    expect(payload.messages[0].content.slice(1).map((c) => c.image_url?.url)).toEqual(
      [input.photo, input.board].map((b) => 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64')),
    );
  });
  it.each(['appearanceBoard', 'appearanceReceipt'])('requires %s before inference', async (field) => {
    const { result, run } = await call((form) => form.delete(field));
    await expect(result).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects byte substitution and duplicate fields before inference', async () => {
    for (const mutate of [
      (f: FormData) => f.set('appearanceBoard', new Blob([jpeg(1020, 1024, 2)]), 'other.jpg'),
      (f: FormData) => f.append('appearanceReceipt', '{}'),
      (f: FormData) => f.set('appearanceReceipt', 'x'.repeat(96_001)),
    ]) {
      const { result, run } = await call(mutate);
      await expect(result).rejects.toMatchObject({ code: 'invalid_input' });
      expect(run).not.toHaveBeenCalled();
    }
  });
  it.each([
    'identity',
    'installation',
    'layout',
    'shower-detail',
    'divider-material',
    'target-existence',
    'inventory',
    'inventory-extended',
  ])('rejects appearance-only fields for %s', async (operation) => {
    const { result, run } = await call(undefined, operation);
    await expect(result).rejects.toMatchObject({ code: 'invalid_input' });
    expect(run).not.toHaveBeenCalled();
  });
  it('retains the image and aggregate request byte limits', async () => {
    const { result, run } = await call((form) =>
      form.set('appearanceBoard', new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]), 'large.jpg'),
    );
    await expect(result).rejects.toMatchObject({ code: 'invalid_input' });
    expect(run).not.toHaveBeenCalled();
  });
});

function browser() {
  const close = vi.fn();
  const canvases: { width: number; height: number; getContext: () => unknown }[] = [];
  const ctx = {
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeRect: vi.fn(),
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (photo: Blob) => ({ ...readImageHeader(new Uint8Array(await photo.arrayBuffer())), close })),
  );
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const canvas = { width: 0, height: 0, getContext: () => ctx };
      canvases.push(canvas);
      return canvas;
    }),
  });
  vi.mocked(canvasBlob).mockImplementation(
    async (canvas) => new Blob([jpeg(canvas.width, canvas.height)], { type: 'image/jpeg' }),
  );
  return { close, ctx, canvases };
}
describe('Cloud appearance browser board lifecycle', () => {
  it('uses actual normalized pixels, renders IDs only, and releases bitmaps/canvas', async () => {
    const { close, ctx, canvases } = browser();
    const { board, receipt } = await buildCloudFixtureCropBoard(
      new Blob([photoBytes()]),
      inventory().candidates,
      new AbortController().signal,
    );
    expect(receipt.sourcePhotoSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readImageHeader(new Uint8Array(await board.arrayBuffer()))).toMatchObject(
      receipt.layout.boardImage,
    );
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['item_01']);
    expect(ctx.drawImage.mock.calls[0].slice(1, 5)).toEqual([464, 456, 185, 458]);
    expect(close).toHaveBeenCalledOnce();
    expect(canvases[0]).toMatchObject({ width: 1, height: 1 });
  });
  it('cleans up after encoding failure and stops before network after cancellation', async () => {
    const { close, canvases } = browser();
    vi.mocked(canvasBlob).mockRejectedValueOnce(new Error('encoding failed'));
    await expect(
      buildCloudFixtureCropBoard(
        new Blob([photoBytes()]),
        inventory().candidates,
        new AbortController().signal,
      ),
    ).rejects.toThrow('encoding failed');
    expect(close).toHaveBeenCalledOnce();
    expect(canvases[0]).toMatchObject({ width: 1, height: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildCloudFixtureCropBoard(new Blob(), inventory().candidates, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createImageBitmap).toHaveBeenCalledOnce();
  });
  it('closes a bitmap that resolves after cancellation', async () => {
    const { close } = browser();
    const controller = new AbortController();
    vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
      controller.abort();
      return { width: 768, height: 1024, close } as ImageBitmap;
    });
    await expect(
      buildCloudFixtureCropBoard(new Blob([photoBytes()]), inventory().candidates, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
    expect(document.createElement).not.toHaveBeenCalled();
  });
  it('adds cloud-only form fields and verifies the server receipt against the input snapshot', async () => {
    const { close } = browser();
    vi.mocked(fetchAnalysis).mockImplementationOnce(async (_provider, options) => {
      const form = options.body as FormData;
      const receipt = JSON.parse(form.get('appearanceReceipt') as string);
      expect(form.get('appearanceBoard')).toBeInstanceOf(Blob);
      return Response.json({
        provider: CLOUD_GEMMA_PROVIDER,
        modelId: CLOUD_GEMMA_MODEL,
        modelRevision: CLOUD_GEMMA_REVISION,
        modelIdentity: CLOUD_GEMMA_IDENTITY,
        ...CLOUD_GEMMA_APPEARANCE_METADATA,
        outputContract: 'fixed-candidate-appearance-v1',
        promptRevision: 1,
        rawText,
        appearanceReceipt: receipt,
      });
    });
    const result = await analyzeFixtureAppearance(
      new Blob([photoBytes()]),
      inventory(),
      new AbortController().signal,
      CLOUD_GEMMA_PROVIDER,
    );
    expect(result.understanding.candidates[0].kind).toBe('toilet');
    expect(fetchAnalysis).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('rejects a response that omits the actual board receipt', async () => {
    browser();
    vi.mocked(fetchAnalysis).mockResolvedValueOnce(
      Response.json({
        provider: CLOUD_GEMMA_PROVIDER,
        modelId: CLOUD_GEMMA_MODEL,
        modelRevision: CLOUD_GEMMA_REVISION,
        modelIdentity: CLOUD_GEMMA_IDENTITY,
        ...CLOUD_GEMMA_APPEARANCE_METADATA,
        outputContract: 'fixed-candidate-appearance-v1',
        promptRevision: 1,
        rawText,
      }),
    );
    await expect(
      analyzeFixtureAppearance(
        new Blob([photoBytes()]),
        inventory(),
        new AbortController().signal,
        CLOUD_GEMMA_PROVIDER,
      ),
    ).rejects.toThrow('설비 형태 관측을 검증하지 못했어요.');
  });
});

it.each([
  { providerAppearanceContract: undefined },
  { providerAppearanceContract: 'obsolete' },
  { providerAppearancePromptRevision: undefined },
  { providerAppearancePromptRevision: 1 },
])('rejects a stale cloud appearance contract even with a matching crop receipt: %j', async (mutation) => {
  browser();
  vi.mocked(fetchAnalysis).mockImplementationOnce(async (_provider, options) => {
    const form = options.body as FormData;
    return Response.json({
      provider: CLOUD_GEMMA_PROVIDER,
      modelId: CLOUD_GEMMA_MODEL,
      modelRevision: CLOUD_GEMMA_REVISION,
      modelIdentity: CLOUD_GEMMA_IDENTITY,
      outputContract: 'fixed-candidate-appearance-v1',
      promptRevision: 1,
      ...CLOUD_GEMMA_APPEARANCE_METADATA,
      ...mutation,
      rawText,
      appearanceReceipt: JSON.parse(form.get('appearanceReceipt') as string),
    });
  });
  await expect(
    analyzeFixtureAppearance(
      new Blob([photoBytes()]),
      inventory(),
      new AbortController().signal,
      CLOUD_GEMMA_PROVIDER,
    ),
  ).rejects.toMatchObject({ diagnostics: { validationError: expect.stringContaining('프롬프트 버전') } });
  expect(fetchAnalysis).toHaveBeenCalledOnce();
});
