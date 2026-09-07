import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { captureWorkspace, normalizeProjectDocument, projectWriteError } from '../src/lib/comparison';
import { createBlankDesign, copyDesignDocument, DESIGN_LIMIT_MESSAGE, MAX_DESIGNS } from '../src/lib/designs';
import { useEditor } from '../src/lib/editor-store';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { projectV3Schema, storedProjectV3Schema } from '../src/lib/supabase/validation';
import { DEFAULT_COLOR, EMPTY_MASK } from '../src/lib/types';

async function existing(count = 6) {
  const databaseName = 'five-design-compat-' + crypto.randomUUID();
  const repo = createLocalRepositories(databaseName),
    assetId = crypto.randomUUID();
  const now = new Date().toISOString();
  await repo.assets.put({
    id: assetId,
    ownerId: 'local',
    name: 'room.png',
    mime: 'image/png',
    size: 3,
    width: 1200,
    height: 800,
    kind: 'original',
    createdAt: now,
    blob: new Blob(['png']),
  });
  const project = normalizeProjectDocument({
    schemaVersion: 2,
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '기존 프로젝트',
    createdAt: now,
    updatedAt: now,
    editRevision: 0,
    storageRevision: 1,
    scene: {
      originalAssetId: assetId,
      previewAssetId: assetId,
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: [],
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  });
  while (project.designs.length < count)
    project.designs.push(createBlankDesign(project, '기존 ' + project.designs.length));
  // The previous release could save six to ten designs. Seed that prior stored revision directly.
  const db = await openDB(databaseName);
  await db.put('projects', project);
  db.close();
  return { repo, project };
}

describe('five-design limit without losing previously saved work', () => {
  it('enforces five for new documents including oversized checkpoints', async () => {
    const { repo, project } = await existing();
    expect(MAX_DESIGNS).toBe(5);
    expect(projectV3Schema.safeParse(project).success).toBe(false);
    expect(storedProjectV3Schema.safeParse(project).success).toBe(true);
    expect(projectWriteError(project)).toBe(DESIGN_LIMIT_MESSAGE);
    const fresh = structuredClone(project);
    fresh.id = crypto.randomUUID();
    await expect(repo.projects.create(fresh)).rejects.toThrow(DESIGN_LIMIT_MESSAGE);
    fresh.roomHistory = { past: captureWorkspace(project) };
    fresh.designs = fresh.designs.slice(0, 5);
    await expect(repo.projects.create(fresh)).rejects.toThrow(DESIGN_LIMIT_MESSAGE);
  });
  it('opens old six-design work without rewriting it and saves edits while rejecting new IDs', async () => {
    const { repo, project } = await existing();
    expect(await repo.projects.load(project.id)).toEqual(project);
    const changed = structuredClone(project);
    changed.designs[0].name = '이름 수정';
    const saved = await repo.projects.save(changed, project.storageRevision);
    expect(saved.designs.map((d) => d.id)).toEqual(project.designs.map((d) => d.id));
    const expanded = structuredClone(saved);
    expanded.designs.push(copyDesignDocument(saved.designs[0]));
    await expect(repo.projects.save(expanded, saved.storageRevision)).rejects.toThrow(DESIGN_LIMIT_MESSAGE);
    const replaced = structuredClone(saved);
    replaced.designs[5] = copyDesignDocument(saved.designs[5]);
    await expect(repo.projects.save(replaced, saved.storageRevision)).rejects.toThrow(DESIGN_LIMIT_MESSAGE);
    expect(await repo.projects.load(project.id)).toEqual(saved);
  });
  it('allows reducing old designs and creating again only below five', async () => {
    const { project } = await existing(7);
    useEditor.getState().load(project);
    expect(useEditor.getState().createDesign()).toBeNull();
    expect(useEditor.getState().copyDesign()).toBeNull();
    useEditor.getState().change((s) => {
      s.color.exposure = 0.4;
    });
    expect(useEditor.getState().project!.designs[0].scene.color.exposure).toBe(0.4);
    for (const d of project.designs.slice(4)) useEditor.getState().deleteDesign(d.id);
    expect(useEditor.getState().project!.designs).toHaveLength(4);
    expect(useEditor.getState().createDesign()).toBeTruthy();
    expect(useEditor.getState().project!.designs).toHaveLength(5);
    expect(useEditor.getState().copyDesign()).toBeNull();
  });
  it('retains and restores the actual old oversized checkpoint without authorizing invented designs', async () => {
    const { repo, project } = await existing();
    const reduced = structuredClone(project);
    reduced.roomHistory = { past: captureWorkspace(project) };
    reduced.designs = reduced.designs.slice(0, 5);
    const saved = await repo.projects.save(reduced, project.storageRevision);
    useEditor.getState().load(saved);
    useEditor.getState().restoreRoomChange();
    const restored = useEditor.getState().project!;
    expect(restored.designs.map((d) => d.id)).toEqual(project.designs.map((d) => d.id));
    const written = await repo.projects.save(restored, saved.storageRevision);
    const forged = structuredClone(written);
    forged.roomHistory = { past: captureWorkspace(project) };
    forged.roomHistory.past!.designs.at(-1)!.id = crypto.randomUUID();
    await expect(repo.projects.save(forged, written.storageRevision)).rejects.toThrow(DESIGN_LIMIT_MESSAGE);
    useEditor.getState().load(written);
    useEditor.getState().redoRoomChange();
    expect(useEditor.getState().project!.designs).toHaveLength(5);
    await expect(
      repo.projects.save(useEditor.getState().project!, written.storageRevision),
    ).resolves.toMatchObject({ designs: expect.any(Array) });
  });
});
