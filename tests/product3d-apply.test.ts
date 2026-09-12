import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecord, ImageAssetRecord, MaterialInput } from '../src/lib/types';
import type { AssetRepository } from '../src/lib/repositories/contracts';
import type { Product3dApplication } from '../src/lib/product3d/types';
import { decodeProductMesh } from '../src/lib/product3d/codec';
import { makeAsset } from '../src/lib/images';
import {
  prepareProductReplacement,
  replaceProductPhoto,
  addProductPhoto,
  renameProductPhoto,
  removeProductPhoto,
  MAX_PRODUCT_VIEWS,
} from '../src/lib/product3d/apply';

// Raster decoding is covered by browser tests. Keep real mesh encoding in these persistence tests.
vi.mock('../src/lib/images', () => ({
  makeAsset: vi.fn(
    async (
      blob: Blob,
      name: string,
      kind: ImageAssetRecord['kind'],
      sourceAssetId?: string,
    ): Promise<ImageAssetRecord> => ({
      id: crypto.randomUUID(),
      ownerId: 'local',
      name,
      kind,
      mime: blob.type,
      blob,
      size: blob.size,
      width: 1024,
      height: 1024,
      sourceAssetId,
      createdAt: new Date().toISOString(),
    }),
  ),
}));
function application(): Product3dApplication {
  return {
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      colors: new Float32Array(9).fill(1),
      indices: new Uint32Array([0, 1, 2]),
    },
    input: {
      blob: new Blob(['exact transparent input'], { type: 'image/png' }),
      name: '제품.png',
      sourceAssetId: crypto.randomUUID(),
    },
    capture: {
      blob: new Blob(['captured PNG'], { type: 'image/png' }),
      width: 1024,
      height: 1024,
      anchor: { x: 0.5, y: 0.93 },
    },
    pose: { objectQuaternion: [0, 0, 0, 1], cameraQuaternion: [0, 0, 0, 1], zoom: 2 },
    modelId: 'test-model',
    modelRevision: 'pinned-revision',
  };
}
function repository(afterPut?: (asset: AssetRecord) => void) {
  const records = new Map<string, AssetRecord>();
  const put = vi.fn(async (asset: AssetRecord) => {
    if (records.has(asset.id)) throw new Error('duplicate');
    records.set(asset.id, asset);
    afterPut?.(asset);
  });
  const assets: AssetRepository = {
    put,
    get: async (id) => {
      const asset = records.get(id);
      if (!asset) throw new Error('missing');
      return asset;
    },
    removeUnused: async () => 0,
  };
  return { assets, records, put };
}
function form(): MaterialInput {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  return {
    name: '제품',
    brand: '',
    code: '',
    category: 'basin',
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 800,
    depthMm: 300,
    usage: 'wall',
    installation: 'wall',
    textureAssetIds: [],
    views: [
      { assetId: first, direction: '직접 촬영 A', anchor: { x: 0.5, y: 0.8 } },
      { assetId: second, direction: '직접 촬영 B', anchor: { x: 0.4, y: 0.7 } },
    ],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
  };
}
beforeEach(() => vi.clearAllMocks());
describe('360 product photo application', () => {
  it('retries a failed PNG write using the successfully staged input and mesh without duplicate writes', async () => {
    const result = application();
    const { assets, records, put } = repository();
    const write = assets.put;
    let failPng = true;
    assets.put = vi.fn(async (asset) => {
      if (asset.kind !== 'product-mesh' && asset.derivation === 'ai-product3d' && failPng) {
        failPng = false;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      await write(asset);
    });
    await expect(prepareProductReplacement(result, assets, 'floor')).rejects.toThrow('quota');
    expect([...records.values()].map((asset) => asset.kind)).toEqual(['product', 'product-mesh']);
    const input = [...records.values()].find((asset) => asset.kind === 'product')!;
    const mesh = [...records.values()].find((asset) => asset.kind === 'product-mesh')!;
    const next = await prepareProductReplacement(result, assets, 'floor');
    expect(next.product3d.inputAssetId).toBe(input.id);
    expect(next.product3d.meshAssetId).toBe(mesh.id);
    expect(mesh.sourceAssetId).toBe(input.id);
    expect(input.sourceAssetId).toBe(result.input.sourceAssetId);
    expect(await input.blob.text()).toBe(await result.input.blob.text());
    expect(await decodeProductMesh(mesh.blob)).toEqual(result.mesh);
    expect(assets.put).toHaveBeenCalledTimes(4);
    expect(put).toHaveBeenCalledTimes(3);
    expect(records.size).toBe(3);
  });

  it('refuses every write when editing permission is already lost', async () => {
    const { assets, put } = repository();
    await expect(
      prepareProductReplacement(application(), assets, 'floor', () => {
        throw new Error('readonly');
      }),
    ).rejects.toThrow('readonly');
    expect(put).not.toHaveBeenCalled();
    expect(makeAsset).not.toHaveBeenCalled();
  });

  it('stops after the completed input write when permission is lost and resumes from that input after permission returns', async () => {
    const result = application();
    let writable = true;
    const { assets, records, put } = repository(() => {
      writable = false;
    });
    const guard = () => {
      if (!writable) throw new Error('readonly');
    };
    await expect(prepareProductReplacement(result, assets, 'floor', guard)).rejects.toThrow('readonly');
    expect(put).toHaveBeenCalledTimes(1);
    const input = [...records.values()][0];
    expect(input.kind).toBe('product');
    const successfulWrites = assets.put;
    assets.put = async (asset) => {
      await successfulWrites(asset);
      writable = true;
    };
    writable = true;
    const next = await prepareProductReplacement(result, assets, 'floor', guard);
    expect(next.product3d.inputAssetId).toBe(input.id);
    expect(put).toHaveBeenCalledTimes(3);
    expect(
      [...records.values()].filter(
        (asset) => asset.kind !== 'product-mesh' && asset.derivation === 'ai-alpha',
      ),
    ).toHaveLength(1);
  });

  it('reuses saved input/mesh IDs, clones pose and replaces only the selected view without a cover', async () => {
    const result = application();
    result.input.existingAssetId = crypto.randomUUID();
    result.meshAssetId = crypto.randomUUID();
    const { assets, put } = repository();
    const replacement = await prepareProductReplacement(result, assets, 'wall');
    expect(put).toHaveBeenCalledTimes(1);
    expect(replacement.product3d.inputAssetId).toBe(result.input.existingAssetId);
    expect(replacement.product3d.meshAssetId).toBe(result.meshAssetId);
    expect(replacement.anchor).toEqual({ x: 0.5, y: 0.5 });
    result.pose.objectQuaternion[0] = 0.7;
    result.pose.cameraQuaternion[1] = 0.4;
    result.pose.zoom = 4;
    expect(replacement.product3d.pose).toEqual({
      objectQuaternion: [0, 0, 0, 1],
      cameraQuaternion: [0, 0, 0, 1],
      zoom: 2,
    });
    const original = form();
    const before = structuredClone(original);
    const first = replaceProductPhoto(original, 0, original.views[0].assetId, replacement);
    expect(first).not.toHaveProperty('coverAssetId');
    expect(first.views.map((view) => view.direction)).toEqual(original.views.map((view) => view.direction));
    expect(first.views[1]).toEqual(original.views[1]);
    expect(first).not.toHaveProperty('imageAssetIds');
    const second = replaceProductPhoto(original, 1, original.views[1].assetId, replacement);
    expect(second).not.toHaveProperty('coverAssetId');
    expect(second.views[0]).toEqual(original.views[0]);
    expect(original).toEqual(before);
  });

  it('rejects a stale or deleted selected photo without mutating the existing material', async () => {
    const original = form();
    const before = structuredClone(original);
    const replacement = await prepareProductReplacement(application(), repository().assets, 'floor');
    expect(() => replaceProductPhoto(original, 0, crypto.randomUUID(), replacement)).toThrow(
      '선택한 제품 사진',
    );
    expect(() => replaceProductPhoto(original, 5, original.views[0].assetId, replacement)).toThrow(
      '선택한 제품 사진',
    );
    expect(original).toEqual(before);
    expect(replacement.anchor).toEqual({ x: 0.5, y: 0.93 });
  });
});

describe('multiple angles of one material', () => {
  it('adds independent views using one mesh and exact input without duplicating geometry writes', async () => {
    const app = application();
    const { assets, records } = repository();
    const original = form();
    const before = structuredClone(original);
    let current = original;
    const replacements = [];
    for (let i = 0; i < 3; i++) {
      app.pose = { ...app.pose, zoom: i + 1, objectQuaternion: [0, 0, Math.sin(i / 4), Math.cos(i / 4)] };
      app.capture.blob = new Blob([`angle ${i}`], { type: 'image/png' });
      const angle = await prepareProductReplacement(app, assets, 'floor');
      replacements.push(angle);
      current = addProductPhoto(current, 0, original.views[0].assetId, angle, `각도 ${i + 1}`);
    }
    expect(original).toEqual(before);
    expect(current.views).toHaveLength(5);
    expect(current.views.slice(0, 2)).toEqual(before.views);
    expect(current).not.toHaveProperty('coverAssetId');
    expect(current.widthMm).toBe(before.widthMm);
    expect(current.category).toBe(before.category);
    expect(new Set(current.views.slice(2).map((v) => v.product3d?.meshAssetId)).size).toBe(1);
    expect(new Set(current.views.slice(2).map((v) => v.product3d?.inputAssetId)).size).toBe(1);
    expect(new Set(current.views.slice(2).map((v) => v.assetId)).size).toBe(3);
    expect(current.views.slice(2).map((v) => v.product3d?.pose.zoom)).toEqual([1, 2, 3]);
    expect([...records.values()].filter((a) => a.kind === 'product-mesh')).toHaveLength(1);
    expect(records.size).toBe(5); // one input, one mesh, three PNGs
    replacements[0].product3d.pose.zoom = 7;
    expect(current.views[2].product3d?.pose.zoom).toBe(1);
    const changed = renameProductPhoto(current, 3, '  왼쪽 사선  ');
    expect(changed.views[3].direction).toBe('왼쪽 사선');
    expect(current.views[3].direction).toBe('각도 2');
  });

  it('enforces names, stale source and existing storage view limit without changing a draft', async () => {
    const original = form();
    const angle = await prepareProductReplacement(application(), repository().assets, 'floor');
    expect(() => addProductPhoto(original, 0, 'deleted', angle, '새 각도')).toThrow('선택한 제품 사진');
    expect(() => addProductPhoto(original, 0, original.views[0].assetId, angle, '  ')).toThrow('각도 이름');
    expect(() => renameProductPhoto(original, 0, 'a'.repeat(201))).toThrow('각도 이름');
    const full = {
      ...original,
      views: Array.from({ length: MAX_PRODUCT_VIEWS }, () => structuredClone(original.views[0])),
    };
    expect(() => addProductPhoto(full, 0, full.views[0].assetId, angle, '초과')).toThrow('최대 100');
    expect(full.views).toHaveLength(MAX_PRODUCT_VIEWS);
  });

  it('removes one angle without creating a separate cover, while preserving the previous input', () => {
    const original = form();
    const before = structuredClone(original);
    const next = removeProductPhoto(original, 0);
    expect(next.views).toEqual([original.views[1]]);
    expect(next).not.toHaveProperty('coverAssetId');
    expect(original).toEqual(before);
    const repeated = { ...original, views: [...original.views, structuredClone(original.views[0])] };
    expect(removeProductPhoto(repeated, 0).views).toHaveLength(2);
    const empty = removeProductPhoto({ ...original, views: [original.views[0]] }, 0);
    expect(empty.views).toEqual([]);
    expect(empty).not.toHaveProperty('coverAssetId');
    expect(() => removeProductPhoto(original, 9)).toThrow('각도 사진');
  });
});
