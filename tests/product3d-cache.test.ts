import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProduct3dModel } from '../src/lib/product3d/model-cache';
vi.mock('../src/lib/product3d/model', () => ({
  PRODUCT3D_FILES: { encoder: { bytes: 4 } },
  PRODUCT3D_MODEL_CACHE: 'multiview-test-cache',
  PRODUCT3D_PART_LABELS: { encoder: 'encoder' },
  product3dModelUrl: () => 'https://example.test/pinned/encoder.onnx',
}));
const url = 'https://example.test/pinned/encoder.onnx';
let cache: {
  match: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  cache = {
    match: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    put: vi.fn().mockResolvedValue(undefined),
  };
  fetcher = vi.fn().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3, 4])));
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());
describe('multiview immutable model cache', () => {
  it('reuses the same valid weight file without a network request', async () => {
    cache.match.mockResolvedValue(new Response(new Uint8Array([4, 3, 2, 1])));
    const result = await loadProduct3dModel('encoder', vi.fn());
    expect(result.cacheSource).toBe('cache');
    expect(result.downloadMs).toBe(0);
    expect([...result.bytes]).toEqual([4, 3, 2, 1]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });
  it('removes only the incomplete entry and caches a complete download', async () => {
    cache.match.mockResolvedValue(new Response(new Uint8Array([1])));
    const result = await loadProduct3dModel('encoder', vi.fn());
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(url);
    expect(fetcher).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' }),
    );
    expect(result.cacheSource).toBe('network');
    expect(cache.put).toHaveBeenCalledOnce();
    expect([...new Uint8Array(await cache.put.mock.calls[0][1].arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });
  it('does not store truncated model files', async () => {
    fetcher.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    await expect(loadProduct3dModel('encoder', vi.fn())).rejects.toThrow();
    expect(cache.put).not.toHaveBeenCalled();
  });
  it('preserves a usable inference buffer when cache storage is full', async () => {
    cache.put.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    const result = await loadProduct3dModel('encoder', vi.fn());
    expect([...result.bytes]).toEqual([1, 2, 3, 4]);
    expect(result.cacheNotice).toBeTruthy();
    expect(cache.delete).not.toHaveBeenCalled();
  });
});
