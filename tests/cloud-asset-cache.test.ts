import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  cacheCloudAsset,
  readCachedCloudAsset,
  invalidateCachedCloudAsset,
  cloudAssetContentHash,
  CLOUD_ASSET_CACHE_LIMITS,
  expiredCloudAssetEntries,
} from '../src/lib/storage/cloud-asset-cache';
import type { ImageAssetRecord } from '../src/lib/types';
const namespace = 'https://sjn.test/d1/user-a';
function asset(id = crypto.randomUUID(), bytes = 'original'): ImageAssetRecord {
  const blob = new Blob([bytes], { type: 'image/png' });
  return {
    id,
    kind: 'original',
    name: 'test.png',
    mime: blob.type,
    blob,
    size: blob.size,
    width: 10,
    height: 10,
    ownerId: 'user-a',
    createdAt: '2026-09-17T00:00:00.000Z',
  };
}
async function read(value: ImageAssetRecord, account = namespace) {
  return readCachedCloudAsset(account, value, await cloudAssetContentHash(value.blob));
}
beforeEach(async () => {
  await cacheCloudAsset(namespace, asset());
  const database = await openDB('gongganmiri-cloud-assets-v1', 2);
  await database.clear('assets');
  await database.clear('entries');
  database.close();
});
afterEach(() => vi.restoreAllMocks());
describe('bounded authorized cloud asset cache', () => {
  it('isolates accounts and origins and preserves actual Blob bytes', async () => {
    const value = asset('same');
    await cacheCloudAsset(namespace, value);
    expect(await read(value, 'https://sjn.test/d1/user-b')).toBeUndefined();
    expect(await read(value, 'https://other.test/d1/user-a')).toBeUndefined();
    expect(await (await read(value))?.blob.text()).toBe('original');
    await invalidateCachedCloudAsset(namespace, value.id);
    expect(await read(value)).toBeUndefined();
  });
  it('uses freshly authorized server metadata and rejects a changed server hash', async () => {
    const value = asset();
    await cacheCloudAsset(namespace, value);
    const server = { ...value, ownerId: 'normalized-owner', createdAt: 'new-server-stamp' };
    expect(await read(server)).toMatchObject({ ownerId: 'normalized-owner', createdAt: 'new-server-stamp' });
    expect(await readCachedCloudAsset(namespace, server, '0'.repeat(64))).toBeUndefined();
    expect(await read(value)).toBeUndefined();
  });
  it('deletes corrupted same-length cached bytes without serving them', async () => {
    const value = asset();
    await cacheCloudAsset(namespace, value);
    const database = await openDB('gongganmiri-cloud-assets-v1', 2),
      key = JSON.stringify([namespace, value.id]);
    const record = await database.get('assets', key);
    record.asset.blob = new Blob(['corrupt!'], { type: 'image/png' });
    await database.put('assets', record);
    expect(await read(value)).toBeUndefined();
    expect(await database.get('assets', key)).toBeUndefined();
    database.close();
  });
  it('expires even recently used bytes after seven days instead of extending TTL forever', async () => {
    const start = Date.now(),
      clock = vi.spyOn(Date, 'now').mockReturnValue(start),
      value = asset();
    await cacheCloudAsset(namespace, value);
    clock.mockReturnValue(start + CLOUD_ASSET_CACHE_LIMITS.ttlMs - 1);
    expect(await read(value)).toBeDefined();
    clock.mockReturnValue(start + CLOUD_ASSET_CACHE_LIMITS.ttlMs);
    expect(await read(value)).toBeUndefined();
  });
  it('bounds total entries across all accounts and preserves recently read entries', async () => {
    const start = Date.now(),
      clock = vi.spyOn(Date, 'now').mockReturnValue(start),
      values = [];
    for (let index = 0; index < CLOUD_ASSET_CACHE_LIMITS.maxEntries; index++) {
      clock.mockReturnValue(start + index);
      const value = asset(`asset-${index}`);
      values.push(value);
      await cacheCloudAsset(namespace, value);
    }
    clock.mockReturnValue(start + 200);
    expect(await read(values[0])).toBeDefined();
    clock.mockReturnValue(start + 201);
    await cacheCloudAsset('other-account', asset('extra'));
    expect(await read(values[0])).toBeDefined();
    expect(await read(values[1])).toBeUndefined();
    const database = await openDB('gongganmiri-cloud-assets-v1', 2);
    expect(await database.count('assets')).toBe(CLOUD_ASSET_CACHE_LIMITS.maxEntries);
    database.close();
  });
  it('bounds bytes separately from entry count and excludes invalid/future metadata', () => {
    const now = Date.now(),
      entries = Array.from({ length: 9 }, (_, index) => ({
        key: String(index),
        size: CLOUD_ASSET_CACHE_LIMITS.maxAssetBytes,
        storedAt: now - 100,
        accessedAt: now - index,
      }));
    const removed = expiredCloudAssetEntries(entries, now);
    expect([...removed]).toEqual(['8']);
    expect(
      entries.filter((entry) => !removed.has(entry.key)).reduce((sum, entry) => sum + entry.size, 0),
    ).toBe(CLOUD_ASSET_CACHE_LIMITS.maxBytes);
    expect(
      expiredCloudAssetEntries(
        [
          { ...entries[0], accessedAt: Infinity },
          { ...entries[1], storedAt: now + 1 },
          { ...entries[2], size: 0 },
        ],
        now,
      ),
    ).toEqual(new Set(['0', '1', '2']));
  });
  it('does not cache wrong sizes, empty blobs or content that disagrees with the server', async () => {
    const value = asset();
    await cacheCloudAsset(namespace, { ...value, size: 1 });
    expect(await read(value)).toBeUndefined();
    await cacheCloudAsset(namespace, value, '0'.repeat(64));
    expect(await read(value)).toBeUndefined();
    await cacheCloudAsset(namespace, asset('empty', ''));
    expect(await read(asset('empty', ''))).toBeUndefined();
  });
  it('handles a browser-aborted write transaction without an unhandled rejection', async () => {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = original.apply(this, args);
      this.transaction.abort();
      return request;
    });
    await expect(cacheCloudAsset(namespace, asset())).resolves.toBeUndefined();
  });
  it('keeps cache write failures optional without losing a server-confirmed result', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await expect(cacheCloudAsset(namespace, asset())).resolves.toBeUndefined();
  });
});
