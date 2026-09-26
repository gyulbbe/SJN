import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { runFluxCheck, fluxCheckPayload, readFluxCheckCompletion } from '../src/lib/ai-export/check-server';
import {
  fluxCheckPrompt,
  fluxCheckWarnings,
  parseFluxCheck,
  type FluxCheckScene,
} from '../src/lib/ai-export/check-contract';
import { CLOUD_GEMMA_GATEWAY_ID, CLOUD_GEMMA_MODEL } from '../src/lib/reconstruction/cloud-gemma-contract';

vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: vi.fn() }));
import { getD1Actor } from '../src/lib/auth/d1';
beforeEach(() => vi.mocked(getD1Actor).mockResolvedValue({ id: 'fixture-user', isAdmin: false }));

const scene: FluxCheckScene = {
  version: 1,
  fixtures: [
    { kind: 'toilet', box: [0.564, 0.615, 0.637, 0.806] },
    { kind: 'basin', box: [0.274, 0.583, 0.371, 0.65] },
  ],
};
const jpeg = async (width = 992, height = 672) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#cbc4bb' } })
      .jpeg()
      .toBuffer(),
  );
function request(image: Uint8Array, extra?: (form: FormData) => void, origin = 'https://sjn.example') {
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'result.jpg');
  form.set('scene', JSON.stringify(scene));
  extra?.(form);
  return new Request('https://sjn.example/api/export/photoreal/check', {
    method: 'POST',
    headers: { origin },
    body: form,
  });
}
const answer = (fixtures: unknown[]) =>
  Response.json({
    result: {
      model: CLOUD_GEMMA_MODEL,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ fixtures }) } }],
      usage: { prompt_tokens: 1210, completion_tokens: 38, total_tokens: 1248 },
    },
  });
function environment(
  run = vi.fn(async () =>
    answer([
      { index: 1, present: 'yes', seenAs: 'toilet' },
      { index: 2, present: 'no', seenAs: 'none' },
    ]),
  ),
) {
  return { platform: 'cloudflare' as const, APP_ENV: 'development', STORAGE_MODE: 'd1', AI: { run } };
}

