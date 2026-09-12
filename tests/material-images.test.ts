import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import {
  getMaterialImageAssetId,
  getPreferredProductViewIndex,
  stripLegacyMaterialImages,
} from '../src/lib/material-images';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { materialReferences } from '../src/lib/repositories/references';
import { materialInputSchema } from '../src/lib/supabase/validation';
import { makeProductMeshAsset } from '../src/lib/product3d/codec';
import type { ImageAssetRecord, MaterialInput } from '../src/lib/types';

function material(): MaterialInput {
  return {
    name: '사진 선택 검증',
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
    installation: 'floor',
    textureAssetIds: [],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
  };
}
const view = (direction: string, assetId = crypto.randomUUID()) => ({
  direction,
  assetId,
  anchor: { x: 0.5, y: 0.9 },
});
const image = (): ImageAssetRecord => ({
  id: crypto.randomUUID(),
  ownerId: 'local',
  name: '제품.png',
  mime: 'image/png',
  size: 3,
  width: 20,
  height: 20,
  kind: 'product',
  createdAt: '2000-01-01T00:00:00.000Z',
  blob: new Blob(['png'], { type: 'image/png' }),
});

describe('material display image selection', () => {
  it.each(['정면', '  정면  ', ' FRONT ', 'FrOnTaL', 'ＦＲＯＮＴ'])(
    'prefers the exact normalized front name %s without reordering the stored views',
    (name) => {
      const input = {
        ...material(),
        coverAssetId: 'old-cover',
        imageAssetIds: ['old-gallery'],
        views: [view('왼쪽 측면'), view(name)],
      };
      const before = structuredClone(input);
      expect(getPreferredProductViewIndex(input)).toBe(1);
      expect(getMaterialImageAssetId(input)).toBe(input.views[1].assetId);
      expect(input).toEqual(before);
    },
  );
  it('does not confuse front-adjacent angle names with front and picks the first view if none is exact', () => {
    const input = {
      ...material(),
      views: [view('오른쪽'), view('정면 30도'), view('front 30°'), view('frontal view')],
    };
    expect(getPreferredProductViewIndex(input)).toBe(0);
    expect(getMaterialImageAssetId(input)).toBe(input.views[0].assetId);
    expect(getPreferredProductViewIndex(material())).toBe(-1);
  });
  it('uses the first tile texture despite old cover/gallery or product-view metadata', () => {
    const input = {
      ...material(),
      category: 'tile' as const,
      coverAssetId: 'cover',
      imageAssetIds: ['gallery'],
      textureAssetIds: ['texture1', 'texture2'],
      views: [view('정면')],
    };
    expect(getMaterialImageAssetId(input)).toBe('texture1');
  });
  it('uses legacy images only when the category placement images are absent', () => {
    const input = { ...material(), coverAssetId: 'cover', imageAssetIds: ['gallery'] };
    expect(getMaterialImageAssetId(input)).toBe('cover');
    expect(getMaterialImageAssetId({ ...input, coverAssetId: undefined })).toBe('gallery');
    expect(getMaterialImageAssetId(material())).toBeUndefined();
    expect(getMaterialImageAssetId(undefined)).toBeUndefined();
  });
  it('strips legacy fields from new versions without mutating old data or dropping a legacy-only image', () => {
    const input = { ...material(), coverAssetId: 'cover', imageAssetIds: ['gallery'], views: [view('정면')] };
    const before = structuredClone(input);
    const stripped = stripLegacyMaterialImages(input);
    expect(stripped).not.toHaveProperty('coverAssetId');
    expect(stripped).not.toHaveProperty('imageAssetIds');
    expect(stripped.views).toEqual(input.views);
    expect(input).toEqual(before);
    const legacy = { ...input, views: [] };
    expect(stripLegacyMaterialImages(legacy)).toEqual(legacy);
  });
});

