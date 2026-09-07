import { getActiveDesign } from '../src/lib/designs';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/lib/editor-store';
import { captureProjectFrame, getEditingScene } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { applyRoomSurfaceBand } from '../src/lib/room-surface-bands';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type FixtureInstance,
  type LegacyProjectDocument as ProjectDocument,
  type Scene,
} from '../src/lib/types';

function scene(): Scene {
  const surfaces = createRoomSurfaces(DEFAULT_ROOM, 1.5);
  const wall = surfaces.find((surface) => surface.roomFace === 'back')!;
  const index = surfaces.indexOf(wall);
  surfaces.splice(
    index,
    1,
    applyRoomSurfaceBand(wall, { from: 0, to: 0.4 }),
    applyRoomSurfaceBand({ ...structuredClone(wall), id: crypto.randomUUID() }, { from: 0.4, to: 1 }),
  );
  surfaces.forEach((surface) => {
    surface.materialVersionId = crypto.randomUUID();
  });
  return {
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    room: { ...DEFAULT_ROOM },
    surfaces,
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function fixture(locked = false): FixtureInstance {
  return {
    id: crypto.randomUUID(),
    name: '사용자 제품',
    materialVersionId: crypto.randomUUID(),
    viewIndex: 0,
    position: { x: 0.5, y: 0.6 },
    width: 0.1,
    height: 0.2,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked,
    shadow: { x: 0, y: 0, opacity: 0.2, blur: 0.01, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function project(): ProjectDocument {
  const after = scene(),
    before = scene();
  after.fixtures.push(fixture());
  before.fixtures.push(fixture());
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '고정된 기본 공간',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 1,
    scene: after,
    comparison: {
      before,
      room: { ...DEFAULT_ROOM },
      aspect: 1.5,
      cameraVersion: 1,
      referenceOriginalAssetId: crypto.randomUUID(),
      referencePreviewAssetId: crypto.randomUUID(),
      status: 'draft',
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: '2026-09-06',
    updatedAt: '2026-09-06',
  };
}
beforeEach(() => useEditor.getState().load(project()));

describe('fixed room faces and explicit product removal', () => {
  it.each(['change', 'preview', 'commit', 'changeProject'] as const)(
    'keeps all four room faces and both wall bands when %s attempts to delete them',
    (command) => {
      const st = useEditor.getState(),
        original = structuredClone(st.project!);
      if (command === 'change')
        st.change((s) => {
          s.surfaces = [];
        });
      if (command === 'preview')
        st.preview((s) => {
          s.surfaces = [];
        });
      if (command === 'commit') {
        const draft = structuredClone(getActiveDesign(original)!.scene);
        draft.surfaces = [];
        useEditor.setState({ draft });
        st.commit();
      }
      if (command === 'changeProject')
        st.changeProject((p) => {
          getActiveDesign(p)!.scene.surfaces = [];
          p.shared.comparison!.before.surfaces = [];
        });
      const state = useEditor.getState();
      expect((state.draft ?? getActiveDesign(state.project!)!.scene).surfaces).toEqual(
        getActiveDesign(original)!.scene.surfaces,
      );
      expect(state.project!.shared.comparison!.before.surfaces).toEqual(
        original.shared.comparison!.before.surfaces,
      );
      expect(new Set(getActiveDesign(original)!.scene.surfaces.map((s) => s.roomFace)).size).toBe(4);
      expect(getActiveDesign(original)!.scene.surfaces.filter((s) => s.reconstructionBand)).toHaveLength(2);
    },
  );
  it('allows clearing a tile material and keeps the face, band and stored mask intact', () => {
    const st = useEditor.getState(),
      before = structuredClone(getActiveDesign(st.project!)!.scene.surfaces);
    st.change((s) => {
      delete s.surfaces[0].materialVersionId;
    });
    expect(getActiveDesign(useEditor.getState().project!)!.scene.surfaces).toEqual(
      before.map((surface, index) => {
        if (index !== 0) return surface;
        const next = { ...surface };
        delete next.materialVersionId;
        return next;
      }),
    );
    st.undo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.surfaces).toEqual(before);
  });
  it('permits Before reconstruction to replace faces when it supplies a new background source', () => {
    const st = useEditor.getState(),
      previous = structuredClone(st.project!);
    const replacement = scene();
    st.changeProject((p) => {
      p.shared.comparison!.before = replacement;
    });
    expect(useEditor.getState().project!.shared.comparison!.before.surfaces).toEqual(replacement.surfaces);
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(getActiveDesign(previous)!.scene);
    st.setEditing('before');
    st.undo();
    expect(useEditor.getState().project!.shared.comparison).toEqual(previous.shared.comparison);
    st.redo();
    expect(useEditor.getState().project!.shared.comparison!.before.surfaces).toEqual(replacement.surfaces);
  });
  it('permits an atomic room resize to update every linked face and preserves their band IDs', () => {
    const st = useEditor.getState(),
      previous = structuredClone(st.project!);
    const room = { ...DEFAULT_ROOM, widthMm: 3000 },
      canonical = createRoomSurfaces(room, 1.5);
    st.resizeAll(room, {
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 1200,
      imageHeight: 800,
    });
    const changed = getActiveDesign(useEditor.getState().project!)!.scene;
    expect(changed.surfaces.map((surface) => surface.id)).toEqual(
      getActiveDesign(previous)!.scene.surfaces.map((surface) => surface.id),
    );
    for (const surface of changed.surfaces)
      expect(surface.quad).toEqual(canonical.find((item) => item.roomFace === surface.roomFace)!.quad);
    expect(changed.surfaces.filter((surface) => surface.reconstructionBand)).toHaveLength(2);
    expect(useEditor.getState().project!.shared.comparison!.before.room).toEqual(room);
    st.restoreRoomChange();
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(getActiveDesign(previous)!.scene);
  });
  it.each(['before', 'after'] as const)(
    'removes only the %s product in one undo command and clears selection',
    (side) => {
      const st = useEditor.getState(),
        original = structuredClone(st.project!);
      st.setEditing(side);
      const target = getEditingScene(original, side).fixtures[0].id;
      st.select(target);
      st.removeFixture(target);
      const changed = useEditor.getState().project!;
      expect(getEditingScene(changed, side).fixtures).toHaveLength(0);
      expect(getEditingScene(changed, side === 'after' ? 'before' : 'after')).toEqual(
        getEditingScene(original, side === 'after' ? 'before' : 'after'),
      );
      expect(
        side === 'before' ? changed.shared.beforeHistory.past : getActiveDesign(changed)!.history.past,
      ).toHaveLength(1);
      expect(changed.editRevision).toBe(1);
      expect(useEditor.getState().selection).toBeNull();
      st.removeFixture(target);
      expect(useEditor.getState().project).toBe(changed);
      st.undo();
      expect(getEditingScene(useEditor.getState().project!, side)).toEqual(getEditingScene(original, side));
      st.redo();
      expect(getEditingScene(useEditor.getState().project!, side).fixtures).toHaveLength(0);
    },
  );
  it.each(['surface', 'missing', 'locked', 'draft', 'before', 'split'] as const)(
    'does nothing when product removal is requested for %s',
    (guard) => {
      const st = useEditor.getState();
      if (guard === 'locked') getActiveDesign(st.project!)!.scene.fixtures[0].locked = true;
      if (guard === 'draft')
        st.preview((s) => {
          s.color.exposure = 0.3;
        });
      if (guard === 'before' || guard === 'split') st.setMode(guard);
      const id =
        guard === 'surface'
          ? getActiveDesign(st.project!)!.scene.surfaces[0].id
          : guard === 'missing'
            ? 'missing'
            : getActiveDesign(st.project!)!.scene.fixtures[0].id;
      st.select(id);
      const state = useEditor.getState(),
        saved = state.project,
        draft = state.draft;
      st.removeFixture(id);
      expect(useEditor.getState().project).toBe(saved);
      expect(useEditor.getState().draft).toBe(draft);
      expect(useEditor.getState().selection).toBe(id);
      expect(useEditor.getState().saveStatus).toBe('saved');
    },
  );
  it('does not recreate missing faces when loading old data or restoring an existing undo frame', () => {
    const p = project();
    p.scene.surfaces = p.scene.surfaces.slice(0, 1);
    const historical = structuredClone(p);
    historical.scene.surfaces = [];
    p.history.past = [captureProjectFrame(historical)];
    useEditor.getState().load(p);
    expect(getActiveDesign(useEditor.getState().project!)!.scene.surfaces).toEqual(p.scene.surfaces);
    expect(useEditor.getState().saveStatus).toBe('saved');
    useEditor.getState().undo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.surfaces).toEqual([]);
    useEditor.getState().redo();
    expect(getActiveDesign(useEditor.getState().project!)!.scene.surfaces).toEqual(p.scene.surfaces);
  });
});
