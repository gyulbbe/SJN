import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getCachedBackgroundModels,
  loadBackgroundModel,
  removeBackgroundGpuModel,
} from '../src/lib/background-removal/model-cache';
import { BACKGROUND_MODEL_CACHE, backgroundModelUrl } from '../src/lib/background-removal/model';

// Exercise byte validation with small real response bodies, not 290 MB of synthetic weights.
vi.mock('../src/lib/background-removal/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/background-removal/model')>();
  return {
    ...original,
    BACKGROUND_MODEL_FILES: {
      fp16: { file: 'model_fp16.onnx', bytes: 4 },
      fp32: { file: 'model.onnx', bytes: 6 },
    },
  };
});

function installCache(entries: Partial<Record<'fp16' | 'fp32', number[]>> = {}) {
  const stored = new Map<string, Response>();
  for (const [precision, bytes] of Object.entries(entries))
    stored.set(backgroundModelUrl(precision as 'fp16' | 'fp32'), new Response(new Uint8Array(bytes)));
  const cache = {
    match: vi.fn(async (url: string) => stored.get(url)?.clone()),
    delete: vi.fn(async (url: string) => stored.delete(url)),
    put: vi.fn(async (url: string, response: Response) => {
      stored.set(url, response.clone());
    }),
  };
  const open = vi.fn(async () => cache);
  const fetch = vi.fn();
  vi.stubGlobal('caches', { open });
  vi.stubGlobal('fetch', fetch);
  return { stored, cache, open, fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('background-removal model cache selection', () => {
  it('reports both valid models using actual Blob size and no model-sized ArrayBuffer allocation', async () => {
    const { open, cache, fetch } = installCache({ fp16: [1, 2, 3, 4], fp32: [1, 2, 3, 4, 5, 6] });
    const responseArrayBuffer = vi.spyOn(Response.prototype, 'arrayBuffer');
    const blobArrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer');
    expect(await getCachedBackgroundModels()).toEqual({ fp16: true, fp32: true });
    expect(open).toHaveBeenCalledExactlyOnceWith(BACKGROUND_MODEL_CACHE);
    expect(responseArrayBuffer).not.toHaveBeenCalled();
    expect(blobArrayBuffer).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { entries: { fp16: [1, 2, 3, 4] }, expected: { fp16: true, fp32: false } },
    { entries: { fp32: [1, 2, 3, 4, 5, 6] }, expected: { fp16: false, fp32: true } },
    { entries: {}, expected: { fp16: false, fp32: false } },
  ])('reports exactly the models present: $expected', async ({ entries, expected }) => {
    installCache(entries);
    expect(await getCachedBackgroundModels()).toEqual(expected);
  });

  it('rejects and removes a truncated GPU model despite a matching Content-Length header', async () => {
    const { stored, cache } = installCache({ fp32: [1, 2, 3, 4, 5, 6] });
    stored.set(
      backgroundModelUrl('fp16'),
      new Response(new Uint8Array([1, 2]), { headers: { 'Content-Length': '4' } }),
    );
    expect(await getCachedBackgroundModels()).toEqual({ fp16: false, fp32: true });
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(backgroundModelUrl('fp16'));
    expect(stored.has(backgroundModelUrl('fp32'))).toBe(true);
  });

  it('removes an oversized or failed-response cache entry instead of treating it as usable', async () => {
    const { stored, cache } = installCache({ fp16: [1, 2, 3, 4, 5] });
    stored.set(backgroundModelUrl('fp32'), new Response(new Uint8Array(6), { status: 503 }));
    expect(await getCachedBackgroundModels()).toEqual({ fp16: false, fp32: false });
    expect(cache.delete).toHaveBeenCalledWith(backgroundModelUrl('fp16'));
    expect(cache.delete).toHaveBeenCalledWith(backgroundModelUrl('fp32'));
  });

  it('keeps an invalid GPU cache unusable even if its deletion fails and still finds the CPU model', async () => {
    const { cache } = installCache({ fp16: [1], fp32: [1, 2, 3, 4, 5, 6] });
    cache.delete.mockRejectedValue(new DOMException('denied', 'SecurityError'));
    expect(await getCachedBackgroundModels()).toEqual({ fp16: false, fp32: true });
  });

  it('checks the other model when one cache lookup fails', async () => {
    const { stored, cache } = installCache({ fp32: [1, 2, 3, 4, 5, 6] });
    cache.match.mockImplementation(async (url) => {
      if (url === backgroundModelUrl('fp16')) throw new Error('cache read failed');
      return stored.get(url)?.clone();
    });
    expect(await getCachedBackgroundModels()).toEqual({ fp16: false, fp32: true });
  });

  it('safely reports no cache when the API is unavailable or cannot be opened', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await getCachedBackgroundModels()).toEqual({ fp16: false, fp32: false });
    expect(await removeBackgroundGpuModel()).toBe(false);
    vi.stubGlobal('caches', { open: vi.fn().mockRejectedValue(new Error('storage denied')) });
    expect(await getCachedBackgroundModels()).toEqual({ fp16: false, fp32: false });
    expect(await removeBackgroundGpuModel()).toBe(false);
  });
});

