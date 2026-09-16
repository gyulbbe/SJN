import { CLOUD_GEMMA_APPEARANCE_METADATA } from '../src/lib/reconstruction/cloud-gemma-appearance';
import { createHash } from 'node:crypto';
import { CLOUD_GEMMA_GROUPED_INVENTORY_METADATA, cloudGemmaGroupedInventoryJsonSchema, cloudGemmaGroupedInventoryPrompt } from '../src/lib/reconstruction/cloud-gemma-inventory';
import { createCloudFixtureCropReceipt } from '../src/lib/reconstruction/cloud-fixture-crops';
import {
  createTargetExistenceReceipt,
  targetExistenceSha256,
  targetExistenceCropTransform,
} from '../src/lib/reconstruction/target-existence-observation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertCloudGemmaRequest,
  cloudGemmaAvailability,
  runCloudGemmaModel,
} from '../src/lib/reconstruction/cloud-gemma-server';
import {
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_REVISION,
  CLOUD_GEMMA_IDENTITY,
  CLOUD_GEMMA_SETTINGS,
  isCloudModelIdentity,
  type CloudGemmaBinding,
} from '../src/lib/reconstruction/cloud-gemma-contract';
import {
  classifyCloudGemmaFailure,
  cloudGemmaErrorResponse,
  parseCloudRetryAfter,
} from '../src/lib/reconstruction/cloud-gemma-errors';
import {
  parseFixtureInventory,
} from '../src/lib/reconstruction/inventory-observation';
import { cloudflareLocalRouteSource, cloudflareRuntimeSource } from '../build/cloudflare-local';
import { getD1Actor } from '../src/lib/auth/d1';
import { prepareCloudGemmaSchema } from '../src/lib/reconstruction/cloud-gemma-coordinates';

vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: vi.fn() }));
const origin = 'http://127.0.0.1:3000';
const publicOrigin = 'https://sjn.example';
function photo(width = 400, height = 300) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}
const inventory = () =>
  parseFixtureInventory(
    JSON.stringify({
      items: [
        {
          kind: 'basin',
          bbox_2d: [100, 100, 500, 950],
          view: 'direct',
          basin: { shape: 'rectangular', support: 'wall', bowls: 1 },
          note: 'Visible basin',
        },
      ],
    }),
  ).understanding;
function request(
  operation = 'inventory-extended',
  options: {
    source?: unknown;
    signal?: AbortSignal;
    urlOrigin?: string;
    image?: Blob;
    mutate?: (form: FormData) => void;
  } = {},
) {
  const form = new FormData();
  form.set('operation', operation);
  form.set('photo', options.image ?? photo(), 'photo.png');
  if (!['inventory', 'inventory-extended'].includes(operation))
    form.set('inventory', JSON.stringify(options.source ?? inventory()));
  options.mutate?.(form);
  const urlOrigin = options.urlOrigin ?? origin;
  return new Request(urlOrigin + '/api/reconstruction/cloud', {
    method: 'POST',
    body: form,
    signal: options.signal,
    headers: { Origin: urlOrigin },
  });
}
const groupedEmpty = JSON.stringify({ sanitary: [], mirrors_storage: [], partitions: [], showers_shelves: [], openings: [] });
const groupedPrompt = () => cloudGemmaGroupedInventoryPrompt(prepareCloudGemmaSchema(cloudGemmaGroupedInventoryJsonSchema()));
const completed = (rawText = groupedEmpty, extra = {}) =>
  Response.json({
    id: 'mocked-completion',
    model: CLOUD_GEMMA_MODEL,
    choices: [{ finish_reason: 'stop', message: { content: rawText } }],
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
    ...extra,
  });
