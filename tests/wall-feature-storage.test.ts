import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  blankSceneFrom,
  captureWorkspace,
  getActiveDesign,
  normalizeProjectDocument,
  projectFrameError,
  projectScenes,
} from '../src/lib/comparison';
import { copyDesignDocument, createBlankDesign, duplicateProjectDocument } from '../src/lib/designs';
import { useEditor } from '../src/lib/editor-store';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { normalizeRoomScene, projectWallFeatureResizeError, resizedRoomScene } from '../src/lib/room-editing';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { legacyProjectSchema, projectV3Schema, storedProjectV3Schema } from '../src/lib/supabase/validation';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type LegacyProjectDocument,
  type ProjectDocument,
  type Scene,
} from '../src/lib/types';
import { resolveWallFeature, type WallFeatureV1 } from '../src/lib/wall-features';

const stamp = '2026-09-15T00:00:00.000Z';
function features(): WallFeatureV1[] {
  return [
    {
      version: 1,
      id: crypto.randomUUID(),
      kind: 'closed-niche',
      face: 'back',
      leftMm: 300,
      topMm: 300,
      widthMm: 400,
      heightMm: 500,
      depthMm: 180,
      source: 'user',
    },
    {
      version: 1,
      id: crypto.randomUUID(),
      kind: 'floor-alcove',
      face: 'back',
      leftMm: 1200,
      topMm: 400,
      widthMm: 500,
      depthMm: 250,
      source: 'user',
    },
  ];
}
function scene(): Scene {
  const image = crypto.randomUUID();
  return {
    originalAssetId: image,
    previewAssetId: image,
    imageWidth: 1200,
    imageHeight: 800,
    room: { ...DEFAULT_ROOM },
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function legacy(): LegacyProjectDocument {
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '벽 구조 저장 검사',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: stamp,
    updatedAt: stamp,
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    scene: scene(),
    history: { past: [], future: [] },
  };
}
function project(): ProjectDocument {
  const p = normalizeProjectDocument(legacy());
  p.shared.comparison = {
    before: structuredClone(p.shared.baseline),
    room: { ...DEFAULT_ROOM },
    aspect: 1.5,
    cameraVersion: 1,
    referenceOriginalAssetId: p.shared.baseline.originalAssetId,
    referencePreviewAssetId: p.shared.baseline.previewAssetId,
    status: 'draft',
  };
  p.shared.comparison.before.wallFeatures = features();
  return p;
}
function imageAssets() {
  const id = crypto.randomUUID();
  return { originalAssetId: id, previewAssetId: id, imageWidth: 1200, imageHeight: 800 };
}
function historicalProject(): ProjectDocument {
  const p = project();
  const value = features();
  p.shared.baseline.wallFeatures = structuredClone(value);
  p.designs[0].scene.wallFeatures = structuredClone(value);
  p.designs[0].history.past = [{ scene: structuredClone(p.designs[0].scene) }];
  p.designs[0].history.future = [{ scene: structuredClone(p.designs[0].scene) }];
  p.shared.beforeHistory.past = [
    { baseline: structuredClone(p.shared.baseline), comparison: structuredClone(p.shared.comparison) },
  ];
  p.shared.beforeHistory.future = structuredClone(p.shared.beforeHistory.past);
  p.shared.legacyHistory = { past: [structuredClone(p.designs[0].scene)], future: [] };
  p.roomHistory.past = captureWorkspace(p);
  return p;
}

describe('wall structure storage and state boundaries', () => {
  it('does not add an optional field to old scenes or turn their missing room into a requirement', () => {
    const p = legacy();
    delete p.scene.room;
    expect(legacyProjectSchema.parse(p)).toEqual(p);
    expect(
      projectScenes(storedProjectV3Schema.parse(normalizeProjectDocument(p))).every(
        (s) => !Object.hasOwn(s, 'wallFeatures'),
      ),
    ).toBe(true);
  });

  it('round-trips both variants through current, Before, design histories and room-change backups', () => {
    const p = historicalProject();
    const original = structuredClone(p);
    expect(projectV3Schema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(storedProjectV3Schema.parse(p)).toEqual(p);
    expect(projectFrameError(p)).toBeNull();
    expect(p).toEqual(original);
    const redoOnly = structuredClone(p);
    redoOnly.roomHistory = { future: redoOnly.roomHistory.past };
    expect(storedProjectV3Schema.parse(redoOnly)).toEqual(redoOnly);
  });

  it.each([
    'version',
    'source',
    'unknown-key',
    'floor-height',
    'missing-room',
    'too-deep',
    'duplicate-surface',
    'outside',
    'too-many',
  ] as const)('rejects malformed %s without stripping or fixing it', (problem) => {
    const p = project();
    const s = p.designs[0].scene;
    s.wallFeatures = features();
    const f = s.wallFeatures[0] as unknown as Record<string, unknown>;
    if (problem === 'version') f.version = 2;
    if (problem === 'source') f.source = 'model';
    if (problem === 'unknown-key') f.estimated = true;
    if (problem === 'floor-height') Object.assign(s.wallFeatures[1], { heightMm: 2000 });
    if (problem === 'missing-room') delete s.room;
    if (problem === 'too-deep') f.depthMm = 1001;
    if (problem === 'duplicate-surface') f.id = s.surfaces[0].id;
    if (problem === 'outside') f.widthMm = 5000;
    if (problem === 'too-many') s.wallFeatures = Array.from({ length: 25 }, () => ({ ...features()[0] }));
    const original = structuredClone(p);
    expect(projectV3Schema.safeParse(p).success).toBe(false);
    expect(projectFrameError(p)).not.toBeNull();
    expect(p).toEqual(original);
  });

  it('validates hidden design, room checkpoint and legacy combined frames against their own room', () => {
    for (const target of ['design-history', 'room-history', 'legacy'] as const) {
      const p = historicalProject();
      const s =
        target === 'design-history'
          ? p.designs[0].history.past[0].scene
          : target === 'room-history'
            ? p.roomHistory.past!.shared.baseline
            : p.shared.legacyHistory!.past[0];
      s.wallFeatures![0].widthMm = 5000;
      expect(storedProjectV3Schema.safeParse(p).success).toBe(false);
      expect(projectFrameError(p)).not.toBeNull();
    }
    const old = legacy();
    old.history.past = [{ ...structuredClone(old.scene), wallFeatures: features() }];
    old.history.past[0].wallFeatures![0].widthMm = 5000;
    expect(legacyProjectSchema.safeParse(old).success).toBe(false);
  });

  it('keeps structure out of blank After/new designs, but copies it with new stable entity IDs', () => {
    const p = historicalProject();
    // A workspace can share an entity object with an in-memory historical frame.
    p.designs[0].history.past[0].scene.wallFeatures = p.designs[0].scene.wallFeatures;
    const original = structuredClone(p);
    expect(blankSceneFrom(p.shared.comparison!.before)).not.toHaveProperty('wallFeatures');
    expect(createBlankDesign(p).scene).not.toHaveProperty('wallFeatures');
    const copy = copyDesignDocument(p.designs[0], '복사');
    expect(copy.history).toEqual({ past: [], future: [] });
    expect(copy.scene.wallFeatures!.map((f) => f.id)).not.toEqual(
      p.designs[0].scene.wallFeatures!.map((f) => f.id),
    );
    expect(copy.scene.wallFeatures!.map((f) => ({ ...f, id: 'remapped' }))).toEqual(
      p.designs[0].scene.wallFeatures!.map((f) => ({ ...f, id: 'remapped' })),
    );
    const duplicate = duplicateProjectDocument(p);
    const mapped = duplicate.designs[0].scene.wallFeatures!.map((f) => f.id);
    expect(mapped).not.toEqual(p.designs[0].scene.wallFeatures!.map((f) => f.id));
    expect(duplicate.designs[0].history.past[0].scene.wallFeatures!.map((f) => f.id)).toEqual(mapped);
    expect(duplicate.roomHistory.past!.designs[0].scene.wallFeatures!.map((f) => f.id)).toEqual(mapped);
    expect(duplicate.shared.legacyHistory!.past[0].wallFeatures!.map((f) => f.id)).toEqual(mapped);
    expect(duplicate.designs[0].scene.originalAssetId).toBe(p.designs[0].scene.originalAssetId);
    expect(projectFrameError(duplicate)).toBeNull();
    expect(p).toEqual(original);
  });

  it('persists all frames in isolated local storage and rejects invalid saves atomically', async () => {
    const p = historicalProject();
    const repo = createLocalRepositories('wall-features-test-' + crypto.randomUUID());
    for (const id of new Set(projectScenes(p).flatMap((s) => [s.originalAssetId, s.previewAssetId]))) {
      await repo.assets.put({
        id,
        ownerId: 'local',
        name: 'room.png',
        mime: 'image/png',
        size: 3,
        width: 1200,
        height: 800,
        kind: 'original',
        createdAt: stamp,
        blob: new Blob(['png'], { type: 'image/png' }),
      });
    }
    const saved = await repo.projects.create(p);
    expect(await repo.projects.load(saved.id)).toEqual(saved);
    const bad = structuredClone(saved);
    bad.roomHistory.past!.shared.baseline.wallFeatures![0].widthMm = 9000;
    await expect(repo.projects.save(bad, saved.storageRevision)).rejects.toThrow();
    expect(await repo.projects.load(saved.id)).toEqual(saved);
  });

  it('edits and removes Before structure with undo/redo while leaving After empty', () => {
    useEditor.getState().load(project());
    useEditor.getState().setEditing('before');
    const before = structuredClone(useEditor.getState().project!);
    useEditor.getState().change((s) => {
      s.wallFeatures![0].depthMm = 220;
    });
    expect(useEditor.getState().project!.shared.comparison!.before.wallFeatures![0].depthMm).toBe(220);
    expect(getActiveDesign(useEditor.getState().project!)!.scene).not.toHaveProperty('wallFeatures');
    useEditor.getState().undo();
    expect(useEditor.getState().project!.shared.comparison!.before).toEqual(before.shared.comparison!.before);
    useEditor.getState().redo();
    useEditor.getState().change((s) => {
      delete s.wallFeatures;
    });
    expect(useEditor.getState().project!.shared.comparison!.before).not.toHaveProperty('wallFeatures');
    useEditor.getState().undo();
    expect(useEditor.getState().project!.shared.comparison!.before.wallFeatures![0].depthMm).toBe(220);
  });

  it('invalidates only the edited design render cache for a structure edit', () => {
    const p = project();
    const design = p.designs[0];
    design.thumbnailAssetId = crypto.randomUUID();
    design.renderRevision = 4;
    useEditor.getState().load(p);
    useEditor.getState().change((s) => {
      s.wallFeatures = features();
    });
    const updated = getActiveDesign(useEditor.getState().project!)!;
    expect(updated.renderRevision).toBe(5);
    expect(updated.thumbnailAssetId).toBeUndefined();
    expect(useEditor.getState().project!.shared.comparison).toEqual(p.shared.comparison);
  });

  it('preserves millimetres on resize, derives alcove height, and restores the original room backup', () => {
    const p = historicalProject();
    const room = { ...DEFAULT_ROOM, widthMm: 3000, heightMm: 3000 };
    const original = structuredClone(p);
    expect(projectWallFeatureResizeError(p, room)).toBeNull();
    const resized = resizedRoomScene(p.designs[0].scene, room, imageAssets());
    expect(resized.wallFeatures).toEqual(p.designs[0].scene.wallFeatures);
    expect(resolveWallFeature(room, resized.wallFeatures![1]).heightMm).toBe(2600);
    expect(p).toEqual(original);
    useEditor.getState().load(p);
    useEditor.getState().resizeAll(room, imageAssets());
    const changed = useEditor.getState().project!;
    expect(changed.designs[0].scene.wallFeatures).toEqual(p.designs[0].scene.wallFeatures);
    expect(changed.shared.comparison!.before.wallFeatures).toEqual(p.shared.comparison!.before.wallFeatures);
    expect(changed.roomHistory.past!.designs[0].scene.room).toEqual(DEFAULT_ROOM);
    expect(storedProjectV3Schema.safeParse(changed).success).toBe(true);
    useEditor.getState().restoreRoomChange();
    expect(useEditor.getState().project!.designs[0].scene).toEqual(p.designs[0].scene);
  });

  it('rejects a hidden active-scene overflow before committing a pending draft or replacing assets', () => {
    const p = project();
    delete p.shared.comparison!.before.wallFeatures;
    const hidden = createBlankDesign(p);
    hidden.scene.wallFeatures = features();
    p.designs.push(hidden);
    useEditor.getState().load(p);
    useEditor.getState().preview((s) => {
      s.color.exposure = 0.2;
    });
    const previous = useEditor.getState().project;
    const draft = useEditor.getState().draft;
    const room = { ...DEFAULT_ROOM, widthMm: 1500 };
    expect(projectWallFeatureResizeError(p, room)).toContain(hidden.name);
    useEditor.getState().resizeAll(room, imageAssets());
    expect(useEditor.getState().project).toBe(previous);
    expect(useEditor.getState().draft).toBe(draft);
    expect(useEditor.getState().error).toBeTruthy();
  });

  it('does not apply the new room to historical frames or silently normalize an invalid feature', () => {
    const p = project();
    delete p.shared.comparison!.before.wallFeatures;
    p.designs[0].history.past = [
      { scene: { ...structuredClone(p.designs[0].scene), wallFeatures: features() } },
    ];
    expect(projectWallFeatureResizeError(p, { ...DEFAULT_ROOM, widthMm: 1000 })).toBeNull();
    const previous = scene(),
      next = structuredClone(previous);
    next.wallFeatures = features();
    next.wallFeatures[0].leftMm = -1;
    const original = structuredClone(next);
    expect(() => normalizeRoomScene(previous, next)).toThrow();
    expect(next).toEqual(original);
  });
});
