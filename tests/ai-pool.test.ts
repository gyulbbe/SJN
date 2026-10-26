import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { extraAccounts, pooledBinding, resetAiPoolMemory } from '../src/lib/ai-pool/pool';
import { runDirectionPhoto } from '../src/lib/direction-photo/server';
import { cloudGemmaErrorResponse } from '../src/lib/reconstruction/cloud-gemma-errors';
import { binding } from '../src/lib/reconstruction/cloud-gemma-server';
import type { DirectionPhotoSpec } from '../src/lib/direction-photo/contract';

vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: vi.fn() }));
import { getD1Actor } from '../src/lib/auth/d1';

/**
 * Workers AI over the extra account and this Worker's binding (docs/ai-account-pool-results-20261025.md),
 * with a fake binding and a stubbed fetch: no model is called.
 */
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'test-token-not-real-9f8e7d';
const EXTRA = { AI_EXTRA_1_ACCOUNT_ID: ACCOUNT, AI_EXTRA_1_TOKEN: TOKEN };
const quota = () =>
  Response.json(
    { success: false, errors: [{ code: 3036, message: 'Account limited: daily free allocation used up' }] },
    { status: 429 },
  );
const ok = (value: unknown = { result: { image: 'x' }, success: true }) => Response.json(value);
const options = (signal = new AbortController().signal) => ({ returnRawResponse: true as const, signal });
const fetchStub = (...answers: (() => Response)[]) => {
  const fn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    (answers.shift() ?? ok)(),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
};
type Run = (model: string, input: unknown, options: unknown) => Promise<Response>;
const ownBinding = (answer: () => Response = () => ok({ image: 'own' })) => ({
  run: vi.fn<Run>(async () => answer()),
});

beforeEach(() => {
  resetAiPoolMemory();
  vi.mocked(getD1Actor).mockResolvedValue({ id: 'fixture-user', isAdmin: false });
});
afterEach(() => vi.unstubAllGlobals());

describe('extra accounts', () => {
  it('reads AI_EXTRA_1 only when the account ID is 32 hex digits and a token is set', () => {
    expect(extraAccounts(EXTRA)).toHaveLength(1);
    expect(extraAccounts({ ...EXTRA, AI_EXTRA_1_GATEWAY: 'extra-gw' })[0].gateway).toBe('extra-gw');
    expect(extraAccounts({})).toEqual([]);
    expect(extraAccounts({ ...EXTRA, AI_EXTRA_1_ACCOUNT_ID: 'not-an-account' })).toEqual([]);
    expect(extraAccounts({ ...EXTRA, AI_EXTRA_1_TOKEN: '  ' })).toEqual([]);
  });
});

