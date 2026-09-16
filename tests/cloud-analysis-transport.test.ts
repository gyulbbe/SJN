import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_GEMMA_IDENTITY,
  CLOUD_GEMMA_MODEL,
  CLOUD_GEMMA_REVISION,
} from '../src/lib/reconstruction/cloud-gemma-contract';

let transport: typeof import('../src/lib/reconstruction/analysis-transport');
const endpoint = '/api/reconstruction/cloud';
function form(photo = 'same-normalized-photo', operation = 'inventory-extended') {
  const value = new FormData();
  value.set('operation', operation);
  value.set('photo', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  return value;
}
function output(marker = 'mock-model-result') {
  return {
    provider: 'cloudflare-workers-ai',
    modelId: CLOUD_GEMMA_MODEL,
    modelRevision: CLOUD_GEMMA_REVISION,
    modelIdentity: CLOUD_GEMMA_IDENTITY,
    outputContract: 'fixture-inventory-v3',
    promptRevision: 9,
    rawText: '{"items":[]}',
    understanding: { candidates: [] },
    marker,
    measurement: { requestMs: 12, inferenceCalls: 1 },
  };
}
function fetchMock(
  respond: (attempt: number, init: RequestInit) => Promise<Response> = async () => Response.json(output()),
) {
  let scope = 'actor-A',
    available = true,
    posts = 0,
    gets = 0;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    expect(url).toBe(endpoint);
    if (init.method === 'POST') {
      posts++;
      return respond(posts, init);
    }
    gets++;
    return Response.json(available ? { available: true, cacheScope: scope } : { error: 'Login required' }, {
      status: available ? 200 : 401,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    fetcher,
    get posts() {
      return posts;
    },
    get gets() {
      return gets;
    },
    setScope(value: string) {
      scope = value;
    },
    signOut() {
      available = false;
    },
  };
}
const call = (body = form(), signal = new AbortController().signal) =>
  transport.fetchAnalysis('cloudflare-workers-ai', {
    method: 'POST',
    body,
    signal,
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// This mock fetch does not attach listeners to the caller signal. The transport
// registers its abort listener only after incrementing the flight's subscriber
// count, so this is a subscription barrier (unlike GET count or an event-loop tick).
function subscribed(signal: AbortSignal) {
  const ready = deferred<void>();
  const addEventListener = signal.addEventListener.bind(signal);
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
    addEventListener(type, listener, options);
    if (type === 'abort') ready.resolve();
  });
  return ready.promise;
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  transport = await import('../src/lib/reconstruction/analysis-transport');
});
afterEach(() => {
  transport.cancelActiveCloudAnalysis();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cloud stage retry policy (mock HTTP, no real inference)', () => {
  it('honors Retry-After seconds/date and exponential backoff without early or unbounded retries', () => {
    const response = (header?: string) =>
      new Response('', { status: 429, headers: header ? { 'Retry-After': header } : {} });
    expect(transport.retryDelay(response('7'), { retryable: true }, 0)).toBe(7000);
    expect(transport.retryDelay(response(), { retryable: true }, 1)).toBe(2000);
    expect(transport.retryDelay(response(), { retryable: true, retryAfterMs: 5000 }, 1)).toBe(5000);
    expect(
      transport.retryDelay(
        response('Wed, 01 Jan 2025 00:00:09 GMT'),
        { retryable: true },
        0,
        Date.parse('2025-01-01T00:00:00Z'),
      ),
    ).toBe(9000);
    expect(transport.retryDelay(response('121'), { retryable: true }, 0)).toBeNull();
    expect(transport.retryDelay(response('7'), { retryable: true }, 2)).toBeNull();
  });
  it.each([429, 503])(
    'retries transient HTTP %s after the supplied wait, at most three HTTP attempts',
    async (status) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const first = deferred<void>();
      const mock = fetchMock(async (attempt) => {
        if (attempt === 1) first.resolve();
        return attempt < 3
          ? Response.json(
              { error: 'temporary', retryable: true, diagnostics: { inferenceCalls: 1 } },
              { status, headers: { 'Retry-After': '3' } },
            )
          : Response.json(output());
      });
      const result = call();
      await first.promise;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2999);
      expect(mock.posts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mock.posts).toBe(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await (await result).json()).toMatchObject({
        measurement: { httpAttempts: 3, inferenceCalls: 3, unknownAttempts: 0, cacheHit: false },
      });
      expect(mock.posts).toBe(3);
    },
  );
  it.each([
    [429, 'quota_exhausted'],
    [401, 'authentication_required'],
    [403, 'authentication_required'],
    [400, 'invalid_input'],
    [504, 'timeout'],
  ])('does not automatically retry terminal HTTP %s %s', async (status, code) => {
    const mock = fetchMock(async () =>
      Response.json({ error: 'terminal', code, retryable: false }, { status }),
    );
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(mock.posts).toBe(1);
  });
  it('cancels during backoff before another upstream request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = deferred<void>();
    const mock = fetchMock(async () => {
      first.resolve();
      return Response.json(
        { error: 'busy', retryable: true },
        { status: 429, headers: { 'Retry-After': '30' } },
      );
    });
    const controller = new AbortController();
    const pending = call(form(), controller.signal).then(
      () => null,
      (error) => error,
    );
    await first.promise;
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(mock.posts).toBe(1);
  });
});

