import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  DESIGN_RENDER_REVISION,
  deleteDesignPreviewCache,
  getCachedDesignThumbnail,
  readDesignPreviewCache,
  writeDesignPreviewCache,
  type DesignPreviewCacheRecord,
} from '../src/lib/render/design-preview-cache';
function record(projectId = crypto.randomUUID(), designId = 'a', revision = 1): DesignPreviewCacheRecord {
  return {
    projectId,
    designId,
    revision,
    sharedRevision: 0,
    key: crypto.randomUUID(),
    purpose: 'thumbnail',
    rendererRevision: DESIGN_RENDER_REVISION,
    width: 360,
    height: 240,
    updatedAt: Date.now(),
    blob: new Blob([`${designId}:${revision}`], { type: 'image/png' }),
  };
}
describe('disposable local design image cache', () => {
  it('evicts the oldest project images when the browser cache reaches its record budget', async () => {
    const projectId = crypto.randomUUID();
    const entries = Array.from({ length: 102 }, (_, index) => ({
      ...record(projectId, String(index)),
      updatedAt: Date.now() + index,
    }));
    for (const entry of entries) await writeDesignPreviewCache(entry);
    expect(await readDesignPreviewCache(entries[0].key)).toBeUndefined();
    expect(await readDesignPreviewCache(entries[1].key)).toBeUndefined();
    expect(await getCachedDesignThumbnail(entries.at(-1)!)).toBeDefined();
    await deleteDesignPreviewCache(projectId);
  });
  it('never shows an older revision, another design, or another shared room revision in a summary', async () => {
    const first = record();
    await writeDesignPreviewCache(first);
    expect(await (await getCachedDesignThumbnail(first))?.text()).toBe('a:1');
    expect(await getCachedDesignThumbnail({ ...first, revision: 2 })).toBeUndefined();
    expect(await getCachedDesignThumbnail({ ...first, sharedRevision: 1 })).toBeUndefined();
    expect(await getCachedDesignThumbnail({ ...first, designId: 'b' })).toBeUndefined();
    const next = { ...first, key: crypto.randomUUID(), revision: 2, blob: new Blob(['new']) };
    await writeDesignPreviewCache(next);
    expect(await readDesignPreviewCache(first.key)).toBeUndefined();
    expect(await (await getCachedDesignThumbnail(next))?.text()).toBe('new');
    await deleteDesignPreviewCache(first.projectId);
  });
  it('preserves other designs and projects when deleting a design cache', async () => {
    const a = record(),
      b = record(a.projectId, 'b'),
      other = record();
    await writeDesignPreviewCache(a);
    await writeDesignPreviewCache(b);
    await writeDesignPreviewCache(other);
    await deleteDesignPreviewCache(a.projectId, a.designId);
    expect(await getCachedDesignThumbnail(a)).toBeUndefined();
    expect(await getCachedDesignThumbnail(b)).toBeDefined();
    expect(await getCachedDesignThumbnail(other)).toBeDefined();
    await deleteDesignPreviewCache(a.projectId);
    await deleteDesignPreviewCache(other.projectId);
  });
  it('treats quota failure as a missing disposable image and preserves the prior successful cache', async () => {
    const first = record();
    await writeDesignPreviewCache(first);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      await expect(
        writeDesignPreviewCache({ ...first, key: crypto.randomUUID(), revision: 2 }),
      ).resolves.toBeUndefined();
    } finally {
      put.mockRestore();
    }
    // A synchronous put failure must abort any earlier cleanup deletes in the same transaction.
    expect(await getCachedDesignThumbnail(first)).toBeDefined();
    await deleteDesignPreviewCache(first.projectId);
  });
  it('expires incompatible renderer versions and week-old entries', async () => {
    const old = record();
    old.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await writeDesignPreviewCache(old);
    expect(await readDesignPreviewCache(old.key)).toBeUndefined();
    const different = record(old.projectId);
    different.rendererRevision--;
    await writeDesignPreviewCache(different);
    expect(await getCachedDesignThumbnail(different)).toBeUndefined();
    await deleteDesignPreviewCache(old.projectId);
  });
});
