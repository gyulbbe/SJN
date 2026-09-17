import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { runFluxExport } from '../src/lib/ai-export/server';
import { FLUX_GATEWAY, FLUX_MODELS, FLUX_PROMPT, fluxDimensions } from '../src/lib/ai-export/contract';
import { requestFluxImage } from '../src/lib/ai-export/client';

vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: vi.fn() }));
import { getD1Actor } from '../src/lib/auth/d1';
beforeEach(() => vi.mocked(getD1Actor).mockResolvedValue({ id: 'fixture-user', isAdmin: false }));

const png = async (width = 496, height = 336) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#cbc4bb' } })
      .png()
      .toBuffer(),
  );
function request(
  image: Uint8Array,
  model = '4b',
  origin = 'https://sjn.example',
  extra?: (form: FormData) => void,
) {
  const form = new FormData();
  form.set('model', model);
  form.set('seed', '12345');
  form.set('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'after.png');
  extra?.(form);
  return new Request('https://sjn.example/api/export/photoreal', {
    method: 'POST',
    headers: { origin },
    body: form,
  });
}
function environment(
  run = vi.fn(async () => Response.json({ image: Buffer.from(await png(992, 672)).toString('base64') })),
) {
  return { platform: 'cloudflare' as const, APP_ENV: 'development', STORAGE_MODE: 'd1', AI: { run } };
}
describe('FLUX image export', () => {
  it.each(['4b', '9b'] as const)(
    'sends the reference image and fixed prompt to %s through the existing gateway exactly once',
    async (variant) => {
      const image = await png();
      const env = environment();
      const result = await runFluxExport(request(image, variant), env);
      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toBe('image/png');
      expect(result.headers.get('cache-control')).toContain('no-store');
      expect(result.headers.get('x-sjn-image-model')).toBe(FLUX_MODELS[variant]);
      expect(env.AI.run).toHaveBeenCalledTimes(1);
      const [model, payload, options] = (
        env.AI.run.mock.calls as unknown as [
          string,
          { multipart: { body: ReadableStream; contentType: string } },
          unknown,
        ][]
      )[0];
      expect(model).toBe(FLUX_MODELS[variant]);
      expect(options).toMatchObject({
        gateway: { id: FLUX_GATEWAY, retries: { maxAttempts: 1 }, skipCache: true },
        returnRawResponse: true,
      });
      const form = await new Response(payload.multipart.body, {
        headers: { 'Content-Type': payload.multipart.contentType },
      }).formData();
      expect(form.get('prompt')).toBe(FLUX_PROMPT);
      expect(form.get('width')).toBe('992');
      expect(form.get('height')).toBe('672');
      expect(form.get('seed')).toBe('12345');
      expect(new Uint8Array(await (form.get('input_image_0') as Blob).arrayBuffer())).toEqual(image);
      expect(await sharp(Buffer.from(await result.arrayBuffer())).metadata()).toMatchObject({
        width: 992,
        height: 672,
      });
    },
  );
  it.each([
    ['wrong model', 'other', (f: FormData) => f],
    ['duplicate model', '4b', (f: FormData) => f.append('model', '9b')],
    ['caller prompt', '4b', (f: FormData) => f.set('prompt', 'replace prompt')],
    ['invalid seed', '4b', (f: FormData) => f.set('seed', '-1')],
  ] as const)('rejects %s before inference', async (_label, model, edit) => {
    const env = environment();
    await expect(runFluxExport(request(await png(), model, undefined, edit), env)).rejects.toMatchObject({
      status: 400,
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it.each([
    [512, 336],
    [127, 336],
    [490, 336],
  ])('rejects unsupported dimensions %sx%s', async (w, h) => {
    const env = environment();
    await expect(runFluxExport(request(await png(w, h)), env)).rejects.toMatchObject({ status: 400 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it('rejects cross-origin requests before inference', async () => {
    const env = environment();
    await expect(
      runFluxExport(request(await png(), '4b', 'https://evil.example'), env),
    ).rejects.toMatchObject({ status: 403 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it('rejects missing origin, malformed images and oversized bodies', async () => {
    for (const mode of ['origin', 'image', 'size']) {
      const env = environment();
      const req = request(mode === 'image' ? new Uint8Array([1, 2]) : await png());
      if (mode === 'origin') req.headers.delete('origin');
      if (mode === 'size') req.headers.set('content-length', String(3 * 1024 * 1024));
      await expect(runFluxExport(req, env)).rejects.toMatchObject({ status: mode === 'origin' ? 403 : 400 });
      expect(env.AI.run).not.toHaveBeenCalled();
    }
  });
  it('reports missing Workers binding without any model call', async () => {
    await expect(
      runFluxExport(request(await png()), { platform: 'node', APP_ENV: 'development', STORAGE_MODE: 'd1' }),
    ).rejects.toMatchObject({ code: 'binding_unavailable' });
  });
  it('does not fall back to anonymous access for production auto storage', async () => {
    const env = { ...environment(), APP_ENV: 'production', STORAGE_MODE: 'auto' };
    vi.mocked(getD1Actor).mockRejectedValueOnce({status:401});
    await expect(runFluxExport(request(await png()), env)).rejects.toMatchObject({ status: 401 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
  it.each([402, 429])('surfaces provider limit %s without retry or model fallback', async (status) => {
    const env = environment(vi.fn(async () => Response.json({ errors: [{ code: 3036 }] }, { status })));
    await expect(runFluxExport(request(await png()), env)).rejects.toMatchObject({
      code: 'quota_exhausted',
      status: 429,
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });
  it('rejects a non-image success response', async () => {
    const env = environment(vi.fn(async () => Response.json({ image: btoa('not an image') })));
    await expect(runFluxExport(request(await png()), env)).rejects.toMatchObject({ status: 502 });
  });
  it('client does not retry 429 or switch models', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: '오늘 한도 소진' }, { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(
        requestFluxImage(new Blob(), '9b', 123, new AbortController().signal, 'user-a'),
      ).rejects.toThrow('오늘 한도 소진');
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('prepares small aligned reference sizes without increasing the long edge above the provider limit', () => {
    expect(fluxDimensions(4096, 2731)).toEqual({ width: 496, height: 336 });
    expect(fluxDimensions(100, 400)).toEqual({ width: 128, height: 400 });
  });
});
