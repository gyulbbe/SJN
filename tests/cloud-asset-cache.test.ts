import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { cacheCloudAsset, readCachedCloudAsset, invalidateCachedCloudAsset } from '../src/lib/storage/cloud-asset-cache';
import type { ImageAssetRecord } from '../src/lib/types';
describe('private cloud asset read cache', () => {
  it('separates the same ID across account/backend and preserves actual Blob bytes', async () => {
    const asset = { id: 'same', kind: 'original', mime: 'image/png', blob: new Blob(['original']) } as ImageAssetRecord;
    await cacheCloudAsset('d1/user-a', asset);
    expect(await readCachedCloudAsset('d1/user-b', 'same')).toBeUndefined();
    expect(await readCachedCloudAsset('supabase/user-a', 'same')).toBeUndefined();
    expect(await (await readCachedCloudAsset('d1/user-a', 'same'))?.blob.text()).toBe('original');
    await invalidateCachedCloudAsset('d1/user-a', 'same');
    expect(await readCachedCloudAsset('d1/user-a', 'same')).toBeUndefined();
  });
});
