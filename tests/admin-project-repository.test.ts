import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminProjectRepositories, loadAdminProject } from '../src/lib/admin/project-repository';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type AssetRecord } from '../src/lib/types';
const id = '573e268a-71d6-4b4d-90a7-5ed4ecb462ad',
  actor = 'admin-test',
  owner = 'member-test';
const assetId = 'f9b3f248-8159-41d8-ae34-647d2925435d';
const document = normalizeProjectDocument({
  id,
  ownerId: owner,
  name: '회원 프로젝트',
  schemaVersion: 2,
  storageRevision: 1,
  editRevision: 0,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  history: { past: [], future: [] },
  scene: {
    originalAssetId: assetId,
    previewAssetId: assetId,
    imageWidth: 8,
    imageHeight: 8,
    room: { ...DEFAULT_ROOM },
    surfaces: createRoomSurfaces(DEFAULT_ROOM),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  },
});
afterEach(() => vi.unstubAllGlobals());
describe('admin project adapter has no persistent or offline fallback', () => {
  it('uses separate routes, verified actor header and owner details without impersonation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ document, owner: { id: owner, name: '회원', email: 'member@example.test' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await loadAdminProject(id, actor);
    expect(result.owner.id).toBe(owner);
    expect(result.document.ownerId).toBe(owner);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/admin/projects');
    expect(init.headers['X-SJN-User-Id']).toBe(actor);
    expect(JSON.parse(init.body)).toEqual({ operation: 'load', id });
    expect(init.cache).toBe('no-store');
  });
  it('rejects destructive/unscoped operations before any network request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const repository = createAdminProjectRepositories(id, actor);
    await expect(repository.projects.create(document)).rejects.toThrow();
    await expect(repository.projects.duplicate(id)).rejects.toThrow();
    await expect(repository.projects.remove(id)).rejects.toThrow();
    await expect(repository.projects.list()).rejects.toThrow();
    await expect(repository.projects.load(assetId)).rejects.toThrow();
    await expect(repository.projects.save({ ...document, id: assetId }, 1)).rejects.toThrow();
    await expect(repository.materials.setActive(assetId, false)).rejects.toThrow();
    expect(await repository.assets.removeUnused()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reuses an uncertain save key, preserving actor identity and original document owner', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(Response.json({ ...document, storageRevision: 2 }));
    vi.stubGlobal('fetch', fetcher);
    const repository = createAdminProjectRepositories(id, actor);
    await expect(repository.projects.save(document, 1)).rejects.toThrow('network lost');
    const saved = await repository.projects.save(document, 1);
    expect(saved.ownerId).toBe(owner);
    const first = fetcher.mock.calls[0][1],
      second = fetcher.mock.calls[1][1];
    expect(first.headers['X-Idempotency-Key']).toBe(second.headers['X-Idempotency-Key']);
    expect(JSON.parse(second.body)).toMatchObject({
      id,
      document: { ownerId: owner },
      expectedStorageRevision: 1,
    });
  });
  it('does not return a retained version on later permission loss or offline failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: assetId }))
      .mockResolvedValueOnce(Response.json({ error: '권한 회수' }, { status: 403 }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const repository = createAdminProjectRepositories(id, actor);
    expect(await repository.materials.getVersion(assetId)).toEqual({ id: assetId });
    await expect(repository.materials.getVersion(assetId)).rejects.toThrow('권한 회수');
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'sjn-admin-role-changed' }));
    await expect(repository.materials.getVersion(assetId)).rejects.toThrow('offline');
  });
  it('fetches asset bytes through the scoped route and never falls back to previously read bytes', async () => {
    const url = `/api/admin/project-assets?projectId=${id}&id=${assetId}&raw=1`;
    const metadata = {
      id: assetId,
      ownerId: owner,
      kind: 'product',
      name: 'sample.png',
      mime: 'image/png',
      size: 3,
      width: 1,
      height: 1,
      createdAt: '2026-09-17T00:00:00.000Z',
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ asset: metadata, url }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const repository = createAdminProjectRepositories(id, actor);
    const asset: AssetRecord = await repository.assets.get(assetId);
    expect(asset.ownerId).toBe(owner);
    expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher.mock.calls[1][1].headers['X-SJN-User-Id']).toBe(actor);
    await expect(repository.assets.get(assetId)).rejects.toThrow('offline');
  });
});
