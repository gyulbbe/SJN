import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import {
  cacheCloudAsset,
  cloudAssetContentHash,
  readCachedCloudAsset,
} from '../src/lib/storage/cloud-asset-cache';
import type { ImageAssetRecord } from '../src/lib/types';

describe('asset cache upgrade preserves source data', () => {
  it('indexes old optional blobs without deleting the old database and upgrades only verified downloads', async () => {
    const namespace = 'upgrade/account',
      key = JSON.stringify([namespace, 'old']);
    const blob = new Blob(['original bytes'], { type: 'image/png' });
    const oldAsset: ImageAssetRecord = {
      id: 'old',
      kind: 'original',
      ownerId: 'account',
      name: 'old.png',
      mime: blob.type,
      blob,
      size: blob.size,
      width: 10,
      height: 10,
      createdAt: '2026-09-17',
    };
    const legacy = await openDB('gongganmiri-cloud-assets-v1', 1, {
      upgrade(database) {
        database.createObjectStore('assets', { keyPath: 'key' });
      },
    });
    await legacy.put('assets', { key, asset: oldAsset, accessedAt: Date.now() });
    legacy.close();
    const source = await openDB('unchanged-user-workspace', 1, {
      upgrade(database) {
        database.createObjectStore('originals');
      },
    });
    await source.put('originals', blob, 'source-photo');
    const downloaded = { ...oldAsset, id: 'new' };
    await cacheCloudAsset(namespace, downloaded);
    const upgraded = await openDB('gongganmiri-cloud-assets-v1', 2);
    expect(upgraded.objectStoreNames.contains('entries')).toBe(true);
    expect(await (await upgraded.get('assets', key)).asset.blob.text()).toBe('original bytes');
    expect((await upgraded.get('entries', key)).size).toBe(blob.size);
    // Legacy cache has no verified digest: discard this cache entry and let the authorized R2 read repopulate it.
    expect(
      await readCachedCloudAsset(namespace, oldAsset, await cloudAssetContentHash(blob)),
    ).toBeUndefined();
    expect(await upgraded.get('assets', key)).toBeUndefined();
    expect(await (await source.get('originals', 'source-photo')).text()).toBe('original bytes');
    expect(
      await (
        await readCachedCloudAsset(namespace, downloaded, await cloudAssetContentHash(blob))
      )?.blob.text(),
    ).toBe('original bytes');
    source.close();
    upgraded.close();
  });
});
