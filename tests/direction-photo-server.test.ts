import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudGemmaErrorResponse } from '../src/lib/reconstruction/cloud-gemma-errors';
import sharp from 'sharp';
import { runDirectionPhoto } from '../src/lib/direction-photo/server';
import { requestDirectionPhoto } from '../src/lib/direction-photo/client';
import { buildDirectionPhotoPrompt } from '../src/lib/direction-photo/prompt';
import { directionPhotoSizeOk, type DirectionPhotoSpec } from '../src/lib/direction-photo/contract';
import { FLUX_MODEL } from '../src/lib/ai-export/contract';

vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: vi.fn() }));
import { getD1Actor } from '../src/lib/auth/d1';
beforeEach(() => vi.mocked(getD1Actor).mockResolvedValue({ id: 'fixture-user', isAdmin: false }));

const png = async (width = 496, height = 192, background = '#ffffff') =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toBuffer(),
  );
const blob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)], { type: 'image/png' });
const spec: DirectionPhotoSpec = {
  category: 'bath',
  form: 'oval-freestanding',
  direction: 'left',
  installation: 'floor',
  sizeMm: [1700, 560, 750],
};
/** A one-piece toilet: its photos' angles go with it. */
const twoPhotos: DirectionPhotoSpec = {
  category: 'toilet',
  form: 'one-piece',
  lid: 'seat',
  direction: 'left',
  installation: 'floor',
  sizeMm: [370, 660, 640],
  photoAngles: ['front-right', 'unknown'],
};
async function request(edit?: (form: FormData) => void | Promise<void>, origin = 'https://sjn.example') {
  const form = new FormData();
  form.set('guide', blob(await png(432, 496)), 'guide.png');
  form.append('refs', blob(await png(496, 288, '#eeeeee')), 'photo-1.png');
  form.set('seed', '3001');
  form.set('spec', JSON.stringify(spec));
  await edit?.(form);
  return new Request('https://sjn.example/api/materials/direction-photo', {
    method: 'POST',
    headers: { origin },
    body: form,
  });
}
function environment(
  run = vi.fn(async () => Response.json({ image: Buffer.from(await png(864, 992)).toString('base64') })),
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

describe('direction photo route', () => {
  it('sends the guide as image 0, the photos as images 1–n and the server’s prompt, once, at twice the guide', async () => {
    const env = environment();
    const result = await runDirectionPhoto(
      await request(async (form) => {
        form.append('refs', blob(await png(288, 496, '#dddddd')), 'photo-2.png');
        form.set('spec', JSON.stringify(twoPhotos));
      }),
      env,
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('image/png');
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const [model, , options] = env.AI.run.mock.calls[0] as unknown as [string, unknown, object];
    expect(model).toBe(FLUX_MODEL);
    expect(options).toMatchObject({ returnRawResponse: true });
    expect(options).not.toHaveProperty('gateway');
    const form = await sent(env);
    expect([...form.keys()]).toEqual([
      'input_image_0',
      'input_image_1',
      'input_image_2',
      'prompt',
      'width',
      'height',
      'seed',
    ]);
    expect(form.get('prompt')).toBe(buildDirectionPhotoPrompt(twoPhotos, 2));
    expect(form.get('prompt')).toContain('Image 1 was taken from the front right of the product, from above');
    expect(form.get('width')).toBe('864');
    expect(form.get('height')).toBe('992');
    expect(form.get('seed')).toBe('3001');
    expect(new Uint8Array(await (form.get('input_image_0') as Blob).arrayBuffer())).toEqual(
      await png(432, 496),
    );
    expect(new Uint8Array(await (form.get('input_image_2') as Blob).arrayBuffer())).toEqual(
      await png(288, 496, '#dddddd'),
    );
  });

  it.each([
    ['a model choice', (f: FormData) => f.set('model', 'flux-2-dev')],
    ['a caller prompt', (f: FormData) => f.set('prompt', 'make it gold')],
    ['an image field of the model', (f: FormData) => f.set('input_image_1', new Blob([new Uint8Array([1])]))],
    ['a second guide', (f: FormData) => f.append('guide', new Blob([new Uint8Array([1])]), 'guide.png')],
    ['a duplicate seed', (f: FormData) => f.append('seed', '1')],
    ['a duplicate spec', (f: FormData) => f.append('spec', JSON.stringify(spec))],
    ['no photo', (f: FormData) => f.delete('refs')],
    ['no guide', (f: FormData) => f.delete('guide')],
    ['an invalid seed', (f: FormData) => f.set('seed', '12.5')],
    ['unparsable facts', (f: FormData) => f.set('spec', '{')],
    [
      'free text in the facts',
      (f: FormData) => f.set('spec', JSON.stringify({ ...spec, note: 'gold taps' })),
    ],
    ['a free form', (f: FormData) => f.set('spec', JSON.stringify({ ...spec, form: 'a gold tub' }))],
    ['an unknown kind', (f: FormData) => f.set('spec', JSON.stringify({ ...spec, category: 'vanity' }))],
    [
      'a wall product’s back',
      (f: FormData) =>
        f.set(
          'spec',
          JSON.stringify({
            ...spec,
            category: 'basin',
            form: 'wall-round',
            installation: 'wall',
            direction: 'back',
          }),
        ),
    ],
    [
      'a tile’s 9 mm depth left after switching the category',
      (f: FormData) => f.set('spec', JSON.stringify({ ...spec, sizeMm: [600, 600, 9] })),
    ],
    ['photo angles not one per photo', (f: FormData) => f.set('spec', JSON.stringify(twoPhotos))],
    [
      'photo angles on a bath',
      (f: FormData) => f.set('spec', JSON.stringify({ ...spec, photoAngles: ['front'] })),
    ],
    [
      'a toilet’s back',
      (f: FormData) =>
        f.set(
          'spec',
          JSON.stringify({ ...spec, category: 'toilet', form: 'one-piece', lid: 'seat', direction: 'back' }),
        ),
    ],
    ['oversized facts', (f: FormData) => f.set('spec', JSON.stringify({ ...spec, pad: 'x'.repeat(2000) }))],
    [
      'a guide that is not a PNG',
      (f: FormData) => f.set('guide', new Blob([new Uint8Array([1, 2])]), 'guide.png'),
    ],
  ] as const)('rejects %s before inference', async (_label, edit) => {
    const env = environment();
    await expect(runDirectionPhoto(await request(edit), env)).rejects.toMatchObject({ status: 400 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('checks sizes on the page by the route’s own range', () => {
    expect(directionPhotoSizeOk([1700, 560, 750])).toBe(true);
    expect(directionPhotoSizeOk([600, 600, 9])).toBe(false);
    expect(directionPhotoSizeOk([600, 600, 9.6])).toBe(true);
    expect(directionPhotoSizeOk([10001, 560, 750])).toBe(false);
    expect(directionPhotoSizeOk([Number.NaN, 560, 750])).toBe(false);
  });

  it('rejects four photos before inference', async () => {
    const env = environment();
    const photo = blob(await png(496, 288));
    await expect(
      runDirectionPhoto(
        await request((form) => {
          for (let i = 0; i < 3; i++) form.append('refs', photo, 'photo.png');
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it.each([
    [512, 496],
    [127, 496],
    [200, 496],
    [432, 500],
  ])('rejects a guide of %sx%s', async (w, h) => {
    const env = environment();
    await expect(
      runDirectionPhoto(
        await request(async (form) => form.set('guide', blob(await png(w, h)), 'guide.png')),
        env,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects a photo of an unsupported size or kind before inference', async () => {
    for (const photo of [
      await png(500, 500),
      new Uint8Array(
        await sharp(await png(496, 288))
          .jpeg()
          .toBuffer(),
      ),
    ]) {
      const env = environment();
      await expect(
        runDirectionPhoto(await request((form) => form.set('refs', blob(photo), 'photo.png')), env),
      ).rejects.toMatchObject({ status: 400 });
      expect(env.AI.run).not.toHaveBeenCalled();
    }
  });

  it('applies the same origin, login, body-size and binding rules as the other FLUX routes', async () => {
    const cross = environment();
    await expect(
      runDirectionPhoto(await request(undefined, 'https://evil.example'), cross),
    ).rejects.toMatchObject({
      status: 403,
    });
    const big = environment();
    const oversize = await request();
    oversize.headers.set('content-length', String(9 * 1024 * 1024));
    await expect(runDirectionPhoto(oversize, big)).rejects.toMatchObject({ status: 400 });
    const anonymous = { ...environment(), APP_ENV: 'production', STORAGE_MODE: 'auto' };
    vi.mocked(getD1Actor).mockRejectedValueOnce({ status: 401 });
    await expect(runDirectionPhoto(await request(), anonymous)).rejects.toMatchObject({ status: 401 });
    await expect(
      runDirectionPhoto(await request(), { platform: 'node', APP_ENV: 'development', STORAGE_MODE: 'd1' }),
    ).rejects.toMatchObject({ code: 'binding_unavailable' });
    for (const env of [cross, big, anonymous]) expect(env.AI.run).not.toHaveBeenCalled();
  });

  it.each([402, 429])('surfaces a spent limit (%s) without retry', async (status) => {
    const env = environment(vi.fn(async () => Response.json({ errors: [{ code: 3036 }] }, { status })));
    const failure = await runDirectionPhoto(await request(), env).catch((error) => error);
    expect(failure).toMatchObject({ code: 'quota_exhausted', status: 429 });
    // The route's answer (cloudGemmaErrorResponse) says when the day's AI allocation comes back.
    expect((await cloudGemmaErrorResponse(failure).json()).limit).toEqual({
      service: 'ai',
      resetAt: expect.stringMatching(/T00:00:00\.000Z$/),
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it('keeps sizes and enums only in the diagnostics of a failure, never the prompt or the images', async () => {
    const env = environment(vi.fn(async () => Response.json({ errors: [{ code: 9999 }] }, { status: 500 })));
    const failure = await runDirectionPhoto(await request(), env).catch((error) => error);
    expect(failure.diagnostics).toMatchObject({
      model: FLUX_MODEL,
      phase: 'provider-response',
      upstreamStatus: 500,
      category: 'bath',
      direction: 'left',
      references: 1,
      guide: [432, 496],
    });
    expect(typeof failure.diagnostics.promptLength).toBe('number');
    expect(JSON.stringify(failure.diagnostics)).not.toContain('Image 0');
  });
});

describe('direction photo request from the page', () => {
  it('posts the guide, the photos, the seed and the facts, and carries the status of a refusal', async () => {
    const answer = await png(864, 992);
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect([...form.keys()]).toEqual(['guide', 'refs', 'refs', 'seed', 'spec']);
      expect(JSON.parse(String(form.get('spec')))).toEqual(spec);
      expect(init.headers).toEqual({ 'X-SJN-User-Id': 'user-1' });
      return new Response(answer, { headers: { 'Content-Type': 'image/png' } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const input = {
        guide: blob(await png(432, 496)),
        refs: [blob(await png()), blob(await png())],
        seed: 7,
        spec,
        signal: new AbortController().signal,
        userId: 'user-1',
      };
      // The answer is re-encoded through a canvas in the browser; here the call order is what is checked.
      await requestDirectionPhoto(input).catch(() => undefined);
      expect(fetch).toHaveBeenCalledWith(
        '/api/materials/direction-photo',
        expect.objectContaining({ method: 'POST' }),
      );
      fetch.mockResolvedValueOnce(Response.json({ error: '한도를 모두 사용했어요.' }, { status: 429 }));
      await expect(requestDirectionPhoto(input)).rejects.toMatchObject({
        status: 429,
        message: '한도를 모두 사용했어요.',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
