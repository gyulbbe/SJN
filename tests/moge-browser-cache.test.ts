import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => new Uint8Array([9, 5, 3, 1]));
vi.mock('../src/lib/reconstruction/moge-browser/artifact', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/reconstruction/moge-browser/artifact')>(
    '../src/lib/reconstruction/moge-browser/artifact',
  );
  const { createHash } = await import('node:crypto');
  return {
    ...actual,
    MOGE_ARTIFACT: {
      ...actual.MOGE_ARTIFACT,
      bytes: fixture.length,
      sha256: createHash('sha256').update(fixture).digest('hex'),
    },
  };
});
import {
  loadMogeModel,
  MogeIntegrityError,
  verifyMogeModel,
} from '../src/lib/reconstruction/moge-browser/model-cache';

let stored: Response | undefined;
let put: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
const url = 'https://example.com/model.onnx';
beforeEach(() => {
  stored = undefined;
  put = vi.fn(async (_url, response) => {
    stored = response.clone();
  });
  remove = vi.fn(async () => {
    stored = undefined;
    return true;
  });
  vi.stubGlobal('caches', {
    open: vi.fn(async () => ({ match: vi.fn(async () => stored?.clone()), put, delete: remove })),
  });
  vi.stubGlobal('navigator', { storage: { estimate: vi.fn(async () => ({ quota: 1000, usage: 0 })) } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(fixture, { headers: { 'Content-Length': '4' } })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MoGe persistent cache with tiny test artifact (no actual model)', () => {
  it('verifies content, saves once, and reuses the same bytes without fetching', async () => {
    const first = await loadMogeModel(url, vi.fn()),
      second = await loadMogeModel(url, vi.fn());
    expect(first.cacheSource).toBe('network');
    expect(second.cacheSource).toBe('cache');
    expect(first.bytes).toEqual(fixture);
    expect(second.bytes).toEqual(fixture);
    expect(fetch).toHaveBeenCalledTimes(1);
    // The production origin is on workers.dev, whose Referer Hugging Face rejects without CORS.
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(createHash('sha256').update(second.bytes).digest('hex')).toHaveLength(64);
  });
  it('rejects same-length corrupted content and repairs a corrupt cache with one download', async () => {
    await expect(verifyMogeModel(new Uint8Array([9, 5, 3, 2]))).rejects.toBeInstanceOf(MogeIntegrityError);
    stored = new Response(new Uint8Array([9, 5, 3, 2]));
    const result = await loadMogeModel(url, vi.fn());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.bytes).toEqual(fixture);
    expect(result.cacheNotice).toContain('손상');
  });
  it('returns verified bytes when quota prevents storing them', async () => {
    put.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    const result = await loadMogeModel(url, vi.fn());
    expect(result.bytes).toEqual(fixture);
    expect(result.cacheNotice).toContain('저장 공간');
  });
  it('propagates cancellation before any cache or network work', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadMogeModel(url, vi.fn(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds the stream and rejects wrong network artifacts without storing them', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array(5)));
    await expect(loadMogeModel(url, vi.fn())).rejects.toBeInstanceOf(MogeIntegrityError);
    expect(put).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails a HTTP error once without hidden download retries', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(loadMogeModel(url, vi.fn())).rejects.toMatchObject({ code: 'download' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
