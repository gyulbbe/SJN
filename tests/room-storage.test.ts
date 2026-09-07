import { getActiveDesign, getActiveScene } from '../src/lib/comparison';
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { resizedRoomScene } from '../src/lib/room-editing';
import { projectSchema } from '../src/lib/supabase/validation';
import { StorageConflictError } from '../src/lib/repositories/references';
import { DEFAULT_COLOR, EMPTY_MASK, type LegacyProjectDocument } from '../src/lib/types';

async function setup() {
  const repo = createLocalRepositories('room-storage-' + crypto.randomUUID());
  const asset = async () => {
    const id = crypto.randomUUID();
    await repo.assets.put({
      id,
      ownerId: 'local',
      name: 'room.png',
      mime: 'image/png',
      size: 3,
      width: 4096,
      height: 2731,
      kind: 'original',
      createdAt: new Date().toISOString(),
      blob: new Blob(['png']),
    });
    return id;
  };
  const original = await asset();
  const p: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '치수 공간',
    schemaVersion: 1,
    editRevision: 0,
    storageRevision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      room: { ...DEFAULT_ROOM },
      originalAssetId: original,
      previewAssetId: original,
      imageWidth: 4096,
      imageHeight: 2731,
      surfaces: createRoomSurfaces(DEFAULT_ROOM, 4096 / 2731),
      protection: EMPTY_MASK(),
      fixtures: [],
      color: { ...DEFAULT_COLOR },
    },
  };
  const project = await repo.projects.create(p);
  return { repo, asset, project };
}

describe('generated-room persistence', () => {
  it('round-trips setting fields, rejects invalid dimensions atomically, and uses conditional revisions', async () => {
    const { repo, project } = await setup();
    const schema = projectSchema.parse(project);
    expect(schema.schemaVersion).toBe(3);
    expect(getActiveScene(project).room).toEqual(DEFAULT_ROOM);
    expect(schema.schemaVersion === 3 && schema.designs[0].scene.surfaces.map((s) => s.roomFace)).toEqual([
      'floor',
      'left',
      'back',
      'right',
    ]);
    const bad = structuredClone(project);
    getActiveScene(bad).room!.widthMm = 499;
    await expect(repo.projects.save(bad, project.storageRevision)).rejects.toThrow();
    expect(getActiveScene(await repo.projects.load(project.id)).room).toEqual(DEFAULT_ROOM);
    const saved = await repo.projects.save(
      { ...project, name: '새 이름', editRevision: 1 },
      project.storageRevision,
    );
    await expect(repo.projects.save(project, project.storageRevision)).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    expect((await repo.projects.load(project.id)).storageRevision).toBe(saved.storageRevision);
  });
  it('keeps old and new background assets through resize, clone, cleanup and removal of one shared project', async () => {
    const { repo, project, asset } = await setup();
    const nextImage = await asset();
    const scene = resizedRoomScene(
      getActiveScene(project),
      { ...DEFAULT_ROOM, widthMm: 3600 },
      { originalAssetId: nextImage, previewAssetId: nextImage, imageWidth: 4096, imageHeight: 2731 },
    );
    const resized = structuredClone(project);
    resized.roomHistory.past = {
      shared: structuredClone(project.shared),
      designs: structuredClone(project.designs),
      activeDesignId: project.activeDesignId,
      comparisonDesignIds: [],
      viewport: project.viewport,
    };
    resized.shared.baseline = structuredClone(scene);
    getActiveDesign(resized)!.scene = scene;
    resized.editRevision++;
    const saved = await repo.projects.save(resized, project.storageRevision);
    const clone = await repo.projects.duplicate(saved.id);
    expect(getActiveScene(clone).room?.widthMm).toBe(3600);
    expect(clone.roomHistory.past!.designs[0].scene.room?.widthMm).toBe(2400);
    await repo.projects.remove(saved.id);
    await repo.assets.removeUnused();
    expect((await repo.assets.get(nextImage)).id).toBe(nextImage);
    expect((await repo.assets.get(getActiveScene(project).originalAssetId)).id).toBe(
      getActiveScene(project).originalAssetId,
    );
    expect(getActiveScene(await repo.projects.load(clone.id))).toMatchObject({
      room: scene.room,
      originalAssetId: scene.originalAssetId,
    });
  });
});
