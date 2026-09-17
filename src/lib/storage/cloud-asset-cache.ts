import { openDB, type DBSchema, type IDBPTransaction } from 'idb';
import type { AssetRecord, ImageAssetRecord, ProductMeshAssetRecord } from '../types';

export type CloudAssetMetadata = Omit<ImageAssetRecord, 'blob'> | Omit<ProductMeshAssetRecord, 'blob'>;
export const CLOUD_ASSET_CACHE_LIMITS = {
  maxEntries: 100,
  maxBytes: 200 * 1024 * 1024,
  maxAssetBytes: 25 * 1024 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
} as const;
type CacheRecord = {
  key: string;
  asset: AssetRecord;
  contentHash?: string;
  storedAt?: number;
  accessedAt: number;
};
type CacheEntry = { key: string; size: number; storedAt: number; accessedAt: number };
interface CacheSchema extends DBSchema {
  assets: { key: string; value: CacheRecord };
  entries: { key: string; value: CacheEntry };
}
type CacheTransaction = IDBPTransaction<CacheSchema, ['assets', 'entries'], 'readwrite'>;
let database: ReturnType<typeof openDB<CacheSchema>> | undefined;
function db() {
  if (!database) {
    database = openDB<CacheSchema>('gongganmiri-cloud-assets-v1', 2, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) database.createObjectStore('assets', { keyPath: 'key' });
        if (oldVersion < 2) {
          const entries = database.createObjectStore('entries', { keyPath: 'key' });
          // Preserve the old optional cache and index its sizes without touching legacy workspace databases.
          void (async () => {
            let cursor = await transaction.objectStore('assets').openCursor();
            while (cursor) {
              const value = cursor.value;
              await entries.put({
                key: cursor.key,
                size: value.asset?.blob?.size ?? 0,
                storedAt: value.storedAt ?? value.accessedAt,
                accessedAt: value.accessedAt,
              });
              cursor = await cursor.continue();
            }
          })().catch(() => transaction.abort());
        }
      },
      blocking() {
        void database?.then((connection) => connection.close());
        database = undefined;
      },
      terminated() {
        database = undefined;
      },
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}
function key(namespace: string, id: string) {
  return JSON.stringify([namespace, id]);
}
function validHash(hash: string) {
  return /^[a-f0-9]{64}$/.test(hash);
}
export async function cloudAssetContentHash(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function expiredCloudAssetEntries(entries: CacheEntry[], now: number): Set<string> {
  const removed = new Set<string>();
  const valid = entries
    .filter((entry) => {
      const expired =
        !Number.isFinite(entry.storedAt) ||
        !Number.isFinite(entry.accessedAt) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size <= 0 ||
        entry.size > CLOUD_ASSET_CACHE_LIMITS.maxAssetBytes ||
        entry.storedAt > now ||
        entry.accessedAt > now ||
        now - entry.storedAt >= CLOUD_ASSET_CACHE_LIMITS.ttlMs;
      if (expired) removed.add(entry.key);
      return !expired;
    })
    .sort((a, b) => a.accessedAt - b.accessedAt || a.key.localeCompare(b.key));
  let bytes = valid.reduce((total, entry) => total + entry.size, 0),
    count = valid.length;
  for (const entry of valid) {
    if (bytes <= CLOUD_ASSET_CACHE_LIMITS.maxBytes && count <= CLOUD_ASSET_CACHE_LIMITS.maxEntries) break;
    removed.add(entry.key);
    bytes -= entry.size;
    count--;
  }
  return removed;
}
async function prune(transaction: CacheTransaction, now: number, incoming?: CacheEntry) {
  const stored = await transaction.objectStore('entries').getAll();
  const entries = incoming ? [...stored.filter((entry) => entry.key !== incoming.key), incoming] : stored;
  const removed = expiredCloudAssetEntries(entries, now);
  for (const entryKey of removed) {
    await transaction.objectStore('assets').delete(entryKey);
    await transaction.objectStore('entries').delete(entryKey);
  }
  return removed;
}
export async function cacheCloudAsset(namespace: string, asset: AssetRecord, expectedHash?: string) {
  try {
    if (
      !namespace ||
      !(asset.blob instanceof Blob) ||
      !asset.blob.size ||
      asset.blob.size !== asset.size ||
      asset.size > CLOUD_ASSET_CACHE_LIMITS.maxAssetBytes
    )
      return;
    const contentHash = await cloudAssetContentHash(asset.blob);
    if (expectedHash !== undefined && (!validHash(expectedHash) || expectedHash !== contentHash)) return;
    const entryKey = key(namespace, asset.id),
      now = Date.now();
    const transaction = (await db()).transaction(['assets', 'entries'], 'readwrite');
    void transaction.done.catch(() => {});
    const entry = { key: entryKey, size: asset.size, storedAt: now, accessedAt: now };
    // Evict before the large write, so a full browser quota can reuse the freed cache space.
    const removed = await prune(transaction, now, entry);
    if (!removed.has(entryKey)) {
      await transaction
        .objectStore('assets')
        .put({ key: entryKey, asset, contentHash, storedAt: now, accessedAt: now });
      await transaction.objectStore('entries').put(entry);
    }
    await transaction.done;
  } catch {
    // Optional cache: quota, browser policy or corruption must not invalidate a confirmed server write/read.
  }
}
/** Call only after the server has authorized this exact asset for the current account. */
export async function readCachedCloudAsset(
  namespace: string,
  metadata: CloudAssetMetadata,
  contentHash: string,
) {
  try {
    if (!namespace || !validHash(contentHash)) return undefined;
    const connection = await db(),
      entryKey = key(namespace, metadata.id);
    const transaction = connection.transaction(['assets', 'entries'], 'readwrite');
    void transaction.done.catch(() => {});
    const now = Date.now();
    await prune(transaction, now);
    const stored = await transaction.objectStore('assets').get(entryKey);
    await transaction.done;
    if (!stored) return undefined;
    const blob = stored.asset?.blob;
    if (
      stored.contentHash !== contentHash ||
      !(blob instanceof Blob) ||
      blob.size !== metadata.size ||
      blob.size <= 0 ||
      blob.type !== metadata.mime ||
      (await cloudAssetContentHash(blob)) !== contentHash
    ) {
      await invalidateCachedCloudAsset(namespace, metadata.id);
      return undefined;
    }
    // Use current server metadata; upload timestamps/owners may have been normalized on the server.
    const touch = connection.transaction(['assets', 'entries'], 'readwrite');
    void touch.done.catch(() => {});
    const entry = await touch.objectStore('entries').get(entryKey);
    if (entry) await touch.objectStore('entries').put({ ...entry, accessedAt: now });
    await touch.done;
    return { ...metadata, blob } as AssetRecord;
  } catch {
    return undefined;
  }
}
export async function invalidateCachedCloudAsset(namespace: string, id: string) {
  try {
    const transaction = (await db()).transaction(['assets', 'entries'], 'readwrite');
    void transaction.done.catch(() => {});
    await transaction.objectStore('assets').delete(key(namespace, id));
    await transaction.objectStore('entries').delete(key(namespace, id));
    await transaction.done;
  } catch {
    /* Best effort optional-cache cleanup. */
  }
}