describe('pooled Workers AI', () => {
  it('without an extra account calls the binding once, as before, and never fetch', async () => {
    const fetched = fetchStub();
    const own = ownBinding();
    const ai = pooledBinding({}, own)!;
    const input = { messages: [] };
    const opts = options();
    const response = await ai.run('@cf/model', input, opts);
    expect(await response.json()).toEqual({ image: 'own' });
    expect(own.run).toHaveBeenCalledTimes(1);
    expect(own.run.mock.calls[0]).toEqual(['@cf/model', input, opts]);
    expect(fetched).not.toHaveBeenCalled();
    expect(ai.account).toBe('own');
    expect(pooledBinding({}, undefined)).toBeUndefined();
  });

  it('uses the extra account first through the REST API with its token', async () => {
    const fetched = fetchStub(ok);
    const own = ownBinding();
    const ai = pooledBinding(EXTRA, own)!;
    const response = await ai.run('@cf/google/gemma', { messages: [] }, options());
    expect(response.ok).toBe(true);
    expect(own.run).not.toHaveBeenCalled();
    const [url, init] = fetched.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/google/gemma`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ messages: [] });
    expect(ai.account).toBe('extra-1');
  });

  it('moves on only for a used-up day (3036) or a refused token (401·403)', async () => {
    for (const [answer, skipped] of [
      [quota, 'extra-1:quota'],
      [() => new Response('{"errors":[{"code":10000}]}', { status: 401 }), 'extra-1:auth'],
      [() => new Response('forbidden', { status: 403 }), 'extra-1:auth'],
    ] as const) {
      resetAiPoolMemory();
      fetchStub(answer);
      const own = ownBinding();
      const ai = pooledBinding(EXTRA, own)!;
      await ai.run('@cf/m', {}, options());
      expect(own.run).toHaveBeenCalledTimes(1);
      expect(ai.account).toBe('own');
      expect(ai.skipped).toEqual([skipped]);
    }
  });

  it.each([
    ['a server error', () => new Response('boom', { status: 500 })],
    ['busy (3040)', () => Response.json({ errors: [{ code: 3040 }] }, { status: 429 })],
    ['a bad request', () => new Response('bad', { status: 400 })],
  ])('answers %s from the extra account as it is (no move, no retry)', async (_name, answer) => {
    const fetched = fetchStub(answer);
    const own = ownBinding();
    const ai = pooledBinding(EXTRA, own)!;
    const response = await ai.run('@cf/m', {}, options());
    expect(response.ok).toBe(false);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(own.run).not.toHaveBeenCalled();
    expect(ai.account).toBe('extra-1');
  });

  it('remembers a used-up account until the next 00:00 UTC (no request before it)', async () => {
    let now = Date.parse('2026-10-25T10:00:00Z');
    const fetched = fetchStub(quota, ok);
    const own = ownBinding();
    const ai = pooledBinding(EXTRA, own, () => now)!;
    await ai.run('@cf/m', {}, options());
    await ai.run('@cf/m', {}, options());
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(own.run).toHaveBeenCalledTimes(2);
    now = Date.parse('2026-10-26T00:00:01Z');
    await ai.run('@cf/m', {}, options());
    expect(fetched).toHaveBeenCalledTimes(2);
    expect(ai.account).toBe('extra-1');
  });

  it('gives a multipart body to each account whole (a stream is read once)', async () => {
    const fetched = fetchStub(quota);
    const own = ownBinding();
    const ai = pooledBinding(EXTRA, own)!;
    const form = new FormData();
    form.set('prompt', 'a bathroom');
    form.set('input_image_0', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), 'a.png');
    const serialized = new Response(form);
    const contentType = serialized.headers.get('content-type')!;
    const bytes = new Uint8Array(await serialized.clone().arrayBuffer());
    await ai.run('@cf/flux', { multipart: { body: serialized.body!, contentType } }, options());
    const sentToExtra = new Uint8Array(fetched.mock.calls[0][1].body as ArrayBuffer);
    expect((fetched.mock.calls[0][1].headers as Record<string, string>)['Content-Type']).toBe(contentType);
    const second = own.run.mock.calls[0][1] as { multipart: { body: ReadableStream; contentType: string } };
    const sentToOwn = new Uint8Array(await new Response(second.multipart.body).arrayBuffer());
    expect(sentToExtra).toEqual(bytes);
    expect(sentToOwn).toEqual(bytes);
    expect(second.multipart.contentType).toBe(contentType);
  });

  it('sends a gateway request to the extra account’s gateway only when it has one', async () => {
    const fetched = fetchStub(ok, ok);
    const gateway = { gateway: { id: 'sjn-gateway', retries: { maxAttempts: 1 } } };
    await pooledBinding(EXTRA, ownBinding())!.run('@cf/m', {}, { ...options(), ...gateway });
    expect(fetched.mock.calls[0][1].headers).not.toHaveProperty('cf-aig-gateway-id');
    await pooledBinding({ ...EXTRA, AI_EXTRA_1_GATEWAY: 'extra-gw' }, ownBinding())!.run(
      '@cf/m',
      {},
      { ...options(), ...gateway },
    );
    expect((fetched.mock.calls[1][1].headers as Record<string, string>)['cf-aig-gateway-id']).toBe(
      'extra-gw',
    );
  });

  it('without a binding uses the extra account alone; a used-up day is the day’s answer', async () => {
    fetchStub(quota);
    const ai = pooledBinding<{ run: Run }>(EXTRA, undefined)!;
    const response = await ai.run('@cf/m', {}, options());
    expect(response.status).toBe(429);
    expect(ai.skipped).toEqual(['extra-1:quota']);
  });

  it('stops on cancel without trying the next account', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    const own = ownBinding();
    await expect(pooledBinding(EXTRA, own)!.run('@cf/m', {}, options(controller.signal))).rejects.toThrow();
    expect(own.run).not.toHaveBeenCalled();
  });

  it('Gemma’s binding() passes through the pool (extra account alone off Cloudflare)', async () => {
    expect(() => binding({ platform: 'node' })).toThrow();
    const ai = binding({ platform: 'node', ...EXTRA });
    fetchStub(ok);
    await ai.run(
      '@cf/google/gemma-4-26b-a4b-it' as never,
      {} as never,
      {
        gateway: { id: 'sjn-gateway', retries: { maxAttempts: 1 } },
        returnRawResponse: true,
        signal: new AbortController().signal,
      } as never,
    );
    expect(ai.account).toBe('extra-1');
  });
});

// A whole FLUX route (the direction photo) with the pool: what the screen receives.
const png = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer(),
  );
const spec: DirectionPhotoSpec = {
  category: 'bath',
  form: 'oval-freestanding',
  direction: 'left',
  installation: 'floor',
  sizeMm: [1700, 560, 750],
};
async function photoRequest() {
  const form = new FormData();
  form.set('guide', new Blob([await png(432, 496)], { type: 'image/png' }), 'guide.png');
  form.append('refs', new Blob([await png(496, 288)], { type: 'image/png' }), 'photo-1.png');
  form.set('seed', '3001');
  form.set('spec', JSON.stringify(spec));
  return new Request('https://sjn.example/api/materials/direction-photo', {
    method: 'POST',
    headers: { origin: 'https://sjn.example' },
    body: form,
  });
}
const image = async () => Response.json({ image: Buffer.from(await png(864, 992)).toString('base64') });

describe('a FLUX route over the pool', () => {
  const env = (run: Run) => ({
    platform: 'cloudflare' as const,
    APP_ENV: 'development',
    STORAGE_MODE: 'd1',
    AI: { run: vi.fn(run) },
    ...EXTRA,
  });

  it('a used-up extra account is not the screen’s business: the own account answers, no limit', async () => {
    fetchStub(quota);
    const e = env(image);
    const response = await runDirectionPhoto(await photoRequest(), e);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SJN-AI-Account')).toBe('own');
    expect(e.AI.run).toHaveBeenCalledTimes(1);
  });

  it('the extra account answers first', async () => {
    const generated = await image();
    const fetched = fetchStub(() => generated);
    const e = env(image);
    const response = await runDirectionPhoto(await photoRequest(), e);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-SJN-AI-Account')).toBe('extra-1');
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(e.AI.run).not.toHaveBeenCalled();
  });

  it('every account used up: the 429 quota_exhausted with its limit, as before; no secret in it', async () => {
    fetchStub(quota);
    const e = env(async () => quota());
    const failure = await runDirectionPhoto(await photoRequest(), e).catch((error) => error);
    const response = cloudGemmaErrorResponse(failure);
    const text = await response.text();
    expect(response.status).toBe(429);
    const body = JSON.parse(text);
    expect(body.code).toBe('quota_exhausted');
    expect(body.limit.service).toBe('ai');
    expect(body.diagnostics.aiAccount).toBe('own');
    expect(body.diagnostics.aiSkipped).toEqual(['extra-1:quota']);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ACCOUNT);
  });
});
