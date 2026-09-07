import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';

/** Disposable browser-only images. Never stored in the project asset repository or uploaded. */
export const DESIGN_RENDER_REVISION = 1;
export const DESIGN_PREVIEW_EVENT = 'gongganmiri-design-preview';
export type DesignPreviewIdentity = {
  projectId: string;
  designId: string;
  revision: number;
  sharedRevision: number;
};
export type DesignPreviewCacheRecord = DesignPreviewIdentity & {
  key: string;
  purpose: 'thumbnail' | 'comparison';
  rendererRevision: number;
  width: number;
  height: number;
  blob: Blob;
  updatedAt: number;
};
interface PreviewDatabase extends DBSchema {
  previews: { key: string; value: DesignPreviewCacheRecord; indexes: { projectId: string } };
}
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 100;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
let database: Promise<IDBPDatabase<PreviewDatabase>> | undefined;
function db() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('미리보기 캐시를 사용할 수 없어요.'));
  if (!database) {
    database = openDB<PreviewDatabase>('gongganmiri-design-previews-v1', 1, {
      upgrade(database) {
        database.createObjectStore('previews', { keyPath: 'key' }).createIndex('projectId', 'projectId');
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
const sameIdentity = (a: DesignPreviewIdentity, b: DesignPreviewIdentity) =>
  a.projectId === b.projectId &&
  a.designId === b.designId &&
  a.revision === b.revision &&
  a.sharedRevision === b.sharedRevision;

export async function readDesignPreviewCache(key: string): Promise<DesignPreviewCacheRecord | undefined> {
  try {
    const record = await (await db()).get('previews', key);
    return record &&
      record.rendererRevision === DESIGN_RENDER_REVISION &&
      Date.now() - record.updatedAt <= MAX_AGE
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}
export async function writeDesignPreviewCache(record: DesignPreviewCacheRecord): Promise<void> {
  if (!record.blob.size || record.blob.size > MAX_BYTES) return;
  let transaction: IDBPTransaction<PreviewDatabase, ['previews'], 'readwrite'> | undefined;
  try {
    const database = await db();
    transaction = database.transaction('previews', 'readwrite');
    void transaction.done.catch(() => {});
    const records = await transaction.store.getAll();
    const retained = records
      .filter((previous) => {
        const superseded =
          previous.projectId === record.projectId &&
          previous.designId === record.designId &&
          previous.purpose === record.purpose &&
          previous.key !== record.key &&
          (previous.revision < record.revision ||
            previous.sharedRevision < record.sharedRevision ||
            (sameIdentity(previous, record) &&
              previous.width === record.width &&
              previous.height === record.height));
        return (
          previous.key !== record.key &&
          !superseded &&
          Date.now() - previous.updatedAt <= MAX_AGE &&
          previous.rendererRevision === DESIGN_RENDER_REVISION
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    let total = record.blob.size;
    const keep = new Set<string>([record.key]);
    for (const entry of retained) {
      if (keep.size >= MAX_RECORDS || total + entry.blob.size > MAX_BYTES) continue;
      keep.add(entry.key);
      total += entry.blob.size;
    }
    for (const previous of records) if (!keep.has(previous.key)) await transaction.store.delete(previous.key);
    await transaction.store.put(record);
    await transaction.done;
    if (typeof window !== 'undefined')
      window.dispatchEvent(new CustomEvent(DESIGN_PREVIEW_EVENT, { detail: record.projectId }));
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(DESIGN_PREVIEW_EVENT);
      channel.postMessage(record.projectId);
      channel.close();
    }
  } catch {
    if (transaction) {
      try {
        transaction.abort();
      } catch {
        /* The failed request may already have aborted it. */
      }
      await transaction.done.catch(() => {});
    }
    // Quota/private-mode/cache failures never change the document's successful save status.
  }
}
export async function getCachedDesignThumbnail(identity: DesignPreviewIdentity): Promise<Blob | undefined> {
  try {
    const records = await (await db()).getAllFromIndex('previews', 'projectId', identity.projectId);
    return records
      .filter(
        (record) =>
          sameIdentity(record, identity) &&
          record.purpose === 'thumbnail' &&
          record.rendererRevision === DESIGN_RENDER_REVISION &&
          Date.now() - record.updatedAt <= MAX_AGE,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.blob;
  } catch {
    return undefined;
  }
}
export async function deleteDesignPreviewCache(projectId: string, designId?: string): Promise<void> {
  try {
    const database = await db(),
      transaction = database.transaction('previews', 'readwrite');
    const records = await transaction.store.index('projectId').getAll(projectId);
    for (const record of records)
      if (!designId || record.designId === designId) await transaction.store.delete(record.key);
    await transaction.done;
    if (typeof window !== 'undefined')
      window.dispatchEvent(new CustomEvent(DESIGN_PREVIEW_EVENT, { detail: projectId }));
  } catch {
    /* Derived cache cleanup is safe to retry or expire. */
  }
}
