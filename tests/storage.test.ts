import { getActiveScene } from '../src/lib/comparison';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { StorageConflictError } from '../src/lib/repositories/references';
import {
  DEFAULT_COLOR,
  DEFAULT_TILE,
  EMPTY_MASK,
  type AssetRecord,
  type MaterialInput,
  type LegacyProjectDocument,
  type Surface,
} from '../src/lib/types';

const old = '2000-01-01T00:00:00.000Z';
const image = (id = crypto.randomUUID(), sourceAssetId?: string): AssetRecord => ({
  id,
  ownerId: 'local',
  name: 'image.png',
  mime: 'image/png',
  size: 3,
  width: 32,
  height: 32,
  kind: 'original',
  createdAt: old,
  sourceAssetId,
  blob: new Blob(['png'], { type: 'image/png' }),
});
function project(assetId: string): LegacyProjectDocument {
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '욕실',
    schemaVersion: 1,
    editRevision: 0,
    storageRevision: 0,
    scene: {
      originalAssetId: assetId,
      previewAssetId: assetId,
      imageWidth: 32,
      imageHeight: 32,
      surfaces: [],
      protection: EMPTY_MASK(),
      fixtures: [],
      color: { ...DEFAULT_COLOR },
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: old,
    updatedAt: old,
  };
}
function material(assetId: string): MaterialInput {
  return {
    name: '테스트 타일',
    brand: '',
    code: '',
    category: 'tile',
    scope: 'personal',
    description: '',
    color: 'white',
    finish: 'matte',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    coverAssetId: assetId,
    imageAssetIds: [assetId],
    textureAssetIds: [assetId],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#dddddd',
    defaultPattern: 'grid',
  };
}
const floor = (version: string): Surface => ({
  id: crypto.randomUUID(),
  name: '바닥',
  kind: 'floor',
  mask: EMPTY_MASK(),
  quad: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  widthMm: 3000,
  heightMm: 3000,
  calibrated: false,
  materialVersionId: version,
  tile: { ...DEFAULT_TILE },
  color: { ...DEFAULT_COLOR },
});
const setup = () => createLocalRepositories(`test-${crypto.randomUUID()}`);