describe('FLUX result check (mock inference)', () => {
  it('asks Gemma once through the gateway with the server-written question and reads each fixture', async () => {
    const env = environment();
    const response = await runFluxCheck(request(await jpeg()), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(body.fixtures).toEqual([
      { index: 1, present: 'yes', seenAs: 'toilet', kind: 'toilet' },
      { index: 2, present: 'no', seenAs: 'none', kind: 'basin' },
    ]);
    expect(body.usage).toEqual({ inputTokens: 1210, outputTokens: 38 });
    expect(fluxCheckWarnings(body).map((f: { kind: string }) => f.kind)).toEqual(['basin']);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const [model, payload, options] = (
      env.AI.run.mock.calls as unknown as [
        string,
        ReturnType<typeof fluxCheckPayload>,
        Record<string, unknown>,
      ][]
    )[0];
    expect(model).toBe(CLOUD_GEMMA_MODEL);
    expect(options).toMatchObject({ gateway: { id: CLOUD_GEMMA_GATEWAY_ID, retries: { maxAttempts: 1 } } });
    const content = payload.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: fluxCheckPrompt(scene) });
    expect((content[1] as { image_url: { url: string } }).image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(payload.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
  });

  it('writes a deterministic English question from kinds and boxes only', () => {
    const prompt = fluxCheckPrompt(scene);
    expect(prompt).toBe(fluxCheckPrompt(structuredClone(scene)));
    expect(prompt).toContain('1. toilet at x 56–64%, y 62–81%');
    expect(prompt).toContain('2. washbasin at x 27–37%, y 58–65%');
    expect(prompt).not.toMatch(/[가-힣]/);
  });

  it.each([
    ['an extra field', (f: FormData) => f.set('prompt', 'is this fine?')],
    ['a missing scene', (f: FormData) => f.delete('scene')],
    ['a duplicate image', (f: FormData) => f.append('image', new Blob(['x']), 'b.jpg')],
    [
      'free text in the scene',
      (f: FormData) => f.set('scene', JSON.stringify({ ...scene, note: 'my toilet' })),
    ],
    [
      'a product name as kind',
      (f: FormData) =>
        f.set(
          'scene',
          JSON.stringify({ version: 1, fixtures: [{ kind: '로얄 양변기', box: [0, 0, 1, 1] }] }),
        ),
    ],
    [
      'an empty box',
      (f: FormData) =>
        f.set(
          'scene',
          JSON.stringify({ version: 1, fixtures: [{ kind: 'toilet', box: [0.5, 0.5, 0.5, 0.6] }] }),
        ),
    ],
    [
      'thirteen fixtures',
      (f: FormData) =>
        f.set(
          'scene',
          JSON.stringify({
            version: 1,
            fixtures: Array.from({ length: 13 }, () => ({ kind: 'toilet', box: [0, 0, 0.1, 0.1] })),
          }),
        ),
    ],
    ['broken JSON', (f: FormData) => f.set('scene', '{')],
  ] as const)('rejects %s before inference', async (_label, edit) => {
    const env = environment();
    await expect(runFluxCheck(request(await jpeg(), edit), env)).rejects.toMatchObject({ status: 400 });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects an oversized or non-image upload before inference', async () => {
    const env = environment();
    await expect(runFluxCheck(request(await jpeg(1100, 700)), env)).rejects.toMatchObject({ status: 400 });
    await expect(runFluxCheck(request(new TextEncoder().encode('not an image')), env)).rejects.toMatchObject({
      status: 400,
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('refuses another origin before inference', async () => {
    const env = environment();
    await expect(
      runFluxCheck(request(await jpeg(), undefined, 'https://other.example'), env),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('keeps a provider failure as one call with size-only diagnostics', async () => {
    const run = vi.fn(async () =>
      Response.json({ errors: [{ message: 'Quota exceeded' }] }, { status: 429 }),
    );
    const env = environment(run);
    const failure = await runFluxCheck(request(await jpeg()), env).catch((error) => error);
    expect(failure.status).toBe(429);
    expect(run).toHaveBeenCalledTimes(1);
    expect(failure.diagnostics).toMatchObject({ fixtures: 2, imageWidth: 992, imageHeight: 672 });
    expect(JSON.stringify(failure.diagnostics)).not.toMatch(/toilet|washbasin|base64/);
  });

  it('reads answers strictly: every fixture once, known words only, finished completions only', () => {
    const ok = JSON.stringify({
      fixtures: [
        { index: 2, present: 'unsure', seenAs: 'other' },
        { index: 1, present: 'yes', seenAs: 'toilet' },
      ],
    });
    expect(parseFluxCheck('```json\n' + ok + '\n```', scene).map((f) => [f.kind, f.present])).toEqual([
      ['toilet', 'yes'],
      ['basin', 'unsure'],
    ]);
    const bad = [
      { fixtures: [{ index: 1, present: 'yes', seenAs: 'toilet' }] },
      {
        fixtures: [
          { index: 1, present: 'yes', seenAs: 'toilet' },
          { index: 1, present: 'no', seenAs: 'none' },
        ],
      },
      {
        fixtures: [
          { index: 1, present: 'maybe', seenAs: 'toilet' },
          { index: 2, present: 'yes', seenAs: 'basin' },
        ],
      },
      {
        fixtures: [
          { index: 1, present: 'yes', seenAs: 'trash can' },
          { index: 2, present: 'yes', seenAs: 'basin' },
        ],
      },
    ];
    for (const value of bad) expect(() => parseFluxCheck(JSON.stringify(value), scene)).toThrow();
    const completion = (finish: string, content: string | null) => ({
      result: { model: CLOUD_GEMMA_MODEL, choices: [{ finish_reason: finish, message: { content } }] },
    });
    expect(() => readFluxCheckCompletion(completion('length', ok), scene)).toThrow();
    expect(() => readFluxCheckCompletion(completion('stop', null), scene)).toThrow();
    expect(() =>
      readFluxCheckCompletion({ result: { ...completion('stop', ok).result, model: 'other-model' } }, scene),
    ).toThrow();
    expect(readFluxCheckCompletion(completion('stop', ok), scene).fixtures).toHaveLength(2);
  });
});
