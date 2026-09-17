import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudRepositories, CloudRequestError } from '../src/lib/repositories/cloud';
import { cloudAssetContentHash } from '../src/lib/storage/cloud-asset-cache';
import type { ImageAssetRecord, MaterialVersion } from '../src/lib/types';
function asset(): ImageAssetRecord {
  const blob = new Blob(['verified R2 bytes'], { type: 'image/png' });
  return {
    id: crypto.randomUUID(),
    ownerId: 'a',
    name: 'photo.png',
    mime: blob.type,
    blob,
    size: blob.size,
    width: 10,
    height: 10,
    kind: 'original',
    createdAt: '2026-09-17T00:00:00.000Z',
  };
}
async function fixture() {
  const value = asset(),
    { blob, ...metadata } = value;
  const contentHash = await cloudAssetContentHash(blob);
  let status = 200,
    offline = false,
    rawStatus = 200,
    rawReads = 0,
    transferredBytes = 0;
  const fetcher = vi.fn(async (input: string, init: RequestInit = {}) => {
    if (offline) throw new TypeError('network offline');
    if (status !== 200) return Response.json({ error: 'denied' }, { status });
    if (init.method === 'POST') return Response.json(null);
    if (!input.endsWith('&raw=1'))
      return Response.json({ asset: metadata, contentHash, url: `/api/d1/assets?id=${value.id}&raw=1` });
    rawReads++;
    if (rawStatus !== 200) return Response.json({ error: 'revoked during download' }, { status: rawStatus });
    transferredBytes += blob.size;
    return new Response(blob, { headers: { 'Content-Type': blob.type } });
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    value,
    fetcher,
    repository: createCloudRepositories('d1', 'a'),
    setStatus: (value: number) => {
      status = value;
    },
    setOffline: () => {
      offline = true;
    },
    setRawStatus: (value: number) => {
      rawStatus = value;
    },
    rawReads: () => rawReads,
    transferredBytes: () => transferredBytes,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('D1-authorized binary cache transport', () => {
  it('checks metadata for every read while transferring R2 bytes only once', async () => {
    const f = await fixture();
    expect(await (await f.repository.assets.get(f.value.id)).blob.text()).toBe('verified R2 bytes');
    expect(await (await f.repository.assets.get(f.value.id)).blob.text()).toBe('verified R2 bytes');
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.rawReads()).toBe(1);
    expect(f.transferredBytes()).toBe(f.value.size);
    expect(f.fetcher.mock.calls.map((call) => call[1]?.cache)).toEqual(['no-store', 'no-store', 'no-store']);
    expect(
      f.fetcher.mock.calls.every(
        (call) => (call[1]?.headers as Record<string, string>)['X-SJN-User-Id'] === 'a',
      ),
    ).toBe(true);
  });
  it('reuses an acknowledged upload only after a fresh authorized metadata request', async () => {
    const f = await fixture();
    await f.repository.assets.put(f.value);
    expect(await f.repository.assets.get(f.value.id)).toMatchObject({ id: f.value.id });
    expect(f.rawReads()).toBe(0);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([400, 401, 403, 404])(
    'rejects metadata status %s and deletes cache before a future reauthorization',
    async (status) => {
      const f = await fixture();
      await f.repository.assets.get(f.value.id);
      f.setStatus(status);
      await expect(f.repository.assets.get(f.value.id)).rejects.toBeInstanceOf(CloudRequestError);
      f.setStatus(200);
      await f.repository.assets.get(f.value.id);
      expect(f.rawReads()).toBe(2);
    },
  );
  it('does not return cached files when the authentication request is offline or server fails', async () => {
    const f = await fixture();
    await f.repository.assets.get(f.value.id);
    f.setStatus(503);
    await expect(f.repository.assets.get(f.value.id)).rejects.toBeInstanceOf(CloudRequestError);
    f.setOffline();
    await expect(f.repository.assets.get(f.value.id)).rejects.toThrow('network offline');
    expect(f.rawReads()).toBe(1);
  });
  it('does not reuse another account cache and does not retain a denied raw download', async () => {
    const f = await fixture();
    await f.repository.assets.get(f.value.id);
    const other = createCloudRepositories('d1', 'b');
    f.setRawStatus(403);
    await expect(other.assets.get(f.value.id)).rejects.toBeInstanceOf(CloudRequestError);
    f.setRawStatus(200);
    await other.assets.get(f.value.id);
    await other.assets.get(f.value.id);
    expect(f.rawReads()).toBe(3);
  });
  it('returns the confirmed download if IndexedDB rejects cache writes', async () => {
    const f = await fixture();
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(await (await f.repository.assets.get(f.value.id)).blob.text()).toBe('verified R2 bytes');
  });
  it('keeps the authoritative server endpoint and does not follow mismatched asset URLs', async () => {
    const f = await fixture();
    f.fetcher.mockResolvedValueOnce(
      Response.json({ asset: f.value, url: 'https://external.invalid/file', contentHash: '0'.repeat(64) }),
    );
    await expect(f.repository.assets.get(f.value.id)).rejects.toThrow('자산 응답 경로');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to retained material versions when the server cannot confirm permission', async () => {
    const version = { id: 'immutable-version' } as MaterialVersion;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(Response.json(version)).mockRejectedValueOnce(new TypeError('offline')),
    );
    const repository = createCloudRepositories('d1', 'a');
    expect(await repository.materials.getVersion(version.id)).toEqual(version);
    await expect(repository.materials.getVersion(version.id)).rejects.toThrow('offline');
  });
  it('uses D1 by default and cannot revive the removed alternative backend at runtime', () => {
    expect(createCloudRepositories().mode).toBe('d1');
    expect(() => createCloudRepositories('supabase' as 'd1')).toThrow('D1');
  });
});