describe('GPU cache removal after CPU success', () => {
  it('removes only the current FP16 URL while preserving FP32 and unrelated model versions', async () => {
    const { stored, cache, open } = installCache({ fp16: [1, 2, 3, 4], fp32: [1, 2, 3, 4, 5, 6] });
    const previousVersion =
      'https://huggingface.co/studioludens/birefnet-lite-512/resolve/previous/onnx/model_fp16.onnx';
    const otherModel = 'https://example.test/another-app/model.onnx';
    stored.set(previousVersion, new Response('previous model'));
    stored.set(otherModel, new Response('another model'));
    expect(await removeBackgroundGpuModel()).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(BACKGROUND_MODEL_CACHE);
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(backgroundModelUrl('fp16'));
    expect(stored.has(backgroundModelUrl('fp16'))).toBe(false);
    expect(stored.has(backgroundModelUrl('fp32'))).toBe(true);
    expect(stored.has(previousVersion)).toBe(true);
    expect(stored.has(otherModel)).toBe(true);
    expect(await getCachedBackgroundModels()).toEqual({ fp16: false, fp32: true });
  });

  it('returns false for an absent GPU entry and leaves CPU cache untouched', async () => {
    const { stored } = installCache({ fp32: [1, 2, 3, 4, 5, 6] });
    expect(await removeBackgroundGpuModel()).toBe(false);
    expect(stored.has(backgroundModelUrl('fp32'))).toBe(true);
  });

  it('returns false for a deletion error without deleting the CPU entry or cache namespace', async () => {
    const { stored, cache } = installCache({ fp16: [1, 2, 3, 4], fp32: [1, 2, 3, 4, 5, 6] });
    cache.delete.mockRejectedValue(new Error('delete denied'));
    expect(await removeBackgroundGpuModel()).toBe(false);
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(backgroundModelUrl('fp16'));
    expect(stored.has(backgroundModelUrl('fp32'))).toBe(true);
    expect(stored.has(backgroundModelUrl('fp16'))).toBe(true);
  });
});

describe('validated cached model loading', () => {
  it.each([
    { precision: 'fp16' as const, bytes: [1, 2, 3, 4] },
    { precision: 'fp32' as const, bytes: [1, 2, 3, 4, 5, 6] },
  ])('reuses valid $precision bytes without fetching', async ({ precision, bytes }) => {
    const { fetch } = installCache({ [precision]: bytes });
    expect((await getCachedBackgroundModels())[precision]).toBe(true);
    const result = await loadBackgroundModel(precision, vi.fn());
    expect([...result.bytes]).toEqual(bytes);
    expect(result.cacheSource).toBe('cache');
    expect(result.downloadMs).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replaces incomplete cache with a complete download while preserving CPU bytes', async () => {
    const { stored, cache, fetch } = installCache({ fp16: [1, 2], fp32: [1, 2, 3, 4, 5, 6] });
    fetch.mockResolvedValue(new Response(new Uint8Array([9, 8, 7, 6])));
    const result = await loadBackgroundModel('fp16', vi.fn());
    expect([...result.bytes]).toEqual([9, 8, 7, 6]);
    expect(result.cacheSource).toBe('network');
    expect(fetch).toHaveBeenCalledWith(
      backgroundModelUrl('fp16'),
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(backgroundModelUrl('fp16'));
    expect(cache.put).toHaveBeenCalledOnce();
    expect(await getCachedBackgroundModels()).toEqual({ fp16: true, fp32: true });
    expect([...new Uint8Array(await stored.get(backgroundModelUrl('fp32'))!.clone().arrayBuffer())]).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('retains the downloaded result when cache writing fails', async () => {
    const { cache, fetch } = installCache();
    fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    cache.put.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    const progress = vi.fn();
    const result = await loadBackgroundModel('fp16', progress);
    expect([...result.bytes]).toEqual([1, 2, 3, 4]);
    expect(result.cacheSource).toBe('network');
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('캐시 저장 공간') }),
    );
  });
});
