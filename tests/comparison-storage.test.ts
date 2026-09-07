import { normalizeProjectDocument } from '../src/lib/comparison';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { projectReferences, StorageConflictError } from '../src/lib/repositories/references';
import { captureProjectFrame } from '../src/lib/comparison';
import { projectSchema } from '../src/lib/supabase/validation';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type LegacyProjectDocument,
  type MaterialInput,
  type Scene,
} from '../src/lib/types';

const stamp = '2020-01-01T00:00:00.000Z';
async function setup() {
  const databaseName = 'comparison-' + crypto.randomUUID();
  const repo = createLocalRepositories(databaseName);
  async function asset(name = 'room.png') {
    const id = crypto.randomUUID();
    await repo.assets.put({
      id,
      name,
      ownerId: 'local',
      mime: 'image/png',
      size: 3,
      width: 1200,
      height: 800,
      kind: 'original',
      createdAt: stamp,
      blob: new Blob(['png']),
    });
    return id;
  }
  async function scene(): Promise<Scene> {
    return {
      originalAssetId: await asset(),
      previewAssetId: await asset(),
      room: { ...DEFAULT_ROOM },
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    };
  }
  const productAsset = await asset('mirror.png');
  const input: MaterialInput = {
    name: '재구성 거울',
    brand: '',
    code: '',
    category: 'mirror',
    scope: 'personal',
    description: '',
    color: '#aabbcc',
    finish: '',
    widthMm: 600,
    heightMm: 800,
    depthMm: 25,
    usage: 'wall',
    installation: 'wall',
    coverAssetId: productAsset,
    imageAssetIds: [productAsset],
    textureAssetIds: [],
    views: [{ assetId: productAsset, direction: '재구성', anchor: { x: 0.5, y: 0.5 } }],
    defaultGroutWidth: 0,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    reconstruction: { version: 1, kind: 'mirror' },
  };
  const material = await repo.materials.create(input);
  const before = await scene();
  before.fixtures.push({
    id: crypto.randomUUID(),
    name: '거울',
    materialVersionId: material.id,
    viewIndex: 0,
    position: { x: 0.5, y: 0.4 },
    width: 0.2,
    height: 0.3,
    anchor: { x: 0.5, y: 0.5 },
    rotation: 0,
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    reconstruction: {
      version: 1,
      kind: 'mirror',
      color: '#aabbcc',
      widthMm: 600,
      heightMm: 800,
      depthMm: 25,
    },
    projectedQuad: [
      { x: 0.4, y: 0.25 },
      { x: 0.6, y: 0.25 },
      { x: 0.6, y: 0.55 },
      { x: 0.4, y: 0.55 },
    ],
  });
  const p: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '재구성 저장',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: stamp,
    updatedAt: stamp,
    scene: await scene(),
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    comparison: {
      before,
      room: { ...DEFAULT_ROOM },
      aspect: 1.5,
      cameraVersion: 1,
      referenceOriginalAssetId: await asset('photo-original.png'),
      referencePreviewAssetId: await asset('photo-preview.png'),
      status: 'draft',
      review: {
        version: 1,
        analysis: 'partial',
        warnings: ['깊이 확인 필요'],
        candidates: [
          {
            id: 'candidate-1',
            kind: 'mirror',
            bounds: { left: 0.3, top: 0.2, right: 0.5, bottom: 0.7 },
            foot: { x: 0.4, y: 0.7 },
            color: '#aabbcc',
            pixels: 300,
            evidence: { semanticPixels: 300, meanMargin: 1.2 },
            status: 'placed',
            fixtureId: before.fixtures[0].id,
          },
        ],
        planes: [
          {
            id: 'source-wall',
            face: 'back',
            quad: [
              { x: 0.2, y: 0.2 },
              { x: 0.8, y: 0.2 },
              { x: 0.8, y: 0.8 },
              { x: 0.2, y: 0.8 },
            ],
            depthStart: 0,
            depthEnd: 1,
            verticalStart: 0.2,
            verticalEnd: 0.9,
            confirmed: false,
            tile: { color: '#bbbbbb', widthMm: 300, heightMm: 600, groutWidth: 0, estimated: true },
          },
        ],
      },
    },
  };
  return { repo, databaseName, asset, p, material, productAsset };
}

