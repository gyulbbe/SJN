import { openDB, type DBSchema } from 'idb';
import type { AssetRecord } from '../types';
type CacheRecord = { key: string; asset: AssetRecord; accessedAt: number };
interface CacheSchema extends DBSchema {
  assets: { key: string; value: CacheRecord };
}
let database: ReturnType<typeof openDB<CacheSchema>> | undefined;
function db() {
  return (database ??= openDB<CacheSchema>('gongganmiri-cloud-assets-v1', 1, {
    upgrade(database) {
      database.createObjectStore('assets', { keyPath: 'key' });
    },
  }));
}
function key(namespace: string, id: string) {
  return JSON.stringify([namespace, id]);
}
export async function cacheCloudAsset(namespace: string, asset: AssetRecord) {
  try {
    await (await db()).put('assets', { key: key(namespace, asset.id), asset, accessedAt: Date.now() });
  } catch {
    /* Optional read cache: a confirmed cloud write remains confirmed. */
  }
}
export async function readCachedCloudAsset(namespace: string, id: string) {
  try {
    return (await (await db()).get('assets', key(namespace, id)))?.asset;
  } catch {
    return undefined;
  }
}
export async function invalidateCachedCloudAsset(namespace: string, id: string) {
  try {
    await (await db()).delete('assets', key(namespace, id));
  } catch {
    /* Best effort read-cache cleanup. */
  }
}
