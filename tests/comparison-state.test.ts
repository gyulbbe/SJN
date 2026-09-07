import { createProjectFromLegacyFrame, getActiveDesign } from '../src/lib/designs';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/lib/editor-store';
import {
  captureProjectFrame,
  getEditingScene,
  normalizeProjectDocument,
  projectScenes,
} from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type LegacyProjectDocument as ProjectDocument,
  type Scene,
} from '../src/lib/types';
import { createQuote } from '../src/lib/quote';

function scene(): Scene {
  return {
    room: { ...DEFAULT_ROOM },
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: createRoomSurfaces(DEFAULT_ROOM),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}
function document(): ProjectDocument {
  const after = scene();
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '기존 공간 재구성',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scene: after,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    comparison: {
      before: scene(),
      room: { ...DEFAULT_ROOM },
      aspect: 1.5,
      cameraVersion: 1,
      referenceOriginalAssetId: crypto.randomUUID(),
      referencePreviewAssetId: crypto.randomUUID(),
      status: 'draft',
      review: { version: 1, analysis: 'manual', candidates: [], planes: [], warnings: ['배치 확인 필요'] },
    },
  };
}
beforeEach(() => useEditor.getState().load(document()));

describe('reconstructed comparison state', () => {
  it('opens a draft on After and changes Before only after an explicit selection, leaving After and quotation intact', () => {
    const p = useEditor.getState().project!;
    getActiveDesign(p)!.quote = createQuote(p, {});
    useEditor.getState().load(p);
    const after = structuredClone(getActiveDesign(p)!.scene);
    const quote = structuredClone(getActiveDesign(p)!.quote);
    expect(useEditor.getState().editing).toBe('after');
    useEditor.getState().setEditing('before');
    useEditor.getState().change((s) => (s.color.exposure = 0.4));
    const changed = useEditor.getState().project!;
    expect(getActiveDesign(changed)!.scene).toEqual(after);
    expect(getActiveDesign(changed)!.quote).toEqual(quote);
    expect(changed.shared.comparison!.before.color.exposure).toBe(0.4);
    expect(changed.shared.beforeHistory.past[0].comparison!.before.color.exposure).toBe(0);
    expect(getActiveDesign(changed)!.history.past).toHaveLength(0);
    useEditor.getState().setEditing('after');
    useEditor.getState().change((s) => (s.color.saturation = 0.6));
    expect(useEditor.getState().project!.shared.comparison!.before.color.saturation).toBe(1);
    expect(getActiveDesign(useEditor.getState().project!)!.scene.color.saturation).toBe(0.6);
  });
  it('commits repeated Before previews as one command, then restores both sides and review status', () => {
    const st = useEditor.getState();
    st.setEditing('before');
    st.preview((s) => (s.color.warmth = 0.1));
    st.preview((s) => (s.color.warmth = 0.3));
    expect(useEditor.getState().project!.shared.comparison!.before.color.warmth).toBe(0);
    expect(useEditor.getState().project!.editRevision).toBe(0);
    st.commit();
    st.changeProject((p) => {
      p.shared.comparison!.status = 'confirmed';
      p.shared.comparison!.review!.warnings = [];
    });
    expect(useEditor.getState().project!.shared.beforeHistory.past).toHaveLength(2);
    st.undo();
    expect(useEditor.getState().project!.shared.comparison!.status).toBe('draft');
    expect(useEditor.getState().editing).toBe('before');
    expect(useEditor.getState().project!.shared.comparison!.review!.warnings).toEqual(['배치 확인 필요']);
    st.undo();
    expect(useEditor.getState().project!.shared.comparison!.before.color.warmth).toBe(0);
    expect(getActiveDesign(useEditor.getState().project!)!.scene).not.toHaveProperty('comparison');
    st.redo();
    expect(useEditor.getState().project!.shared.comparison!.before.color.warmth).toBe(0.3);
    st.redo();
    expect(useEditor.getState().project!.shared.comparison!.status).toBe('confirmed');
    expect(useEditor.getState().editing).toBe('before');
  });
  it('updates shared room and independent restorations in one atomic resize and undo', () => {
    const p = document();
    p.scene.backgroundAssetId = crypto.randomUUID();
    p.comparison!.before.backgroundAssetId = crypto.randomUUID();
    p.scene.color.exposure = 0.1;
    p.comparison!.before.color.exposure = 0.4;
    useEditor.getState().load(p);
    const room = { ...DEFAULT_ROOM, widthMm: 3600, depthMm: 4000 };
    const assets = {
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 1200,
      imageHeight: 800,
    };
    useEditor.getState().resizeAll(room, assets);
    const changed = useEditor.getState().project!;
    expect(getActiveDesign(changed)!.scene.room).toEqual(room);
    expect(changed.shared.comparison!.before.room).toEqual(room);
    expect(getActiveDesign(changed)!.history.past).toHaveLength(0);
    expect(changed.roomHistory.past).toBeDefined();
    expect(getActiveDesign(changed)!.scene.backgroundAssetId).toBeUndefined();
    expect(changed.shared.comparison!.before.backgroundAssetId).toBeUndefined();
    expect(getActiveDesign(changed)!.scene.color.exposure).toBe(0.1);
    expect(changed.shared.comparison!.before.color.exposure).toBe(0.4);
    useEditor.getState().restoreRoomChange();
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(p.scene);
    expect(useEditor.getState().project!.shared.comparison).toEqual(p.comparison);
    useEditor.getState().redoRoomChange();
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(getActiveDesign(changed)!.scene);
    expect(useEditor.getState().project!.shared.comparison).toEqual(changed.shared.comparison);
  });
  it('rejects a partial shared resize before replacing the current editable document', () => {
    const p = structuredClone(useEditor.getState().project!);
    expect(() =>
      useEditor.getState().changeProject((next) => {
        next.shared.comparison!.room.widthMm = 3600;
      }),
    ).toThrow('공간 치수');
    expect(useEditor.getState().project).toEqual(p);
    expect(useEditor.getState().saveStatus).toBe('saved');
  });
  it('side selection and compare/zoom do not mutate either scene or editing revisions', () => {
    const st = useEditor.getState();
    const before = structuredClone(st.project!);
    st.preview((s) => (s.color.exposure = 0.5));
    st.cancel();
    st.select('selected');
    st.setEditing('after');
    expect(useEditor.getState().draft).toBeNull();
    expect(useEditor.getState().selection).toBeNull();
    expect(useEditor.getState().mode).toBe('after');
    st.setMode('split');
    st.setSplit(0.3);
    st.viewport(1.5, { x: 20, y: 10 });
    expect(useEditor.getState().editing).toBe('after');
    expect(getActiveDesign(useEditor.getState().project!)!.scene).toEqual(getActiveDesign(before)!.scene);
    expect(useEditor.getState().project!.shared.comparison).toEqual(before.shared.comparison);
    expect(useEditor.getState().project!.editRevision).toBe(before.editRevision);
  });
  it('retains fifty independent frames for each side and discards only its redo after a new edit', () => {
    const st = useEditor.getState();
    for (let i = 0; i < 112; i++) {
      st.setEditing(i % 2 ? 'after' : 'before');
      st.change((s) => (s.color.exposure = i / 200));
    }
    const p = useEditor.getState().project!;
    expect(getActiveDesign(p)!.history.past).toHaveLength(50);
    expect(p.shared.beforeHistory.past).toHaveLength(50);
    expect(projectScenes(p)).toHaveLength(153);
    expect(getActiveDesign(p)!.history.past.every((frame) => !('comparison' in frame))).toBe(true);
    st.undo();
    st.change((s) => (s.color.warmth = 0.2));
    expect(getActiveDesign(useEditor.getState().project!)!.history.future).toHaveLength(0);
  });
  it('upgrades v1 in memory without creating comparison, editing revisions, dirty status, or changing old frames', () => {
    const legacy = document();
    delete legacy.comparison;
    legacy.schemaVersion = 1;
    legacy.history.past = [structuredClone(legacy.scene)];
    useEditor.getState().load(legacy);
    const p = useEditor.getState().project!;
    expect(p.schemaVersion).toBe(3);
    expect(legacy.schemaVersion).toBe(1);
    expect(p.editRevision).toBe(0);
    expect(useEditor.getState().saveStatus).toBe('saved');
    expect(useEditor.getState().editing).toBe('after');
    expect(getEditingScene(p, 'before')).toBe(getActiveDesign(p)!.scene);
    expect(captureProjectFrame(p)).toEqual(legacy.scene);
    expect(normalizeProjectDocument(p)).toBe(p);
  });
  it.each(['legacy', 'before'] as const)(
    'keeps the selected fixture while undoing and redoing a %s view change',
    (mode) => {
      const p = document();
      if (mode === 'legacy') {
        delete p.comparison;
        delete p.scene.room;
        p.schemaVersion = 1;
      }
      const fixture: Scene['fixtures'][number] = {
        id: crypto.randomUUID(),
        name: '방향별 도기',
        materialVersionId: crypto.randomUUID(),
        viewIndex: 0,
        position: { x: 0.5, y: 0.5 },
        width: 0.2,
        height: 0.3,
        rotation: 0,
        anchor: { x: 0.5, y: 1 },
        locked: false,
        shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
        occlusion: EMPTY_MASK(),
        color: { ...DEFAULT_COLOR },
      };
      (p.comparison?.before ?? p.scene).fixtures.push(fixture);
      const st = useEditor.getState();
      st.load(p);
      if (mode === 'before') st.setEditing('before');
      st.select(fixture.id);
      st.change((scene) => {
        scene.fixtures[0].viewIndex = 1;
      });
      st.undo();
      expect(useEditor.getState().selection).toBe(fixture.id);
      expect(
        getEditingScene(useEditor.getState().project!, useEditor.getState().editing).fixtures[0].viewIndex,
      ).toBe(0);
      st.redo();
      expect(useEditor.getState().selection).toBe(fixture.id);
      expect(
        getEditingScene(useEditor.getState().project!, useEditor.getState().editing).fixtures[0].viewIndex,
      ).toBe(1);
    },
  );
  it('keeps selection across a shared project change and clears it when an old manually added face is removed', () => {
    const manual = document();
    delete manual.comparison!.before.surfaces[0].roomFace;
    manual.comparison!.before.surfaces[0].geometryMode = 'manual';
    useEditor.getState().load(manual);
    const st = useEditor.getState();
    const selected = st.project!.shared.comparison!.before.surfaces[0].id;
    st.setEditing('before');
    st.select(selected);
    st.changeProject((p) => {
      p.shared.comparison!.review!.warnings = [];
    });
    expect(useEditor.getState().selection).toBe(selected);
    st.undo();
    expect(useEditor.getState().selection).toBe(selected);
    st.redo();
    expect(useEditor.getState().selection).toBe(selected);
    st.changeProject((p) => {
      p.shared.comparison!.before.surfaces = p.shared.comparison!.before.surfaces.filter(
        (s) => s.id !== selected,
      );
    });
    expect(useEditor.getState().selection).toBeNull();
    st.undo();
    st.select(selected);
    st.redo();
    expect(useEditor.getState().selection).toBeNull();
  });
  it.each(['draft', 'confirmed'] as const)(
    'opens a saved %s project on After without rewriting either scene or its history',
    (status) => {
      const p = document();
      p.comparison!.status = status;
      p.comparison!.before.color.exposure = 0.4;
      p.scene.color.exposure = -0.2;
      p.history.past = [captureProjectFrame(structuredClone(p))];
      p.quote = createQuote(p, {});
      const snapshot = structuredClone(p);
      useEditor.getState().load(p);
      const state = useEditor.getState();
      expect(state.editing).toBe('after');
      expect(state.mode).toBe('after');
      expect(state.project).toEqual(normalizeProjectDocument(snapshot));
      expect(state.saveStatus).toBe('saved');
      expect(getEditingScene(state.project!, state.editing)).toBe(getActiveDesign(state.project!)!.scene);
      state.change((scene) => {
        scene.color.saturation = 0.3;
      });
      expect(useEditor.getState().project!.shared.comparison).toEqual(snapshot.comparison);
      expect(getActiveDesign(useEditor.getState().project!)!.scene.color.saturation).toBe(0.3);
      expect(getActiveDesign(useEditor.getState().project!)!.quote).toEqual(snapshot.quote);
    },
  );
  it('leaves a common review command out of After undo until Before is explicitly selected', () => {
    const p = document(),
      selected = p.scene.surfaces[0].id,
      st = useEditor.getState();
    st.load(p);
    st.changeProject((next) => {
      next.shared.comparison!.status = 'confirmed';
    });
    st.select(selected);
    st.undo();
    expect(useEditor.getState().editing).toBe('after');
    expect(useEditor.getState().selection).toBe(selected);
    expect(useEditor.getState().project!.shared.comparison!.status).toBe('confirmed');
    expect(getActiveDesign(useEditor.getState().project!)!.history.past).toHaveLength(0);
    st.setEditing('before');
    st.undo();
    expect(useEditor.getState().project!.shared.comparison!.status).toBe('draft');
    st.redo();
    expect(useEditor.getState().project!.shared.comparison!.status).toBe('confirmed');
  });
  it('archives an incompatible legacy comparison-removal frame without crossing that boundary in ordinary undo', () => {
    const p = document(),
      legacy = document();
    delete legacy.comparison;
    p.history.past = [captureProjectFrame(legacy)];
    const st = useEditor.getState();
    st.load(p);
    st.setEditing('before');
    st.select(p.comparison!.before.surfaces[0].id);
    const current = useEditor.getState().project!;
    st.undo();
    expect(useEditor.getState().project).toBe(current);
    expect(useEditor.getState().editing).toBe('before');
    const restored = createProjectFromLegacyFrame(current, current.shared.legacyHistory!.past[0]);
    expect(restored.id).not.toBe(current.id);
    expect(restored.shared.comparison).toBeUndefined();
    expect(getActiveDesign(restored)!.scene).toEqual(legacy.scene);
    expect(useEditor.getState().project).toBe(current);
  });
});