describe('material persistence without a separate cover/gallery', () => {
  it.each(['basin', 'tile'] as const)(
    'registers %s and round-trips it without adding deprecated keys',
    async (category) => {
      const repos = createLocalRepositories('images-' + crypto.randomUUID());
      const photo = image();
      await repos.assets.put(photo);
      const input = {
        ...material(),
        category,
        views: category === 'tile' ? [] : [view('정면', photo.id)],
        textureAssetIds: category === 'tile' ? [photo.id] : [],
      };
      const parsed = materialInputSchema.parse(input);
      expect(parsed).not.toHaveProperty('coverAssetId');
      expect(parsed).not.toHaveProperty('imageAssetIds');
      const saved = await repos.materials.create(parsed);
      const restored = await repos.materials.getVersion(saved.id);
      expect(restored).not.toHaveProperty('coverAssetId');
      expect(restored).not.toHaveProperty('imageAssetIds');
      expect(getMaterialImageAssetId(restored)).toBe(photo.id);
      expect(materialReferences(restored)).toEqual([photo.id]);
    },
  );
  it('keeps old cover/gallery and mesh/input references after saving a new clean version', async () => {
    const databaseName = 'images-' + crypto.randomUUID();
    const repos = createLocalRepositories(databaseName);
    const cover = image(),
      gallery = image(),
      input = image(),
      png = image(),
      orphan = image();
    for (const asset of [cover, gallery, input, png, orphan]) await repos.assets.put(asset);
    const mesh = {
      ...(await makeProductMeshAsset(
        {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          colors: new Float32Array(9).fill(1),
          indices: new Uint32Array([0, 1, 2]),
        },
        '입체',
        input.id,
      )),
      createdAt: input.createdAt,
    };
    await repos.assets.put(mesh);
    const legacy = {
      ...material(),
      coverAssetId: cover.id,
      imageAssetIds: [gallery.id],
      views: [
        {
          ...view('정면', png.id),
          product3d: {
            version: 1 as const,
            inputAssetId: input.id,
            meshAssetId: mesh.id,
            pose: {
              objectQuaternion: [0, 0, 0, 1] as [number, number, number, number],
              cameraQuaternion: [0, 0, 0, 1] as [number, number, number, number],
              zoom: 1,
            },
            modelId: 'model',
            modelRevision: 'pinned',
          },
        },
      ],
    };
    const first = await repos.materials.create(legacy);
    expect(first).not.toHaveProperty('coverAssetId');
    expect(first).not.toHaveProperty('imageAssetIds');
    expect(legacy.coverAssetId).toBe(cover.id);
    // Emulate a version persisted before the cover/gallery fields became optional.
    const db = await openDB(databaseName, 1);
    await db.put('versions', { ...first, coverAssetId: cover.id, imageAssetIds: [gallery.id] });
    db.close();
    const second = await repos.materials.update(
      first.materialId,
      stripLegacyMaterialImages(legacy),
      first.id,
    );
    expect(second).not.toHaveProperty('coverAssetId');
    expect(second).not.toHaveProperty('imageAssetIds');
    expect((await repos.materials.getVersion(first.id)).coverAssetId).toBe(cover.id);
    expect(await repos.assets.removeUnused()).toBe(1);
    for (const id of [cover.id, gallery.id, input.id, png.id, mesh.id])
      expect((await repos.assets.get(id)).id).toBe(id);
    await expect(repos.assets.get(orphan.id)).rejects.toThrow();
  });
  it('accepts old cover-only material data but rejects completely missing photos', async () => {
    const repos = createLocalRepositories('images-' + crypto.randomUUID());
    const photo = image();
    await repos.assets.put(photo);
    const old = { ...material(), coverAssetId: photo.id };
    expect(materialInputSchema.safeParse(old).success).toBe(true);
    const saved = await repos.materials.create(old);
    expect(getMaterialImageAssetId(saved)).toBe(photo.id);
    expect(materialInputSchema.safeParse(material()).success).toBe(false);
    await expect(repos.materials.create(material())).rejects.toThrow('사진');
  });
});
