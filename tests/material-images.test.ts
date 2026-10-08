import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import {
  getMaterialImageAssetId,
  getPlacementViewIndex,
  getPreferredProductViewIndex,
  stripLegacyMaterialImages,
} from '../src/lib/material-images';
import { createLegacyLocalRepositories } from './helpers/legacy-local-repositories';
import { materialReferences } from '../src/lib/repositories/references';
import { materialInputSchema } from '../src/lib/storage/validation';
import { legacyMeshAsset } from './helpers/legacy-mesh-asset';
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
  it('shows the 대표 이미지 of a product before any direction photo, and the 정면 photo without one', () => {
    const input = { ...material(), views: [view('왼쪽'), view('정면')] };
    expect(getMaterialImageAssetId(input)).toBe(input.views[1].assetId);
    expect(getMaterialImageAssetId({ ...input, coverAssetId: 'cover' })).toBe('cover');
    expect(getMaterialImageAssetId({ ...input, coverAssetId: '' })).toBe(input.views[1].assetId);
    // No 정면: the first direction photo; no photo at all: nothing (as before).
    const side = { ...material(), views: [view('오른쪽'), view('뒤')] };
    expect(getMaterialImageAssetId(side)).toBe(side.views[0].assetId);
    expect(getMaterialImageAssetId(material())).toBeUndefined();
  });

  it('never shows or places with a retired 위·아래 photo, and keeps the numbers of the photos', () => {
    const input = { ...material(), views: [view('위'), view('아래'), view('오른쪽'), view('정면')] };
    expect(getPreferredProductViewIndex(input)).toBe(3);
    expect(getMaterialImageAssetId(input)).toBe(input.views[3].assetId);
    expect(getPreferredProductViewIndex({ ...input, views: input.views.slice(0, 3) })).toBe(2);
    // The wall picks the photo that suits it, skipping the retired ones; the stored order is untouched.
    expect(getPlacementViewIndex(input, 'left').index).toBe(2);
    expect(getPlacementViewIndex(input, 'back').index).toBe(3);
    // Only retired photos: none to place with, and nothing to show.
    const only = { ...material(), views: [view('위'), view('아래')] };
    expect(getPreferredProductViewIndex(only)).toBe(-1);
    expect(getPlacementViewIndex(only, 'floor').index).toBe(-1);
    expect(getMaterialImageAssetId(only)).toBeUndefined();
    expect(getMaterialImageAssetId({ ...only, coverAssetId: 'cover' })).toBe('cover');
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
  it('keeps the 대표 이미지 of a product and drops the old gallery, retired photos and a tile cover', () => {
    const input = { ...material(), coverAssetId: 'cover', imageAssetIds: ['gallery'], views: [view('정면')] };
    const before = structuredClone(input);
    const stripped = stripLegacyMaterialImages(input);
    expect(stripped.coverAssetId).toBe('cover');
    expect(stripped).not.toHaveProperty('imageAssetIds');
    expect(stripped.views).toEqual(input.views);
    expect(input).toEqual(before);
    // A retired 위·아래 photo is left out of the saved version; the others keep their order.
    const withTop = { ...input, views: [view('정면'), view('위'), view('뒤')] };
    expect(stripLegacyMaterialImages(withTop).views.map((v) => v.direction)).toEqual(['정면', '뒤']);
    expect(withTop.views).toHaveLength(3);
    // A tile shows its texture: no cover.
    const tile = { ...input, category: 'tile' as const, views: [], textureAssetIds: ['t'] };
    expect(stripLegacyMaterialImages(tile)).not.toHaveProperty('coverAssetId');
    // Legacy-only images stay until a real placement image exists.
    const legacy = { ...input, views: [] };
    expect(stripLegacyMaterialImages(legacy)).toEqual(legacy);
  });
});

describe('material persistence without a separate cover/gallery', () => {
  it.each(['basin', 'tile'] as const)(
    'registers %s and round-trips it without adding deprecated keys',
    async (category) => {
      const repos = createLegacyLocalRepositories('images-' + crypto.randomUUID());
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
    const repos = createLegacyLocalRepositories(databaseName);
    const cover = image(),
      gallery = image(),
      input = image(),
      png = image(),
      orphan = image();
    for (const asset of [cover, gallery, input, png, orphan]) await repos.assets.put(asset);
    const mesh = { ...legacyMeshAsset('입체', input.id), createdAt: input.createdAt };
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
    // The 대표 이미지 stays on a product's new version; the old gallery does not.
    expect(first.coverAssetId).toBe(cover.id);
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
    expect(second.coverAssetId).toBe(cover.id);
    expect(second).not.toHaveProperty('imageAssetIds');
    expect((await repos.materials.getVersion(first.id)).coverAssetId).toBe(cover.id);
    expect(await repos.assets.removeUnused()).toBe(1);
    for (const id of [cover.id, gallery.id, input.id, png.id, mesh.id])
      expect((await repos.assets.get(id)).id).toBe(id);
    await expect(repos.assets.get(orphan.id)).rejects.toThrow();
  });
  it('accepts old cover-only material data but rejects completely missing photos', async () => {
    const repos = createLegacyLocalRepositories('images-' + crypto.randomUUID());
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