function runtime(responder: CloudGemmaBinding['run'] = async (_model, payload) => completed(payload.messages[0].content[0].type === 'text' && payload.messages[0].content[0].text === groupedPrompt() ? groupedEmpty : '{"items":[]}')) {
  const run = vi.fn<CloudGemmaBinding['run']>(responder);
  return {
    run,
    env: { platform: 'cloudflare' as const, APP_ENV: 'local', STORAGE_MODE: 'auto', AI: { run } },
  };
}
afterEach(() => {
  vi.mocked(getD1Actor).mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Cloud Gemma anonymous local storage and D1 access boundaries', () => {
  it.each([
    { APP_ENV: 'local', STORAGE_MODE: 'auto' },
    { APP_ENV: 'local', STORAGE_MODE: 'local' },
    { APP_ENV: 'local', STORAGE_MODE: undefined },
  ])('allows HTTPS same-origin AI with intentional local settings %j', async (settings) => {
    const { run, env } = runtime();
    const environment = { ...env, ...settings };
    const available = await cloudGemmaAvailability(
      new Request(publicOrigin + '/api/reconstruction/cloud'),
      environment,
    );
    expect(available.cacheScope).toMatch(/^anonymous-origin-sha256:[a-f0-9]{64}$/);
    expect(run).not.toHaveBeenCalled();
    await expect(
      runCloudGemmaModel(request('inventory', { urlOrigin: publicOrigin }), environment),
    ).resolves.toMatchObject({ modelId: CLOUD_GEMMA_MODEL, understanding: { candidates: [] } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(getD1Actor).not.toHaveBeenCalled();
  });
  it.each([
    { APP_ENV: 'production', STORAGE_MODE: 'local' },
    { APP_ENV: 'production', STORAGE_MODE: undefined, NEXT_PUBLIC_STORAGE_MODE: 'local' },
    { APP_ENV: undefined, STORAGE_MODE: 'auto' },
    { APP_ENV: 'development', STORAGE_MODE: 'auto' },
    { APP_ENV: 'prodution', STORAGE_MODE: 'local' },
    { APP_ENV: 'production', STORAGE_MODE: 'locla' },
    { APP_ENV: 'production', STORAGE_MODE: '', NEXT_PUBLIC_STORAGE_MODE: 'local' },
    { APP_ENV: 'local', STORAGE_MODE: 'locla' },
    { APP_ENV: 'local', STORAGE_MODE: 'd1' },
    { APP_ENV: 'local', STORAGE_MODE: 'supabase' },
    { APP_ENV: 'production', STORAGE_MODE: 'supabase' },
  ])('does not grant public anonymous AI from fallback or invalid settings %j', async (settings) => {
    const { run, env } = runtime();
    await expect(
      runCloudGemmaModel(request('inventory', { urlOrigin: publicOrigin }), { ...env, ...settings }),
    ).rejects.toMatchObject({ code: 'authentication_unavailable', status: 503 });
    expect(run).not.toHaveBeenCalled();
    expect(getD1Actor).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([
    {},
    { origin: 'null' },
    { origin: 'https://foreign.example' },
    { origin: publicOrigin, 'sec-fetch-site': 'cross-site' },
  ])('denies missing or foreign POST origin before inference: %j', async (headers) => {
    const { run, env } = runtime();
    await expect(
      runCloudGemmaModel(
        new Request(publicOrigin + '/api/reconstruction/cloud', { method: 'POST', headers }),
        env,
      ),
    ).rejects.toMatchObject({ code: 'access_denied', status: 403 });
    expect(run).not.toHaveBeenCalled();
    expect(getD1Actor).not.toHaveBeenCalled();
  });
  it('denies cross-origin availability probes and mismatched request hosts', async () => {
    const { run, env } = runtime();
    await expect(
      cloudGemmaAvailability(
        new Request(publicOrigin + '/api/reconstruction/cloud', {
          headers: { origin: 'https://foreign.example' },
        }),
        env,
      ),
    ).rejects.toMatchObject({ code: 'access_denied', status: 403 });
    await expect(
      cloudGemmaAvailability(
        new Request(publicOrigin + '/api/reconstruction/cloud', { headers: { host: 'foreign.example' } }),
        env,
      ),
    ).rejects.toMatchObject({ code: 'authentication_unavailable', status: 503 });
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps input validation active for public local mode before inference', async () => {
    const { run, env } = runtime();
    await expect(
      runCloudGemmaModel(request('inventory', { urlOrigin: publicOrigin, image: photo(2000) }), env),
    ).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { STORAGE_MODE: 'd1' },
    { STORAGE_MODE: 'auto' },
    { STORAGE_MODE: undefined },
    { STORAGE_MODE: 'd1', NEXT_PUBLIC_STORAGE_MODE: 'local' },
  ])('requires the existing actor for production D1 settings %j', async (settings) => {
    const { run, env } = runtime();
    vi.mocked(getD1Actor).mockRejectedValueOnce({ status: 401 });
    await expect(
      runCloudGemmaModel(request('inventory', { urlOrigin: publicOrigin }), {
        ...env,
        ...settings,
        APP_ENV: 'production',
      }),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    expect(getD1Actor).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    [403, 'access_denied'],
    [503, 'authentication_unavailable'],
  ])('never falls back to anonymous access after D1 auth status %s', async (status, code) => {
    const { run, env } = runtime();
    vi.mocked(getD1Actor).mockRejectedValueOnce({ status });
    await expect(
      runCloudGemmaModel(request('inventory', { urlOrigin: publicOrigin }), {
        ...env,
        APP_ENV: 'production',
        STORAGE_MODE: 'd1',
      }),
    ).rejects.toMatchObject({ code, status });
    expect(getD1Actor).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
  it('preserves the expected-user check before D1 inference', async () => {
    const { run, env } = runtime();
    vi.mocked(getD1Actor).mockResolvedValueOnce({ id: 'signed-in-user', isAdmin: false });
    const input = request('inventory', { urlOrigin: publicOrigin });
    input.headers.set('X-SJN-User-Id', 'different-user');
    await expect(
      runCloudGemmaModel(input, { ...env, APP_ENV: 'production', STORAGE_MODE: 'd1' }),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    expect(run).not.toHaveBeenCalled();
  });
  it('isolates public origins, loopback development and actors with stable cache scopes', async () => {
    const { env, run } = runtime();
    const scope = (urlOrigin: string, environment = env) =>
      assertCloudGemmaRequest(new Request(urlOrigin + '/api/reconstruction/cloud'), environment);
    const anonymous = await scope(publicOrigin);
    expect(await scope(publicOrigin)).toBe(anonymous);
    expect(anonymous).not.toContain(publicOrigin);
    const otherOrigin = await scope('https://other.example');
    const otherPort = await scope(publicOrigin + ':8443');
    const loopback = await scope(origin);
    expect(loopback).toBe('local-dev');
    vi.mocked(getD1Actor).mockResolvedValueOnce({ id: publicOrigin, isAdmin: false });
    const actor = await scope(publicOrigin, { ...env, APP_ENV: 'production', STORAGE_MODE: 'd1' });
    expect(actor).toMatch(/^actor-sha256:[a-f0-9]{64}$/);
    expect(new Set([anonymous, otherOrigin, otherPort, loopback, actor]).size).toBe(5);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Cloudflare Gemma transport (mocked model; no AI accuracy claim or remote calls)', () => {
  it('checks scoped access and binding without any inference or invented weights digest', async () => {
    const { run, env } = runtime();
    const status = await cloudGemmaAvailability(new Request(origin + '/api/reconstruction/cloud'), env);
    expect(status).toMatchObject({
      available: true,
      readiness: 'binding-configured',
      upstreamVerified: false,
      cacheScope: 'local-dev',
      modelId: CLOUD_GEMMA_MODEL,
      modelRevision: CLOUD_GEMMA_REVISION,
      modelIdentity: CLOUD_GEMMA_IDENTITY,
    });
    expect(CLOUD_GEMMA_REVISION).not.toMatch(/^[a-f0-9]{64}$/);
    expect(isCloudModelIdentity(status.modelIdentity)).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it('sends the fixed model, gateway, image data URL and current JSON format with abort signal', async () => {
    const { run, env } = runtime();
    const result = await runCloudGemmaModel(request(), env);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, payload, options] = run.mock.calls[0];
    expect(model).toBe(CLOUD_GEMMA_MODEL);
    expect(options).toMatchObject({
      gateway: { id: 'sjn-gateway', retries: { maxAttempts: 1 } },
      returnRawResponse: true,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(payload).toMatchObject({
      stream: false,
      max_completion_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
    });
    expect(payload.messages[0].content[0]).toEqual({
      type: 'text',
      text: groupedPrompt(),
    });
    expect(payload.messages[0].content[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });
    expect(createHash('sha256').update((payload.messages[0].content[0] as {text:string}).text).digest('hex')).toBe('9790fdecf164364a47c5f77f7933896d4cf5fb2c91a6b38f9ee3660705b3f9c4');
    expect(payload).not.toHaveProperty('format');
    expect(payload).not.toHaveProperty('options');
    expect(result).toMatchObject({
      providerResponseFormat: 'json_object',
      ...CLOUD_GEMMA_GROUPED_INVENTORY_METADATA,
      providerPromptSha256: '9790fdecf164364a47c5f77f7933896d4cf5fb2c91a6b38f9ee3660705b3f9c4',
      providerSchemaSha256: '1442315dc7799910509fd9977b2cb8bccbb98e4f56d2f737bc6a6564269fb97b',
      rawText: groupedEmpty,
      outputContract: 'fixture-inventory-v3',
      provider: 'cloudflare-workers-ai',
      settings: CLOUD_GEMMA_SETTINGS,
      understanding: { candidates: [] },
      modelRevision: CLOUD_GEMMA_REVISION,
      completion: { done: true, inputTokens: 123, outputTokens: 45, totalTokens: 168 },
      measurement: {
        inferenceCalls: 1,
        modelDownload: 'provider-managed',
        inputWidth: 400,
        inputHeight: 300,
      },
    });
  });
  it.each([
    [
      'identity',
      {
        observations: [
          {
            id: 'item_01',
            note: 'Open underside',
            structure: 'wall_basin_open_underside',
            context: 'room_fixture',
          },
        ],
      },
      'fixture-identity-v1',
    ],
    [
      'installation',
      {
        observations: [
          {
            id: 'item_01',
            note: 'Open underside',
            lower_support: 'whole_fixture_suspended_with_gap',
            wall_connection: 'visible_joint',
          },
        ],
      },
      'fixture-installation-v2',
    ],
    [
      'layout',
      {
        observations: [
          { id: 'item_01', note: 'Rear on left wall', wall: 'left', orientation: 'toward-right' },
        ],
        relations: [],
      },
      'fixture-layout-v1',
    ],
    [
      'appearance',
      {
        schemaVersion: 1,
        observations: [
          {
            id: 'item_01',
            note: 'A basin mounted with open underside.',
            kind: 'wall_basin',
            context: 'physical',
            sameObjectAs: null,
            shape: 'rectangular',
            counterSupport: 'unknown',
          },
        ],
      },
      'fixed-candidate-appearance-v1',
    ],
    [
      'shower-detail',
      {
        schemaVersion: 1,
        observations: [
          {
            id: 'item_01',
            note: 'Visible handheld head and hose.',
            kind: 'shower',
            context: 'physical',
            style: 'hand-spray',
            observedPart: 'handset',
            visibleParts: {
              handheldHead: 'present',
              overheadHead: 'uncertain',
              verticalRail: 'uncertain',
              hose: 'present',
            },
          },
        ],
      },
      'fixed-shower-detail-v1',
    ],
  ])('runs the existing %s stage parser and returns its contract', async (operation, output, contract) => {
    const { run, env } = runtime(async () => completed(JSON.stringify(output)));
    const source = inventory();
    if (operation === 'shower-detail')
      source.candidates[0] = {
        ...source.candidates[0],
        kind: 'shower',
        basinStyle: 'unknown',
        validation: undefined,
      };
    let appearanceInput: { image: Blob; mutate: (form: FormData) => void } | undefined;
    if (operation === 'appearance') {
      const jpeg = (width: number, height: number) =>
        new Uint8Array([
          255,
          216,
          255,
          192,
          0,
          17,
          8,
          height >> 8,
          height & 255,
          width >> 8,
          width & 255,
          3,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ]);
      const imageBytes = jpeg(400, 300),
        boardBytes = jpeg(1020, 1024);
      const receipt = await createCloudFixtureCropReceipt(imageBytes, boardBytes, source.candidates);
      appearanceInput = {
        image: new Blob([imageBytes], { type: 'image/jpeg' }),
        mutate: (form) => {
          form.set('appearanceBoard', new Blob([boardBytes], { type: 'image/jpeg' }), 'board.jpg');
          form.set('appearanceReceipt', JSON.stringify(receipt));
        },
      };
    }
    const result = await runCloudGemmaModel(request(operation, { source, ...appearanceInput }), env);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outputContract: contract, modelId: CLOUD_GEMMA_MODEL });
    if (operation === 'layout')
      expect(result).toHaveProperty('relationRuleRevision', 'layout-relations-v2-component-role');
    else expect(result).not.toHaveProperty('relationRuleRevision');
    if (operation === 'appearance') expect(result).toMatchObject(CLOUD_GEMMA_APPEARANCE_METADATA);
    else expect(result).not.toHaveProperty('providerAppearanceContract');
  });
  it.each(['identity', 'installation'])(
    'skips %s when no candidate needs it without a cloud call',
    async (operation) => {
      const { run, env } = runtime();
      const empty = { ...inventory(), candidates: [] };
      const result = await runCloudGemmaModel(request(operation, { source: empty }), env);
      expect(result).toMatchObject({
        modelId: CLOUD_GEMMA_MODEL,
        modelRevision: null,
        measurement: { inferenceCalls: 0 },
      });
      expect(run).not.toHaveBeenCalled();
    },
  );
  it.each([
    (form: FormData) => form.set('upstream', 'https://example.com'),
    (form: FormData) => form.append('operation', 'appearance'),
    (form: FormData) => form.set('inventory', '{}'),
    (form: FormData) => form.set('operation', 'unsupported'),
  ])('rejects malformed fields before making a model request', async (mutate) => {
    const { run, env } = runtime();
    await expect(runCloudGemmaModel(request('inventory-extended', { mutate }), env)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects oversized dimensions and cross-origin requests before inference', async () => {
    const { run, env } = runtime();
    await expect(runCloudGemmaModel(request('inventory', { image: photo(2000) }), env)).rejects.toMatchObject(
      { code: 'invalid_input' },
    );
    const foreign = new Request(origin + '/api/reconstruction/cloud', {
      method: 'POST',
      headers: { origin: 'https://foreign.example' },
    });
    await expect(runCloudGemmaModel(foreign, env)).rejects.toMatchObject({ code: 'access_denied' });
    expect(run).not.toHaveBeenCalled();
  });
  it('uses existing D1 actor policy and separates cache identity without exposing user id', async () => {
    const { env, run } = runtime();
    vi.mocked(getD1Actor).mockResolvedValueOnce({ id: 'user-secret-id', isAdmin: false });
    const result = await cloudGemmaAvailability(new Request('https://example.com/api/reconstruction/cloud'), {
      ...env,
      APP_ENV: 'production',
      STORAGE_MODE: 'd1',
    });
    expect(getD1Actor).toHaveBeenCalledTimes(1);
    expect(result.cacheScope).toMatch(/^actor-sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('user-secret-id');
    expect(run).not.toHaveBeenCalled();
  });
  it('retains a redacted binding exception in the client error response without request secrets', async () => {
    const { run, env } = runtime(async (_model, input) => {
      const imagePart = input.messages[0].content.find((part) => part.type === 'image_url');
      if (!imagePart || imagePart.type !== 'image_url') throw new Error('Missing test image');
      throw Object.assign(
        new TypeError(
          'AI binding cannot serialize AbortSignal; Authorization: Bearer private-binding-token; image=' +
            imagePart.image_url.url,
        ),
        { status: 502, request: { cookie: 'private-session-cookie' }, stack: 'private-stack-path' },
      );
    });
    const failure = await runCloudGemmaModel(request(), env).catch((error: unknown) => error);
    const response = cloudGemmaErrorResponse(failure);
    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'unavailable',
      retryable: false,
      diagnostics: {
        phase: 'provider-request',
        inferenceCalls: 1,
        providerException: {
          name: 'TypeError',
          status: 502,
          message: expect.stringContaining('AI binding cannot serialize AbortSignal'),
        },
      },
    });
    expect(body.diagnostics).not.toHaveProperty('upstreamStatus');
    expect(body.diagnostics).not.toHaveProperty('providerRequestId');
    expect(body.diagnostics.providerException.message).toContain('[image redacted]');
    const serialized = JSON.stringify(body);
    for (const secret of [
      'private-binding-token',
      'private-session-cookie',
      'private-stack-path',
      'data:image/png;base64,',
    ])
      expect(serialized).not.toContain(secret);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each<[Record<string, string>, string]>([
    [{ 'cf-aig-log-id': 'gateway-request-id', 'cf-ray': 'edge-request-id' }, 'gateway-request-id'],
    [{ 'cf-ray': 'edge-request-id' }, 'edge-request-id'],
  ])(
    'retains upstream status and request id for a classified provider response %j',
    async (headers, requestId) => {
      const { run, env } = runtime(async () =>
        Response.json(
          { error: 'capacity', detail: 'private upstream response body' },
          { status: 503, headers: { ...headers, 'Retry-After': '7' } },
        ),
      );
      const failure = await runCloudGemmaModel(request(), env).catch((error: unknown) => error);
      const response = cloudGemmaErrorResponse(failure);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({
        code: 'unavailable',
        retryable: true,
        retryAfterMs: 7000,
        diagnostics: {
          phase: 'provider-response',
          upstreamStatus: 503,
          providerRequestId: requestId,
          inferenceCalls: 1,
        },
      });
      expect(body.diagnostics).not.toHaveProperty('providerException');
      expect(JSON.stringify(body)).not.toContain('private upstream response body');
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
  it('does not retry auth failures, quota exhaustion, 429 or 503 on the server', async () => {
    for (const [status, body, code, retryable] of [
      [429, { errors: [{ code: 3036, message: 'daily free allocation' }] }, 'quota_exhausted', false],
      [403, { errors: [{ code: 5035 }] }, 'authentication_required', false],
      [429, { errors: [{ code: 3040 }] }, 'rate_limited', true],
      [503, { error: 'capacity' }, 'unavailable', true],
    ] as const) {
      const { run, env } = runtime(async () =>
        Response.json(body, { status, headers: { 'Retry-After': '7' } }),
      );
      await expect(runCloudGemmaModel(request(), env)).rejects.toMatchObject({
        code,
        retryable,
        ...(retryable ? { retryAfterMs: 7000 } : {}),
      });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
  it.each([
    CLOUD_GEMMA_MODEL,
    'google/gemma-4-26b-a4b-it',
    'gemma-4-26b-a4b-it',
    '@cf/google/gemma-4-26b-a4b-it-external',
  ])(
    'accepts only the established provider model alias %s while retaining the observed name',
    async (providerModel) => {
      const { run, env } = runtime(async () => completed(groupedEmpty, { model: providerModel }));
      await expect(runCloudGemmaModel(request(), env)).resolves.toMatchObject({
        modelId: CLOUD_GEMMA_MODEL,
        modelRevision: CLOUD_GEMMA_REVISION,
        modelIdentity: CLOUD_GEMMA_IDENTITY,
        providerModel,
        rawText: groupedEmpty,
        understanding: { candidates: [] },
        completion: { done: true, inputTokens: 123, outputTokens: 45, totalTokens: 168 },
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toBe(CLOUD_GEMMA_MODEL);
    },
  );
  it.each([
    '@cf/google/gemma-4-26b-a4b-it-untrusted',
    '@cf/google/gemma-4-26b-a4b-it-external-untrusted',
    'google/gemma-4-26b-a4b-it-external',
    'gemma-4-26b-a4b-it-external',
    '@cf/google/different-model',
    '@cf/google/gemma-4-26b-a4b-it-external ',
  ])('rejects unapproved model %s and preserves its response evidence', async (providerModel) => {
    const rawText = '{"items":[],"evidence":"provider mismatch fixture"}';
    const { run, env } = runtime(async () =>
      completed(rawText, {
        model: providerModel,
        usage: { prompt_tokens: 321, completion_tokens: 54, total_tokens: 375 },
      }),
    );
    const failure = await runCloudGemmaModel(request(), env).catch((error: unknown) => error);
    const response = cloudGemmaErrorResponse(failure);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: '요청한 Gemma 모델과 응답 모델이 달라요.',
      code: 'invalid_response',
      retryable: false,
      diagnostics: {
        modelId: CLOUD_GEMMA_MODEL,
        providerModel,
        rawText,
        phase: 'provider-response',
        upstreamStatus: 200,
        completion: {
          done: true,
          doneReason: 'stop',
          inputTokens: 321,
          outputTokens: 54,
          totalTokens: 375,
        },
        measurement: { inferenceCalls: 1, inputTokens: 321, outputTokens: 54 },
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([
    { choices: [{ finish_reason: 'length', message: { content: '{"items":[]}' } }] },
    { choices: [{ finish_reason: null, message: { content: '{"items":[]}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'invalid JSON' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{"items":[]}', refusal: 'blocked' } }] },
    { model: 'another-model' },
    { message: { content: '{"items":[]}' }, choices: undefined },
  ])('rejects truncated, refused, wrong-model or invalid results', async (extra) => {
    const { env } = runtime(async () => completed('{"items":[]}', extra));
    await expect(runCloudGemmaModel(request(), env)).rejects.toMatchObject({
      code: extra.choices?.[0]?.finish_reason === 'length' ? 'output_limit' : 'invalid_response',
    });
  });
  it('cancels an active model request and issues no follow-up calls', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { run, env } = runtime(
      (_model, _input, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          started();
        }),
    );
    const result = runCloudGemmaModel(request('inventory', { signal: controller.signal }), env);
    const assertion = expect(result).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    await ready;
    controller.abort();
    await assertion;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('times out one model invocation after 120 seconds and aborts upstream', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { run, env } = runtime(
      (_model, _input, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          started();
        }),
    );
    const result = runCloudGemmaModel(request(), env);
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout', retryable: false });
    await ready;
    await vi.advanceTimersByTimeAsync(120_001);
    await assertion;
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('Cloud error and Workers build contracts', () => {
  it('honors seconds/date Retry-After and emits a safe bounded error contract', async () => {
    expect(parseCloudRetryAfter('10')).toBe(10_000);
    expect(parseCloudRetryAfter('Wed, 01 Jan 2025 00:00:10 GMT', Date.parse('2025-01-01T00:00:00Z'))).toBe(
      10_000,
    );
    expect(parseCloudRetryAfter('invalid')).toBeUndefined();
    const response = cloudGemmaErrorResponse(classifyCloudGemmaFailure(503, 'busy', '7'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(await response.json()).toMatchObject({ code: 'unavailable', retryable: true, retryAfterMs: 7000 });
    expect(classifyCloudGemmaFailure(429, { errors: [{ code: 3036 }] }).retryable).toBe(false);
    expect(classifyCloudGemmaFailure(429, { error: { code: 'insufficient_quota' } }).retryable).toBe(false);
  });
  it('keeps the new route active and forwards AI through the existing runtime binding spread', () => {
    expect(
      cloudflareLocalRouteSource(
        '/workspace/SJN/src/app/api/reconstruction/cloud/route.ts',
        '/workspace/SJN',
      ),
    ).toBeNull();
    expect(cloudflareRuntimeSource('/workspace/SJN/src/lib/platform/runtime.ts', '/workspace/SJN')).toContain(
      '...env',
    );
    const source = readFileSync('src/lib/reconstruction/cloud-gemma-server.ts', 'utf8');
    expect(source).not.toMatch(
      /from ['"](?:node:|.*local-engine-server|.*geometry-local-server)|child_process|sharp/,
    );
    const config = readFileSync('wrangler.jsonc', 'utf8');
    expect(config).toMatch(/"ai":\s*\{\s*"binding":\s*"AI"/);
    expect(config).toContain('"binding": "ASSETS"');
  });
});

describe('Cloud divider and target-existence byte contracts (mocked model)', () => {
  function jpeg(width: number, height: number) {
    const bytes = new Uint8Array(23);
    bytes.set([255, 216, 255, 192, 0, 17, 8]);
    const view = new DataView(bytes.buffer);
    view.setUint16(7, height);
    view.setUint16(9, width);
    return bytes;
  }
  it('uses original fixed divider ids and verifies the supplied image SHA before inference', async () => {
    const source = inventory();
    source.candidates[0] = { ...source.candidates[0], kind: 'glassPartition', basinStyle: 'unknown' };
    const bytes = jpeg(400, 300);
    const hash = await targetExistenceSha256(bytes);
    const targets = source.candidates.map(({ id, bounds }) => ({ id, bounds }));
    const raw = JSON.stringify({
      schemaVersion: 1,
      observations: [
        {
          id: 'item_01',
          note: 'A translucent divider is visible.',
          context: 'physical',
          dividerMaterial: 'rigid-glass',
          visibleExtent: 'whole',
          support: 'unknown',
        },
      ],
    });
    const { run, env } = runtime(async () => completed(raw));
    const create = (fingerprint: string) =>
      request('divider-material', {
        source,
        image: new Blob([bytes], { type: 'image/jpeg' }),
        mutate: (form) => {
          form.set('targets', JSON.stringify(targets));
          form.set('modelInputSha256', fingerprint);
        },
      });
    await expect(runCloudGemmaModel(create('f'.repeat(64)), env)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(run).not.toHaveBeenCalled();
    const result = await runCloudGemmaModel(create(hash), env);
    expect(result).toMatchObject({
      modelInputSha256: hash,
      outputContract: 'fixed-candidate-divider-material-v1',
      observations: [{ id: 'item_01', dividerMaterial: 'rigid-glass' }],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('sends full photo and matching contextual crop, verifies Gemma receipt, and validates target JSON', async () => {
    const photoBytes = new Uint8Array(await photo().arrayBuffer());
    const full = jpeg(400, 300);
    const bounds = { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 };
    const transform = targetExistenceCropTransform({ width: 400, height: 300 }, bounds);
    const crop = jpeg(transform.width, transform.height);
    const receipt = await createTargetExistenceReceipt({
      photoBytes,
      normalizedFullBytes: full,
      cropBytes: crop,
      expectedPhotoFingerprint: await targetExistenceSha256(photoBytes),
      targetId: 'panel',
      boxes: [{ id: 'panel', bounds }],
      cropTransform: transform,
      sourceDecisionSignature: 'mocked-source-decision-v1',
      modelId: CLOUD_GEMMA_MODEL,
      modelRevision: CLOUD_GEMMA_REVISION,
    });
    const raw = JSON.stringify({
      id: 'panel',
      note: 'One panel with a direct outer boundary.',
      kind: 'mirror',
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
    });
    const { run, env } = runtime(async () => completed(raw));
    const targetRequest = (cropBytes: Uint8Array<ArrayBuffer>) =>
      request('target-existence', {
        image: new Blob([full], { type: 'image/jpeg' }),
        mutate: (form) => {
          form.delete('inventory');
          form.set('crop', new Blob([cropBytes], { type: 'image/jpeg' }), 'crop.jpg');
          form.set('receipt', JSON.stringify(receipt));
        },
      });
    const wrong = new Uint8Array(crop);
    wrong[22] = 1;
    await expect(runCloudGemmaModel(targetRequest(wrong), env)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(run).not.toHaveBeenCalled();
    const result = await runCloudGemmaModel(targetRequest(crop), env);
    expect(result).toMatchObject({
      outputContract: 'target-existence-v1',
      receipt,
      observation: { id: 'panel', kind: 'mirror' },
    });
    const payload = run.mock.calls[0][1];
    const parts = payload.messages[0].content;
    const promptPart = parts[0];
    if (promptPart.type !== 'text') throw new Error('Expected provider prompt');
    expect(await targetExistenceSha256(promptPart.text)).toBe(receipt.promptSha256);
    if (payload.response_format.type !== 'json_schema') throw new Error('Expected target-existence schema');
    expect(await targetExistenceSha256(JSON.stringify(payload.response_format.json_schema.schema))).toBe(
      receipt.schemaSha256,
    );
    expect(result).toMatchObject({
      providerPromptSha256: receipt.promptSha256,
      providerSchemaSha256: receipt.schemaSha256,
    });
    expect(parts).toHaveLength(3);
    expect(parts[1].type).toBe('image_url');
    expect(parts[2].type).toBe('image_url');
  });
});