describe('comparison persistence and reference integrity', () => {
  it('round-trips both scenes, reference photos, templates and review data through local and cloud schemas', async () => {
    const { repo, p, material } = await setup();
    p.history.past = [captureProjectFrame(structuredClone(p))];
    p.comparison!.status = 'confirmed';
    const saved = await repo.projects.create(p);
    expect(saved.schemaVersion).toBe(3);
    expect((await repo.projects.load(saved.id)).shared.comparison).toEqual(p.comparison);
    const parsed = normalizeProjectDocument(projectSchema.parse(saved));
    expect(parsed.shared.comparison).toEqual(p.comparison);
    expect(parsed.shared.beforeHistory.past[0].comparison!.status).toBe('draft');
    expect(parsed.shared.comparison!.before.fixtures[0].projectedQuad).toHaveLength(4);
    expect((await repo.materials.getVersion(material.id)).reconstruction).toEqual({
      version: 1,
      kind: 'mirror',
    });
  });
  it('keeps both current/history Before assets and source photos after clone and deleting the original', async () => {
    const { repo, p, asset, productAsset } = await setup();
    p.history.past = [captureProjectFrame(structuredClone(p))];
    p.comparison!.before.originalAssetId = await asset('new-before.png');
    p.comparison!.before.previewAssetId = p.comparison!.before.originalAssetId;
    p.comparison!.referenceOriginalAssetId = await asset('new-reference.png');
    p.history.future = [captureProjectFrame(structuredClone(p))];
    p.history.future[0].comparison!.referencePreviewAssetId = await asset('redo-reference.png');
    const orphan = await asset('unused.png');
    const saved = await repo.projects.create(p);
    const copy = await repo.projects.duplicate(saved.id);
    const references = projectReferences(p);
    expect(references.versions).toContain(p.comparison!.before.fixtures[0].materialVersionId);
    expect(references.assets).toContain(p.history.past[0].comparison!.referenceOriginalAssetId);
    expect(references.assets).toContain(p.history.future[0].comparison!.referencePreviewAssetId);
    await repo.projects.remove(saved.id);
    expect(await repo.assets.removeUnused()).toBe(1);
    await expect(repo.assets.get(orphan)).rejects.toThrow();
    for (const id of [...references.assets, productAsset]) expect((await repo.assets.get(id)).id).toBe(id);
    expect((await repo.projects.load(copy.id)).shared.comparison).toMatchObject({
      room: p.comparison!.room,
      referenceOriginalAssetId: p.comparison!.referenceOriginalAssetId,
    });
  });
  it('rejects missing source photos, mismatched camera rooms, and stale revisions without overwriting the saved pair', async () => {
    const { repo, p } = await setup();
    const saved = await repo.projects.create(p);
    const missing = structuredClone(saved);
    missing.shared.comparison!.referenceOriginalAssetId = crypto.randomUUID();
    await expect(repo.projects.save(missing, saved.storageRevision)).rejects.toThrow('연결된 이미지');
    const inconsistent = structuredClone(saved);
    inconsistent.shared.comparison!.before.room!.widthMm = 3600;
    expect(projectSchema.safeParse(inconsistent).success).toBe(false);
    await expect(repo.projects.save(inconsistent, saved.storageRevision)).rejects.toThrow();
    expect((await repo.projects.load(saved.id)).shared.comparison).toEqual(saved.shared.comparison);
    await repo.projects.save({ ...saved, name: '최근 저장본' }, saved.storageRevision);
    await expect(repo.projects.save(saved, saved.storageRevision)).rejects.toBeInstanceOf(
      StorageConflictError,
    );
  });
  it('loads old IndexedDB documents without rewriting them and upgrades only on a successful conditional save', async () => {
    const { repo, p, databaseName } = await setup();
    delete p.comparison;
    p.schemaVersion = 1;
    p.storageRevision = 5;
    const raw = await openDB(databaseName);
    await raw.put('projects', p);
    const loaded = await repo.projects.load(p.id);
    expect(loaded.schemaVersion).toBe(3);
    expect(loaded.editRevision).toBe(0);
    expect(loaded.storageRevision).toBe(5);
    expect((await raw.get('projects', p.id)).schemaVersion).toBe(1);
    const saved = await repo.projects.save(loaded, 5);
    expect(saved.schemaVersion).toBe(3);
    expect(saved.storageRevision).toBe(6);
    expect((await raw.get('projects', p.id)).schemaVersion).toBe(3);
    raw.close();
  });
  it('collects only aged unreferenced internal caches while keeping copies, recent creations and history-linked versions', async () => {
    const { repo, p, asset, databaseName, material: source } = await setup();
    async function cached(label: string) {
      const assetId = await asset(label + '.png');
      const version = await repo.materials.create({
        ...source,
        coverAssetId: assetId,
        imageAssetIds: [assetId],
        views: [{ assetId, direction: '기본', anchor: { x: 0.5, y: 0.5 } }],
        name: '거울 · 재구성 모형',
        code: 'reconstruction-v1-' + label.padEnd(64, 'a'),
        reconstruction: { version: 1, kind: 'mirror' },
      });
      return { version, assetId };
    }
    const orphan = await cached('a'),
      recent = await cached('b'),
      used = await cached('c'),
      copied = await cached('d');
    const copy = await repo.materials.create({ ...copied.version, name: copied.version.name + ' (복사)' });
    const raw = await openDB(databaseName);
    for (const item of [orphan, used, copied]) {
      await raw.put('versions', { ...item.version, createdAt: stamp });
      const row = await raw.get('materials', item.version.materialId);
      await raw.put('materials', { ...row, updatedAt: stamp });
    }
    await raw.put('versions', { ...copy, createdAt: stamp });
    const copyRow = await raw.get('materials', copy.materialId);
    await raw.put('materials', { ...copyRow, updatedAt: stamp });
    p.history.past = [captureProjectFrame(structuredClone(p))];
    p.history.past[0].comparison!.before.fixtures[0].materialVersionId = used.version.id;
    await repo.projects.create(p);
    expect(await repo.assets.removeUnused()).toBe(1);
    await expect(repo.materials.getVersion(orphan.version.id)).rejects.toThrow();
    await expect(repo.assets.get(orphan.assetId)).rejects.toThrow();
    await expect(repo.materials.getVersion(copied.version.id)).rejects.toThrow();
    expect((await repo.materials.getVersion(copy.id)).name).toContain('(복사)');
    expect((await repo.assets.get(copied.assetId)).id).toBe(copied.assetId);
    expect((await repo.materials.getVersion(recent.version.id)).id).toBe(recent.version.id);
    expect((await repo.materials.getVersion(used.version.id)).id).toBe(used.version.id);
    expect((await repo.assets.get(used.assetId)).id).toBe(used.assetId);
    raw.close();
  });
});
