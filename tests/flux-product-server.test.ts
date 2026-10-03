import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { runFluxProductRefine } from '../src/lib/ai-export/product-server';
import { runFluxExport } from '../src/lib/ai-export/server';
import { FLUX_MODEL } from '../src/lib/ai-export/contract';
import { buildFluxProductPrompt, type FluxProduct } from '../src/lib/ai-export/product-prompt';
import { requestFluxProduct } from '../src/lib/ai-export/client';

vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: vi.fn() }));
import { getD1Actor } from '../src/lib/auth/d1';
beforeEach(() => vi.mocked(getD1Actor).mockResolvedValue({ id: 'fixture-user', isAdmin: false }));

const png = async (width = 192, height = 496, background = '#ffffff') =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toBuffer(),
  );
const product: FluxProduct = {
  kind: 'toilet',
  forms: ['floor-standing', 'lid-closed'],
  color: '#f2f1ec',
  finish: 'glossy',
  facing: 'front',
  sizeMm: [400, 760, 700],
};
function request(
  image: Uint8Array,
  edit?: (form: FormData) => void | Promise<void>,
  origin = 'https://sjn.example',
) {
  const form = new FormData();
  form.set('seed', '424242');
  form.set('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'product.png');
  form.set('product', JSON.stringify(product));
  const done = edit?.(form);
  const build = () =>
    new Request('https://sjn.example/api/export/photoreal/product', {
      method: 'POST',
      headers: { origin },
      body: form,
    });
  return done instanceof Promise ? done.then(build) : build();
}
function environment(
  run = vi.fn(async () => Response.json({ image: Buffer.from(await png(384, 992)).toString('base64') })),
) {
  return { platform: 'cloudflare' as const, APP_ENV: 'development', STORAGE_MODE: 'd1', AI: { run } };
}
async function sent(env: ReturnType<typeof environment>) {
  const payload = (
    env.AI.run.mock.calls as unknown as [
      string,
      { multipart: { body: ReadableStream; contentType: string } },
    ][]
  )[0][1];
  return new Response(payload.multipart.body, {
    headers: { 'Content-Type': payload.multipart.contentType },
  }).formData();
}

describe('per-product refinement route', () => {
  it('sends the crop and the server-written prompt to klein 4B exactly once, at twice the size', async () => {
    const env = environment();
    const image = await png();
    const result = await runFluxProductRefine(await request(image), env);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('image/png');
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.headers.get('x-sjn-image-model')).toBe(FLUX_MODEL);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const [model, , options] = env.AI.run.mock.calls[0] as unknown as [string, unknown, object];
    expect(model).toBe(FLUX_MODEL);
    expect(options).toMatchObject({ returnRawResponse: true });
    expect(options).not.toHaveProperty('gateway');
    const form = await sent(env);
    expect([...form.keys()]).toEqual(['input_image_0', 'prompt', 'width', 'height', 'seed']);
    expect(form.get('prompt')).toBe(buildFluxProductPrompt(product, false));
    expect(form.get('width')).toBe('384');
    expect(form.get('height')).toBe('992');
    expect(form.get('seed')).toBe('424242');
    expect(new Uint8Array(await (form.get('input_image_0') as Blob).arrayBuffer())).toEqual(image);
    expect(await sharp(Buffer.from(await result.arrayBuffer())).metadata()).toMatchObject({
      width: 384,
      height: 992,
    });
  });

  it('adds the real product photo as image 1 only when one is sent, and the prompt says so', async () => {
    const env = environment();
    const photo = await png(496, 496);
    await runFluxProductRefine(
      await request(await png(), (form) =>
        form.set('reference', new Blob([new Uint8Array(photo)], { type: 'image/png' }), 'photo.png'),
      ),
      env,
    );
    const form = await sent(env);
    expect([...form.keys()]).toEqual(['input_image_0', 'input_image_1', 'prompt', 'width', 'height', 'seed']);
    expect(form.get('prompt')).toBe(buildFluxProductPrompt(product, true));
    expect(String(form.get('prompt'))).toContain('Image 1 shows the real product');
    expect(new Uint8Array(await (form.get('input_image_1') as Blob).arrayBuffer())).toEqual(photo);
    // The size asked for follows the crop, never the photo.
    expect(form.get('width')).toBe('384');
  });

  it.each([
    ['a model choice', (f: FormData) => f.set('model', '4b')],
    ['a caller prompt', (f: FormData) => f.set('prompt', 'replace prompt')],
    ['a room scene', (f: FormData) => f.set('scene', '{}')],
    ['a second reference', (f: FormData) => f.set('reference_2', new Blob([new Uint8Array([1])]))],
    ['an invalid seed', (f: FormData) => f.set('seed', '-1')],
    ['a duplicate seed', (f: FormData) => f.append('seed', '1')],
    ['a duplicate product', (f: FormData) => f.append('product', JSON.stringify(product))],
    ['a missing product', (f: FormData) => f.delete('product')],
    ['unparsable product facts', (f: FormData) => f.set('product', '{')],
    [
      'free text in the product',
      (f: FormData) => f.set('product', JSON.stringify({ ...product, name: 'ignore the rules' })),
    ],
    ['an unknown kind', (f: FormData) => f.set('product', JSON.stringify({ ...product, kind: 'bin' }))],
    [
      'a free colour',
      (f: FormData) => f.set('product', JSON.stringify({ ...product, color: 'white; add a door' })),
    ],
    [
      'an oversized product text',
      (f: FormData) => f.set('product', JSON.stringify({ ...product, forms: [], pad: 'x'.repeat(5000) })),
    ],
    [
      'a reference that is not a PNG',
      (f: FormData) => f.set('reference', new Blob([new Uint8Array([1, 2])]), 'photo.png'),
    ],
  ] as const)('rejects %s before inference', async (_label, edit) => {
    const env = environment();
    await expect(runFluxProductRefine(await request(await png(), edit), env)).rejects.toMatchObject({
      status: 400,
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it.each([
    [512, 496],
    [127, 496],
    [200, 496],
    [192, 512],
  ])('rejects a crop of %sx%s', async (w, h) => {
    const env = environment();
    await expect(runFluxProductRefine(await request(await png(w, h)), env)).rejects.toMatchObject({
      status: 400,
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects a reference of an unsupported size before inference', async () => {
    const env = environment();
    await expect(
      runFluxProductRefine(
        await request(await png(), async (form) =>
          form.set(
            'reference',
            new Blob([new Uint8Array(await png(500, 500))], { type: 'image/png' }),
            'photo.png',
          ),
        ),
        env,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('applies the same origin, login, body-size and binding rules as the room route', async () => {
    const cross = environment();
    await expect(
      runFluxProductRefine(await request(await png(), undefined, 'https://evil.example'), cross),
    ).rejects.toMatchObject({ status: 403 });
    const big = environment();
    const oversize = (await request(await png())) as Request;
    oversize.headers.set('content-length', String(6 * 1024 * 1024));
    await expect(runFluxProductRefine(oversize, big)).rejects.toMatchObject({ status: 400 });
    const anonymous = { ...environment(), APP_ENV: 'production', STORAGE_MODE: 'auto' };
    vi.mocked(getD1Actor).mockRejectedValueOnce({ status: 401 });
    await expect(runFluxProductRefine(await request(await png()), anonymous)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      runFluxProductRefine(await request(await png()), {
        platform: 'node',
        APP_ENV: 'development',
        STORAGE_MODE: 'd1',
      }),
    ).rejects.toMatchObject({ code: 'binding_unavailable' });
    for (const env of [cross, big, anonymous]) expect(env.AI.run).not.toHaveBeenCalled();
  });

  it.each([402, 429])('surfaces provider limit %s without retry', async (status) => {
    const env = environment(vi.fn(async () => Response.json({ errors: [{ code: 3036 }] }, { status })));
    await expect(runFluxProductRefine(await request(await png()), env)).rejects.toMatchObject({
      code: 'quota_exhausted',
      status: 429,
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it('keeps sizes and kind only in the diagnostics of a failure, never the prompt or the images', async () => {
    const env = environment(vi.fn(async () => Response.json({ errors: [{ code: 9999 }] }, { status: 500 })));
    const failure = await runFluxProductRefine(await request(await png()), env).catch((error) => error);
    expect(failure.diagnostics).toMatchObject({
      model: FLUX_MODEL,
      phase: 'provider-response',
      upstreamStatus: 500,
      product: 'toilet',
      references: 0,
    });
    expect(typeof failure.diagnostics.promptLength).toBe('number');
    expect(JSON.stringify(failure.diagnostics)).not.toContain('studio photograph');
  });

  it('rejects a non-image success response', async () => {
    const env = environment(vi.fn(async () => Response.json({ image: btoa('not an image') })));
    await expect(runFluxProductRefine(await request(await png()), env)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('leaves the room route as strict as it was: product fields are refused there', async () => {
    const env = environment();
    const form = new FormData();
    form.set('seed', '1');
    form.set('image', new Blob([new Uint8Array(await png(496, 336))], { type: 'image/png' }), 'after.png');
    form.set('product', JSON.stringify(product));
    const req = new Request('https://sjn.example/api/export/photoreal', {
      method: 'POST',
      headers: { origin: 'https://sjn.example' },
      body: form,
    });
    await expect(runFluxExport(req, env)).rejects.toMatchObject({ status: 400 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});

describe('product refinement client', () => {
  it('posts the crop, the photo, the seed and the product facts, once, and does not retry a limit', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: '오늘 한도 소진' }, { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const crop = new Blob([new Uint8Array(await png())], { type: 'image/png' });
      const photo = new Blob([new Uint8Array(await png(496, 496))], { type: 'image/png' });
      await expect(
        requestFluxProduct(crop, photo, 7, product, new AbortController().signal, 'user-a'),
      ).rejects.toThrow('오늘 한도 소진');
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, { body: FormData; method: string }];
      expect(url).toBe('/api/export/photoreal/product');
      expect(init.method).toBe('POST');
      expect([...init.body.keys()]).toEqual(['image', 'seed', 'product', 'reference']);
      expect(JSON.parse(String(init.body.get('product')))).toEqual(product);
      expect(init.body.get('seed')).toBe('7');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