describe('cloud stage sharing and completed-cache auth scope (real fake IndexedDB)', () => {
  it('coalesces duplicate work and returns independently owned results', async () => {
    const started = deferred<void>(),
      finish = deferred<Response>();
    const mock = fetchMock(async () => {
      started.resolve();
      return finish.promise;
    });
    const secondController = new AbortController();
    const secondSubscribed = subscribed(secondController.signal);
    const first = call(),
      second = call(form(), secondController.signal);
    await Promise.all([started.promise, secondSubscribed]);
    finish.resolve(Response.json(output()));
    const [a, b] = await Promise.all([first.then((r) => r.json()), second.then((r) => r.json())]);
    a.marker = 'mutated-only-a';
    expect(b.marker).toBe('mock-model-result');
    expect(mock.posts).toBe(1);
  });
  it('lets one subscriber cancel while retaining another subscriber request', async () => {
    const started = deferred<AbortSignal>(),
      finish = deferred<Response>();
    const mock = fetchMock(async (_attempt, init) => {
      started.resolve(init.signal!);
      return finish.promise;
    });
    const controller = new AbortController();
    const first = call(form(), controller.signal).then(
      () => null,
      (error) => error,
    );
    const secondController = new AbortController();
    const secondSubscribed = subscribed(secondController.signal);
    const second = call(form(), secondController.signal);
    const signal = await started.promise;
    await secondSubscribed;
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(signal.aborted).toBe(false);
    finish.resolve(Response.json(output()));
    expect(await (await second).json()).toMatchObject({ marker: 'mock-model-result' });
    expect(mock.posts).toBe(1);
  });
  it('starts new work when the last subscriber cancels while another caller is still hashing', async () => {
    const started = deferred<AbortSignal>();
    const readingSecondPhoto = deferred<void>();
    const secondPhotoBytes = deferred<ArrayBuffer>();
    const mock = fetchMock(async (attempt, init) => {
      if (attempt > 1) return Response.json(output());
      started.resolve(init.signal!);
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const first = call(form(), controller.signal).then(
      () => null,
      (error) => error,
    );
    const signal = await started.promise;
    const secondBody = form();
    vi.spyOn(secondBody.get('photo') as Blob, 'arrayBuffer').mockImplementation(() => {
      readingSecondPhoto.resolve();
      return secondPhotoBytes.promise;
    });
    const second = call(secondBody);
    try {
      await readingSecondPhoto.promise;
      expect(mock.gets).toBe(2);
      // Reproduce the old test's barrier while deliberately keeping this caller
      // outside subscribe(). An event-loop tick cannot finish its pending bytes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      expect(await first).toMatchObject({ name: 'AbortError' });
      expect(signal.aborted).toBe(true);
      secondPhotoBytes.resolve(new TextEncoder().encode('same-normalized-photo').buffer);
      expect(await (await second).json()).toMatchObject({ marker: 'mock-model-result' });
      expect(mock.posts).toBe(2);
    } finally {
      controller.abort();
      secondPhotoBytes.resolve(new TextEncoder().encode('same-normalized-photo').buffer);
      await Promise.allSettled([first, second]);
    }
  });
  it('aborts upstream when all subscribers cancel or page teardown is signalled', async () => {
    const started = deferred<AbortSignal>();
    const mock = fetchMock(async (_attempt, init) => {
      started.resolve(init.signal!);
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
      );
    });
    const pending = call().then(
      () => null,
      (error) => error,
    );
    const signal = await started.promise;
    transport.cancelActiveCloudAnalysis();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(signal.aborted).toBe(true);
    expect(mock.posts).toBe(1);
  });
  it('reuses completed stages only after current auth checks, isolating users, photos and operations', async () => {
    const mock = fetchMock();
    await call();
    const cached = await (await call()).json();
    expect(cached.measurement).toMatchObject({ cacheHit: true, inferenceCalls: 0, httpAttempts: 0 });
    expect(mock.posts).toBe(1);
    expect(mock.gets).toBe(2);
    mock.setScope('actor-B');
    await call();
    expect(mock.posts).toBe(2);
    await call(form('different-photo'));
    expect(mock.posts).toBe(3);
    await call(form('same-normalized-photo', 'layout'));
    expect(mock.posts).toBe(4);
    mock.signOut();
    await expect(call()).rejects.toThrow('Login required');
    expect(mock.posts).toBe(4);
    expect(mock.gets).toBe(6);
  });
  it('isolates anonymous origins and actor caches when the same browser changes access mode', async () => {
    const mock = fetchMock(async (attempt) => Response.json(output('network-' + attempt)));
    const firstOrigin = 'anonymous-origin-sha256:' + 'a'.repeat(64);
    mock.setScope(firstOrigin);
    expect(await (await call()).json()).toMatchObject({ marker: 'network-1' });
    expect(await (await call()).json()).toMatchObject({
      marker: 'network-1',
      measurement: { cacheHit: true },
    });
    mock.setScope('anonymous-origin-sha256:' + 'b'.repeat(64));
    expect(await (await call()).json()).toMatchObject({
      marker: 'network-2',
      measurement: { cacheHit: false },
    });
    mock.setScope('actor-sha256:' + 'a'.repeat(64));
    expect(await (await call()).json()).toMatchObject({
      marker: 'network-3',
      measurement: { cacheHit: false },
    });
    mock.setScope('local-dev');
    expect(await (await call()).json()).toMatchObject({
      marker: 'network-4',
      measurement: { cacheHit: false },
    });
    mock.setScope(firstOrigin);
    expect(await (await call()).json()).toMatchObject({
      marker: 'network-1',
      measurement: { cacheHit: true },
    });
    expect(mock.posts).toBe(4);
    expect(mock.gets).toBe(6);
  });
  it('does not reuse a persisted response altered after its completion receipt', async () => {
    const mock = fetchMock(async (attempt) => Response.json(output('network-' + attempt)));
    await call();
    const db = await openDB('sjn-reconstruction-cloud-stages', 1);
    const records = await db.getAll('stages');
    expect(records).toHaveLength(1);
    const record = records[0];
    record.value.marker = 'corrupted';
    record.value.rawText = '{"items":[{"invented":"fixture"}]}';
    await db.put('stages', record);
    db.close();
    const result = await (await call()).json();
    expect(result.marker).toBe('network-2');
    expect(mock.posts).toBe(2);
  });
  it('rejects mismatched provider/model and never saves the failed response', async () => {
    const mock = fetchMock(async (attempt) =>
      Response.json(attempt === 1 ? { ...output(), modelRevision: 'a'.repeat(64) } : output('second-valid')),
    );
    await expect(call()).rejects.toThrow();
    expect(await (await call()).json()).toMatchObject({ marker: 'second-valid' });
    expect(mock.posts).toBe(2);
  });
  it('rejects retired local calls without a network request or cloud fallback', async () => {
    const fetcher = vi.fn(async () => new Response('local-response'));
    vi.stubGlobal('fetch', fetcher);
    const init = { method: 'POST', body: form(), headers: { 'X-SJN-Lab': 'local-explicit' } };
    await expect(transport.fetchAnalysis('local-ollama', init)).rejects.toThrow('종료');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('cloud completed-stage retention boundaries', () => {
  it('expires a completed record after 24 hours instead of silently preserving managed-model results', async () => {
    const mock = fetchMock(async (attempt) => Response.json(output('network-' + attempt)));
    await call();
    const db = await openDB('sjn-reconstruction-cloud-stages', 1);
    const record = (await db.getAll('stages'))[0];
    record.savedAt = Date.now() - 25 * 60 * 60 * 1000;
    await db.put('stages', record);
    db.close();
    expect(await (await call()).json()).toMatchObject({ marker: 'network-2' });
    expect(mock.posts).toBe(2);
  });
  it('retains a completed first stage and retries only the failed next stage on explicit retry', async () => {
    let inventoryCalls = 0,
      layoutCalls = 0;
    fetchMock(async (_attempt, init) => {
      const operation = (init.body as FormData).get('operation');
      if (operation === 'inventory-extended') {
        inventoryCalls++;
        return Response.json(output('inventory'));
      }
      layoutCalls++;
      return layoutCalls === 1
        ? Response.json(
            { error: 'invalid schema', code: 'invalid_response', retryable: false },
            { status: 502 },
          )
        : Response.json(output('layout'));
    });
    await call(form());
    await expect(call(form('same-normalized-photo', 'layout'))).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(await (await call(form())).json()).toMatchObject({
      marker: 'inventory',
      measurement: { cacheHit: true },
    });
    expect(await (await call(form('same-normalized-photo', 'layout'))).json()).toMatchObject({
      marker: 'layout',
    });
    expect(inventoryCalls).toBe(1);
    expect(layoutCalls).toBe(2);
  });
});

it('reuses a completed in-memory stage when IndexedDB reads work but writes hit quota', async () => {
  const mock = fetchMock();
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new DOMException('Simulated full browser storage', 'QuotaExceededError');
  });
  const first = await (await call()).json();
  expect(first.measurement.cacheWarning).toContain('이 탭');
  const db = await openDB('sjn-reconstruction-cloud-stages', 1);
  expect(await db.getAll('stages')).toEqual([]);
  db.close();
  const retry = await (await call()).json();
  expect(retry).toMatchObject({
    marker: 'mock-model-result',
    measurement: { cacheHit: true, inferenceCalls: 0, httpAttempts: 0 },
  });
  expect(mock.posts).toBe(1);
  expect(mock.gets).toBe(2);
});

it.each(['appearance', 'inventory-extended'])(
  'migrates only the old appearance stage cache, retaining v7 %s records',
  async (operation) => {
    const { cloudOperationCacheIdentity } =
      await import('../src/lib/reconstruction/cloud-gemma-cache-contract');
    const identity = JSON.parse(cloudOperationCacheIdentity(operation));
    // The prior v7 operation identity contained neither new appearance-only field.
    delete identity.providerAppearanceContract;
    delete identity.providerAppearancePromptRevision;
    const digest = async (text: string) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    const photo = 'same-normalized-photo';
    const parts = [
      ['operation', operation],
      ['photo', `image/jpeg:${photo.length}:${await digest(photo)}`],
    ];
    const key = await digest(
      JSON.stringify({
        cacheVersion: 'cloud-stage-v1',
        operation: JSON.stringify(identity),
        scope: 'actor-A',
        parts,
      }),
    );
    const value = output('old-v7-completed-stage');
    const db = await openDB('sjn-reconstruction-cloud-stages', 1, {
      upgrade(database) {
        database.createObjectStore('stages', { keyPath: 'key' }).createIndex('savedAt', 'savedAt');
      },
    });
    await db.put('stages', {
      key,
      savedAt: Date.now(),
      value,
      checksum: await digest(JSON.stringify({ key, value })),
    });
    db.close();
    const http = fetchMock(async () => Response.json(output('new-stage-request')));
    const result = await (await call(form(photo, operation))).json();
    expect(result.marker).toBe(operation === 'appearance' ? 'new-stage-request' : 'old-v7-completed-stage');
    expect(result.measurement.cacheHit).toBe(operation !== 'appearance');
    expect(http.posts).toBe(operation === 'appearance' ? 1 : 0);
    expect(http.gets).toBe(1);
  },
);

it.each(['layout', 'inventory-extended', 'target-existence'])(
  'isolates the layout relation parser revision while preserving v7 %s cached stages',
  async (operation) => {
    const { cloudOperationCacheIdentity } =
      await import('../src/lib/reconstruction/cloud-gemma-cache-contract');
    const identity = JSON.parse(cloudOperationCacheIdentity(operation));
    expect(identity.relationRuleRevision).toBe(
      operation === 'layout' ? 'layout-relations-v2-component-role' : undefined,
    );
    delete identity.relationRuleRevision;
    const digest = async (text: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
    const photo = 'same-normalized-photo';
    const parts = [
      ['operation', operation],
      ['photo', 'image/jpeg:' + photo.length + ':' + (await digest(photo))],
    ];
    const key = await digest(
      JSON.stringify({
        cacheVersion: 'cloud-stage-v1',
        operation: JSON.stringify(identity),
        scope: 'actor-A',
        parts,
      }),
    );
    const value = output('saved-before-layout-parser-change');
    const db = await openDB('sjn-reconstruction-cloud-stages', 1, {
      upgrade(database) {
        database.createObjectStore('stages', { keyPath: 'key' }).createIndex('savedAt', 'savedAt');
      },
    });
    await db.put('stages', {
      key,
      savedAt: Date.now(),
      value,
      checksum: await digest(JSON.stringify({ key, value })),
    });
    db.close();
    const http = fetchMock(async () => Response.json(output('fresh-layout-parser-result')));
    const first = await (await call(form(photo, operation))).json();
    expect(first.marker).toBe(
      operation === 'layout' ? 'fresh-layout-parser-result' : 'saved-before-layout-parser-change',
    );
    expect(first.measurement.cacheHit).toBe(operation !== 'layout');
    const second = await (await call(form(photo, operation))).json();
    expect(second.marker).toBe(first.marker);
    expect(second.measurement.cacheHit).toBe(true);
    expect(http.posts).toBe(operation === 'layout' ? 1 : 0);
    const stored = await openDB('sjn-reconstruction-cloud-stages', 1);
    expect((await stored.get('stages', key)).value.marker).toBe('saved-before-layout-parser-change');
    stored.close();
  },
);
