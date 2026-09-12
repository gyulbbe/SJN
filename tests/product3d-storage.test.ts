import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { makeProductMeshAsset } from '../src/lib/product3d/codec';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { materialReferences, StorageConflictError } from '../src/lib/repositories/references';
import { materialInputSchema, assetMetadataSchema } from '../src/lib/supabase/validation';
import type { ImageAssetRecord, MaterialInput } from '../src/lib/types';
import type { Product3dReference } from '../src/lib/product3d/state-types';
const old = '2000-01-01T00:00:00.000Z';
const image = (): ImageAssetRecord => ({
  id: crypto.randomUUID(),
  ownerId: 'local',
  name: '사진.png',
  mime: 'image/png',
  size: 3,
  width: 10,
  height: 10,
  kind: 'product',
  createdAt: old,
  blob: new Blob(['png'], { type: 'image/png' }),
});
const meshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  colors: new Float32Array(9).fill(1),
  indices: new Uint32Array([0, 1, 2]),
};
function material(photo: string, reference?: Product3dReference): MaterialInput {
  return {
    name: '세면대',
    brand: '',
    code: '',
    category: 'basin',
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 800,
    depthMm: 400,
    usage: 'wall',
    installation: 'wall',
    coverAssetId: photo,
    imageAssetIds: [photo],
    textureAssetIds: [],
    views: [{ assetId: photo, direction: '원본 방향', anchor: { x: 0.5, y: 1 }, product3d: reference }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
  };
}
async function setup() {
  const repos = createLocalRepositories('product3d-' + crypto.randomUUID());
  const input = image();
  const png = image();
  await repos.assets.put(input);
  await repos.assets.put(png);
  const mesh = { ...(await makeProductMeshAsset(meshData, '입체', input.id)), createdAt: old };
  await repos.assets.put(mesh);
  const reference: Product3dReference = {
    version: 1,
    meshAssetId: mesh.id,
    inputAssetId: input.id,
    pose: { objectQuaternion: [0, 0, 0, 1], cameraQuaternion: [0, 0, 0, 1], zoom: 1 },
    modelId: 'model',
    modelRevision: 'revision',
  };
  return { repos, input, png, mesh, reference };
}
describe('persisted product3d material data', () => {
  it('preserves legacy views and validates normalized pose/new mesh metadata', async () => {
    const { png, reference, mesh } = await setup();
    expect(materialInputSchema.parse(material(png.id)).views[0].product3d).toBeUndefined();
    expect(materialInputSchema.parse(material(png.id, reference)).views[0].product3d).toEqual(reference);
    expect(
      materialInputSchema.safeParse(
        material(png.id, { ...reference, pose: { ...reference.pose, objectQuaternion: [0, 0, 0, 0] } }),
      ).success,
    ).toBe(false);
    expect(assetMetadataSchema.safeParse(mesh).success).toBe(true);
    expect(assetMetadataSchema.safeParse({ ...mesh, sourceAssetId: undefined }).success).toBe(false);
  });
  it('collects PNG, mesh and exact input references only once', async () => {
    const { png, input, mesh, reference } = await setup();
    expect(new Set(materialReferences(material(png.id, reference)))).toEqual(
      new Set([png.id, input.id, mesh.id]),
    );
  });
  it('round-trips pose, makes independent immutable versions, and keeps shared source/assets on cleanup', async () => {
    const { repos, png, input, mesh, reference } = await setup();
    const first = await repos.materials.create(material(png.id, reference));
    const changed = structuredClone(reference);
    changed.pose.zoom = 2;
    const second = await repos.materials.update(first.materialId, material(png.id, changed), first.id);
    changed.pose.zoom = 10;
    expect((await repos.materials.getVersion(first.id)).views[0].product3d?.pose.zoom).toBe(1);
    expect((await repos.materials.getVersion(second.id)).views[0].product3d?.pose.zoom).toBe(2);
    await expect(
      repos.materials.update(first.materialId, material(png.id, reference), first.id),
    ).rejects.toBeInstanceOf(StorageConflictError);
    await repos.materials.create(material(png.id, reference));
    const orphan = image();
    await repos.assets.put(orphan);
    expect(await repos.assets.removeUnused()).toBe(1);
    for (const id of [png.id, input.id, mesh.id]) expect((await repos.assets.get(id)).id).toBe(id);
    await expect(repos.assets.get(orphan.id)).rejects.toThrow();
  });
  it('rejects missing, wrong-kind or mismatched source references without changing saved versions', async () => {
    const { repos, png, mesh, reference } = await setup();
    const saved = await repos.materials.create(material(png.id, reference));
    for (const change of [
      { meshAssetId: png.id },
      { inputAssetId: png.id },
      { meshAssetId: crypto.randomUUID() },
    ]) {
      await expect(
        repos.materials.update(saved.materialId, material(png.id, { ...reference, ...change }), saved.id),
      ).rejects.toThrow();
    }
    await expect(repos.materials.create(material(mesh.id))).rejects.toThrow('이미지');
    expect((await repos.materials.list())[0].version.id).toBe(saved.id);
  });
  it('rejects corrupt/duplicate mesh uploads and preserves staged data after quota failure', async () => {
    const { repos, png, mesh, reference } = await setup();
    await expect(
      repos.assets.put({ ...mesh, id: crypto.randomUUID(), blob: new Blob(['corrupt']) }),
    ).rejects.toThrow();
    await expect(repos.assets.put(mesh)).rejects.toBeInstanceOf(StorageConflictError);
    const saved = await repos.materials.create(material(png.id, reference));
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      await expect(
        repos.materials.update(saved.materialId, material(png.id, reference), saved.id),
      ).rejects.toThrow('full');
    } finally {
      spy.mockRestore();
    }
    expect((await repos.materials.list())[0].version.id).toBe(saved.id);
    expect((await repos.assets.get(mesh.id)).id).toBe(mesh.id);
  });
});

describe('shared geometry angle versions', () => {
  it('persists multiple poses and keeps shared mesh/input when one angle is removed in a new version', async () => {
    const { repos, png, input, mesh, reference } = await setup();
    const secondPhoto = image();
    await repos.assets.put(secondPhoto);
    const draft = material(png.id, reference);
    draft.views.push({
      assetId: secondPhoto.id,
      direction: '왼쪽 사선',
      anchor: { x: 0.5, y: 0.8 },
      product3d: { ...structuredClone(reference), pose: { ...structuredClone(reference.pose), zoom: 2 } },
    });
    const first = await repos.materials.create(draft);
    const next = { ...draft, coverAssetId: secondPhoto.id, views: [draft.views[1]] };
    const updated = await repos.materials.update(first.materialId, next, first.id);
    const saved = await repos.materials.getVersion(updated.id);
    expect(saved.views).toHaveLength(1);
    expect(saved.views[0].product3d?.meshAssetId).toBe(mesh.id);
    expect(saved.views[0].product3d?.pose.zoom).toBe(2);
    const oldVersion = await repos.materials.getVersion(first.id);
    expect(oldVersion.views.map((v) => v.product3d?.pose.zoom)).toEqual([1, 2]);
    expect(materialInputSchema.safeParse(saved).success).toBe(true);
    await repos.assets.removeUnused();
    await expect(repos.assets.get(mesh.id)).resolves.toHaveProperty('id', mesh.id);
    await expect(repos.assets.get(input.id)).resolves.toHaveProperty('id', input.id);
    await expect(repos.assets.get(png.id)).resolves.toHaveProperty('id', png.id);
  });
});