describe('transactional local persistence', () => {
  it('commits once under concurrent conditional saves from two connections', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const a = createLocalRepositories(name);
    const b = createLocalRepositories(name);
    const asset = image();
    await a.assets.put(asset);
    const original = await a.projects.create(project(asset.id));
    const results = await Promise.allSettled([
      a.projects.save({ ...original, name: 'A', editRevision: 1 }, 1),
      b.projects.save({ ...original, name: 'B', editRevision: 1 }, 1),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(StorageConflictError);
    const saved = await b.projects.load(original.id);
    expect(saved.storageRevision).toBe(2);
    expect(saved.editRevision).toBe(1);
  });
  it('keeps old material versions and project references when the catalog is edited', async () => {
    const repo = setup();
    const firstImage = image();
    const secondImage = image();
    await repo.assets.put(firstImage);
    await repo.assets.put(secondImage);
    const first = await repo.materials.create(material(firstImage.id));
    const doc = project(firstImage.id);
    doc.scene.surfaces.push(floor(first.id));
    const saved = await repo.projects.create(doc);
    const second = await repo.materials.update(
      first.materialId,
      { ...material(secondImage.id), name: '새 무늬' },
      first.id,
    );
    expect(second.version).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect((await repo.materials.getVersion(first.id)).textureAssetIds[0]).toBe(firstImage.id);
    expect(getActiveScene(await repo.projects.load(saved.id)).surfaces[0].materialVersionId).toBe(first.id);
    await expect(
      repo.materials.update(first.materialId, material(firstImage.id), first.id),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await repo.materials.setActive(first.materialId, false);
    expect((await repo.materials.list())[0].material.active).toBe(false);
    expect(await repo.assets.removeUnused()).toBe(0);
  });
  it('preserves shared assets across clones and history, then collects only unreachable assets', async () => {
    const repo = setup();
    const original = image();
    const edited = image();
    const unreferenced = image();
    await repo.assets.put(original);
    await repo.assets.put(edited);
    await repo.assets.put(unreferenced);
    const doc = project(original.id);
    doc.history.past = [structuredClone(doc.scene)];
    doc.scene.originalAssetId = edited.id;
    doc.scene.previewAssetId = edited.id;
    const saved = await repo.projects.create(doc);
    const clone = await repo.projects.duplicate(saved.id);
    expect(getActiveScene(clone).originalAssetId).toBe(getActiveScene(saved).originalAssetId);
    await repo.projects.remove(saved.id);
    expect(await repo.assets.removeUnused()).toBe(1);
    expect(await repo.assets.get(original.id)).toMatchObject({ id: original.id });
    expect(await repo.assets.get(edited.id)).toMatchObject({ id: edited.id });
    await repo.projects.remove(clone.id);
    expect(await repo.assets.removeUnused()).toBe(2);
    await expect(repo.assets.get(original.id)).rejects.toThrow('이미지');
  });
  it('does not collect staged images or source ancestors before the 24-hour grace period', async () => {
    const repo = setup();
    const original = image();
    const preview = { ...image(undefined, original.id), createdAt: new Date().toISOString() };
    await repo.assets.put(original);
    await repo.assets.put(preview);
    expect(await repo.assets.removeUnused()).toBe(0);
    expect((await repo.assets.get(original.id)).blob.size).toBe(3);
  });
  it('rolls back invalid references and quota failures without replacing the last saved document', async () => {
    const repo = setup();
    const asset = image();
    await repo.assets.put(asset);
    const saved = await repo.projects.create(project(asset.id));
    const missing = structuredClone(saved);
    getActiveScene(missing).backgroundAssetId = crypto.randomUUID();
    await expect(repo.projects.save(missing, 1)).rejects.toThrow('이미지');
    const originalPut = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'projects') throw new DOMException('disk full', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    });
    try {
      await expect(repo.projects.save({ ...saved, name: '저장 실패' }, 1)).rejects.toMatchObject({
        name: 'QuotaExceededError',
      });
    } finally {
      spy.mockRestore();
    }
    const reloaded = await repo.projects.load(saved.id);
    expect(reloaded.storageRevision).toBe(1);
    expect(reloaded.name).toBe('욕실');
  });
  it('protects readonly shared samples and immutable asset identities', async () => {
    const repo = setup();
    const asset = image();
    await repo.assets.put(asset);
    await expect(repo.assets.put({ ...asset, name: 'overwritten' })).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    const shared = await repo.materials.create({ ...material(asset.id), scope: 'shared' });
    await expect(repo.materials.update(shared.materialId, material(asset.id), shared.id)).rejects.toThrow(
      '복제',
    );
    await expect(repo.materials.setActive(shared.materialId, false)).rejects.toThrow('비활성화');
    const personal = await repo.materials.create({ ...material(asset.id), scope: 'personal' });
    expect(personal.materialId).not.toBe(shared.materialId);
  });
  it('rejects invalid quad saves while preserving the last valid revision', async () => {
    const repo = setup();
    const asset = image();
    await repo.assets.put(asset);
    const mat = await repo.materials.create(material(asset.id));
    const value = project(asset.id);
    value.scene.surfaces.push(floor(mat.id));
    const saved = await repo.projects.create(value);
    const invalid = structuredClone(saved);
    getActiveScene(invalid).surfaces[0].quad[1] = { ...getActiveScene(invalid).surfaces[0].quad[0] };
    await expect(repo.projects.save(invalid, saved.storageRevision)).rejects.toThrow('원근');
    expect((await repo.projects.load(saved.id)).storageRevision).toBe(saved.storageRevision);
  });
});
