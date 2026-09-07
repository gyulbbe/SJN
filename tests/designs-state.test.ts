import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/lib/editor-store';
import { createQuote, quoteSourceSignature } from '../src/lib/quote';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type LegacyProjectDocument,
  type ProjectDocument,
  type Scene,
  type WorkspaceSnapshot,
} from '../src/lib/types';
import {
  captureProjectFrame,
  captureWorkspace,
  normalizeProjectDocument,
  projectFrameError,
  projectScenes,
} from '../src/lib/comparison';
import {
  COMPARISON_LIMIT_MESSAGE,
  DESIGN_LIMIT_MESSAGE,
  duplicateProjectDocument,
  getActiveDesign,
  getActiveScene,
} from '../src/lib/designs';

function legacy(): LegacyProjectDocument {
  const scene: Scene = {
    room: { ...DEFAULT_ROOM },
    originalAssetId: crypto.randomUUID(),
    previewAssetId: crypto.randomUUID(),
    imageWidth: 1200,
    imageHeight: 800,
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
  scene.surfaces[0].materialVersionId = crypto.randomUUID();
  scene.fixtures.push({
    id: crypto.randomUUID(),
    name: '변기',
    materialVersionId: crypto.randomUUID(),
    viewIndex: 0,
    position: { x: 0.6, y: 0.6 },
    width: 0.1,
    height: 0.2,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0.2, blur: 0.01, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  });
  const before = structuredClone(scene);
  before.color.exposure = -0.3;
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '다중 시안',
    schemaVersion: 2,
    editRevision: 4,
    storageRevision: 2,
    scene,
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
    createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z',
  };
}
const p = () => useEditor.getState().project!;
const active = () => getActiveDesign(p())!;
const newAssets = () => ({
  originalAssetId: crypto.randomUUID(),
  previewAssetId: crypto.randomUUID(),
  imageWidth: 1200,
  imageHeight: 800,
});
const content = (workspace: WorkspaceSnapshot) => {
  const copy = structuredClone(workspace);
  copy.shared.revision = 0;
  copy.designs.forEach((design) => {
    design.revision = 0;
    delete design.renderRevision;
  });
  return copy;
};
beforeEach(() => useEditor.getState().load(legacy()));

describe('canonical independent design documents', () => {
  it.each([1, 2] as const)(
    'purely and deterministically migrates schema %s without legacy aliases or changing source data',
    (schemaVersion) => {
      const source = legacy();
      source.schemaVersion = schemaVersion;
      source.quote = createQuote(source, {});
      const original = structuredClone(source),
        a = normalizeProjectDocument(source),
        b = normalizeProjectDocument(source);
      expect(a).toEqual(b);
      expect(source).toEqual(original);
      expect(a).not.toHaveProperty('scene');
      expect(a).not.toHaveProperty('quote');
      expect(a).not.toHaveProperty('history');
      expect(a.designs[0].scene).toEqual(source.scene);
      expect(a.designs[0].quote).toEqual(source.quote);
      expect(a.shared.comparison).toEqual(source.comparison);
      expect(a.editRevision).toBe(source.editRevision);
      expect(a.shared.baseline.fixtures).toEqual([]);
      expect(a.shared.baseline.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
      expect(projectFrameError(a)).toBeNull();
    },
  );
  it('creates a blank design from the common frame and reuses the first available A–E default name', () => {
    const st = useEditor.getState(),
      shared = structuredClone(p().shared),
      sourceId = active().id;
    const id = st.createDesign()!;
    expect(active().id).toBe(id);
    expect(active().name).toBe('시안 B');
    expect(active().scene.fixtures).toEqual([]);
    expect(active().scene.surfaces).toHaveLength(4);
    expect(active().scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
    expect(active().scene.originalAssetId).toBe(shared.baseline.originalAssetId);
    expect(p().shared).toEqual(shared);
    st.deleteDesign(sourceId);
    st.createDesign();
    expect(active().name).toBe('시안 A');
  });
  it('copies the latest draft and manually edited quote with fresh entity IDs and an independent empty history', () => {
    const st = useEditor.getState(),
      sourceId = active().id;
    const quote = createQuote(p(), {});
    quote.lines[0].unitPrice = 45000;
    quote.lines[0].quantityMode = 'manual';
    quote.lines[0].quantity = 23;
    quote.lines[0].note = '현장 협의';
    quote.discount = 17000;
    quote.customerName = '기존 고객';
    st.quoteChanged(quote);
    st.preview((scene) => {
      scene.color.exposure = 0.45;
      scene.fixtures[0].position.x = 0.77;
    });
    const copiedId = st.copyDesign()!,
      source = p().designs.find((design) => design.id === sourceId)!,
      copy = active();
    expect(copy.id).toBe(copiedId);
    expect(copy.sourceDesignId).toBe(sourceId);
    expect(copy.history).toEqual({ past: [], future: [] });
    expect(copy.scene.color.exposure).toBe(0.45);
    expect(source.scene.color.exposure).toBe(0.45);
    expect(copy.scene.fixtures[0].position.x).toBe(0.77);
    expect(copy.scene.fixtures[0].id).not.toBe(source.scene.fixtures[0].id);
    expect(copy.scene.fixtures[0].materialVersionId).toBe(source.scene.fixtures[0].materialVersionId);
    expect(copy.scene.originalAssetId).toBe(source.scene.originalAssetId);
    expect(copy.quote!.id).not.toBe(source.quote!.id);
    expect(copy.quote!.number).not.toBe(source.quote!.number);
    expect(copy.quote!.lines[0]).toMatchObject({
      unitPrice: 45000,
      quantityMode: 'manual',
      quantity: 23,
      note: '현장 협의',
    });
    expect(copy.quote!.discount).toBe(17000);
    expect(copy.quote!.customerName).toBe('기존 고객');
    expect(copy.quote!.lines[0].sourceSurfaceIds).toEqual([copy.scene.surfaces[0].id]);
    expect(copy.quote!.sourceSignature).toBe(quoteSourceSignature(copy.scene));
    st.change((scene) => {
      scene.color.exposure = 0.1;
    });
    expect(p().designs.find((design) => design.id === sourceId)!.scene.color.exposure).toBe(0.45);
  });
  it('does not hide an already stale quotation when copying a design', () => {
    const st = useEditor.getState();
    st.quoteChanged(createQuote(p(), {}));
    st.change((scene) => {
      scene.surfaces[0].materialVersionId = crypto.randomUUID();
    });
    expect(active().quote!.sourceSignature).not.toBe(quoteSourceSignature(active().scene));
    st.copyDesign();
    expect(active().quote!.sourceSignature).not.toBe(quoteSourceSignature(active().scene));
  });
  it('enforces the five-design and five-comparison limits in the central commands without partial changes', () => {
    const st = useEditor.getState();
    for (let i = 0; i < 4; i++) st.createDesign();
    const atLimit = p();
    expect(st.createDesign()).toBeNull();
    expect(st.copyDesign()).toBeNull();
    expect(p()).toBe(atLimit);
    expect(useEditor.getState().error).toBe(DESIGN_LIMIT_MESSAGE);
    const ids = p().designs.map((design) => design.id);
    ids.slice(0, 5).forEach(st.toggleDesignComparison);
    // A sixth design is deliberately injected only to exercise the comparison guard independently.
    const extra = { ...structuredClone(active()), id: crypto.randomUUID() };
    useEditor.setState({ project: { ...p(), designs: [...p().designs, extra] } });
    const compared = p();
    st.toggleDesignComparison(extra.id);
    expect(p()).toBe(compared);
    expect(useEditor.getState().error).toBe(COMPARISON_LIMIT_MESSAGE);
    st.toggleDesignComparison(ids[0]);
    st.toggleDesignComparison(extra.id);
    expect(p().comparisonDesignIds).toHaveLength(5);
  });
  it('keeps design undo and quotation edits independent from other designs and common Before', () => {
    const st = useEditor.getState(),
      a = active().id;
    st.change((scene) => {
      scene.color.exposure = 0.2;
    });
    const quote = createQuote(p(), {});
    quote.customerName = '시안 A 고객';
    st.quoteChanged(quote);
    const b = st.createDesign()!;
    st.change((scene) => {
      scene.color.exposure = 0.9;
    });
    const other = structuredClone(active()),
      before = structuredClone(p().shared),
      revision = p().editRevision;
    st.selectDesign(a);
    expect(p().editRevision).toBe(revision);
    st.undo();
    expect(active().quote).toBeUndefined();
    expect(active().scene.color.exposure).toBe(0.2);
    st.undo();
    expect(active().scene.color.exposure).toBe(0);
    expect(p().designs.find((design) => design.id === b)).toEqual(other);
    expect(p().shared).toEqual(before);
    st.redo();
    st.redo();
    expect(active().quote!.customerName).toBe('시안 A 고객');
  });
  it('records common Before edits in Before history even when changeProject is called while editing After', () => {
    const st = useEditor.getState(),
      designs = structuredClone(p().designs),
      before = structuredClone(p().shared.comparison);
    st.changeProject((project) => {
      project.shared.comparison!.before.color.warmth = 0.7;
    });
    expect(p().designs).toEqual(designs);
    expect(p().shared.beforeHistory.past).toHaveLength(1);
    st.undo();
    expect(p().shared.comparison!.before.color.warmth).toBe(0.7);
    st.setEditing('before');
    st.undo();
    expect(p().shared.comparison).toEqual(before);
    st.redo();
    expect(p().shared.comparison!.before.color.warmth).toBe(0.7);
    expect(p().designs).toEqual(designs);
  });
  it('supports zero designs without writing into the baseline fallback', () => {
    const st = useEditor.getState(),
      shared = structuredClone(p().shared);
    st.deleteDesign(active().id);
    const empty = p();
    expect(empty.activeDesignId).toBeNull();
    expect(empty.designs).toEqual([]);
    expect(getActiveScene(empty)).toBe(empty.shared.baseline);
    st.change((scene) => {
      scene.color.exposure = 1;
    });
    st.preview((scene) => {
      scene.color.exposure = 1;
    });
    st.quoteChanged(createQuote(empty, {}));
    expect(p()).toBe(empty);
    expect(p().shared).toEqual(shared);
    expect(useEditor.getState().draft).toBeNull();
    st.createDesign();
    expect(active().name).toBe('시안 A');
    expect(active().scene.color.exposure).toBe(0);
  });
  it('retains only the current-frame segment as independent history and preserves all old frames as a referenced archive', () => {
    const source = legacy(),
      older = structuredClone(source);
    older.scene.room!.widthMm = 3600;
    older.comparison!.room.widthMm = 3600;
    older.comparison!.before.room!.widthMm = 3600;
    const currentFrame = structuredClone(captureProjectFrame(source));
    currentFrame.color.exposure = -0.7;
    source.history.past = [captureProjectFrame(older), currentFrame];
    const migrated = normalizeProjectDocument(source);
    expect(migrated.designs[0].history.past).toHaveLength(1);
    expect(migrated.shared.legacyHistory).toEqual(source.history);
    expect(projectScenes(migrated).some((scene) => scene.room?.widthMm === 3600)).toBe(true);
    stLoad(migrated);
    useEditor.getState().undo();
    expect(active().scene.color.exposure).toBe(-0.7);
    useEditor.getState().undo();
    expect(active().scene.room!.widthMm).toBe(DEFAULT_ROOM.widthMm);
  });
});
function stLoad(project: ProjectDocument) {
  useEditor.getState().load(project);
}

describe('one complete shared room checkpoint, isolated from design undo', () => {
  it('resizes every design, preserves the archived quote unchanged, and starts new local histories', () => {
    const st = useEditor.getState();
    const quote = createQuote(p(), {});
    quote.lines[0].unitPrice = 31000;
    quote.lines[0].quantityMode = 'manual';
    quote.lines[0].quantity = 17;
    quote.discount = 4000;
    st.quoteChanged(quote);
    st.copyDesign();
    st.change((scene) => {
      scene.color.exposure = 0.5;
    });
    const before = captureWorkspace(p());
    const room = { ...DEFAULT_ROOM, widthMm: 3000 };
    st.resizeAll(room, newAssets());
    expect(p().shared.baseline.room).toEqual(room);
    expect(p().shared.comparison!.room).toEqual(room);
    expect(
      p().designs.every((design) => design.scene.room!.widthMm === 3000 && design.history.past.length === 0),
    ).toBe(true);
    expect(p().designs.map((design) => design.quote)).toEqual(before.designs.map((design) => design.quote));
    expect(active().quote).toMatchObject({
      discount: 4000,
      lines: [
        expect.objectContaining({ unitPrice: 31000, quantity: 17, quantityMode: 'manual' }),
        expect.anything(),
      ],
    });
    expect(p().roomHistory.past).toEqual(before);
    expect(p().roomHistory.past).not.toHaveProperty('roomHistory');
    const resized = p();
    st.undo();
    expect(p()).toBe(resized);
  });
  it('exactly restores all scenes, quotes, masks and design creation/deletion and redoes the latest post-resize workspace', () => {
    const st = useEditor.getState();
    const a = active().id;
    st.quoteChanged(createQuote(p(), {}));
    st.change((scene) => {
      scene.protection.polygon = [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.1 },
        { x: 0.2, y: 0.2 },
      ];
    });
    const before = captureWorkspace(p()),
      room = { ...DEFAULT_ROOM, depthMm: 3000 };
    st.resizeAll(room, newAssets());
    const c = st.createDesign()!;
    st.change((scene) => {
      scene.color.exposure = 0.6;
    });
    const quote = createQuote(p(), {});
    quote.customerName = '변경 이후 고객';
    st.quoteChanged(quote);
    st.deleteDesign(a);
    expect(p().roomHistory.past!.designs.some((design) => design.id === a)).toBe(true);
    const latest = captureWorkspace(p()),
      revision = p().editRevision,
      storageRevision = p().storageRevision;
    st.restoreRoomChange();
    expect(content(captureWorkspace(p()))).toEqual(content(before));
    expect(p().editRevision).toBeGreaterThan(revision);
    expect(p().storageRevision).toBe(storageRevision);
    expect(p().roomHistory.past).toBeUndefined();
    expect(p().roomHistory.future).toEqual(latest);
    st.redoRoomChange();
    expect(content(captureWorkspace(p()))).toEqual(content(latest));
    expect(active().id).toBe(c);
    expect(active().quote!.customerName).toBe('변경 이후 고객');
    expect(p().roomHistory.future).toBeUndefined();
    expect(projectFrameError(p())).toBeNull();
  });
  it('keeps common redo through view changes but clears it after a new design or quote edit', () => {
    const st = useEditor.getState();
    st.resizeAll({ ...DEFAULT_ROOM, widthMm: 3200 }, newAssets());
    st.restoreRoomChange();
    const future = p().roomHistory.future;
    st.viewport(1.2, { x: 5, y: 9 });
    st.selectDesign(active().id);
    st.toggleDesignComparison(active().id);
    expect(p().roomHistory.future).toBe(future);
    st.quoteChanged(createQuote(p(), {}));
    expect(p().roomHistory.future).toBeUndefined();
  });
  it('duplicates complete projects with remapped references and immutable shared asset IDs', () => {
    const st = useEditor.getState();
    st.quoteChanged(createQuote(p(), {}));
    st.copyDesign();
    st.resizeAll({ ...DEFAULT_ROOM, widthMm: 3200 }, newAssets());
    const original = structuredClone(p()),
      duplicated = duplicateProjectDocument(p());
    expect(p()).toEqual(original);
    expect(duplicated.id).not.toBe(original.id);
    expect(projectFrameError(duplicated)).toBeNull();
    expect(
      duplicated.designs
        .map((design) => design.id)
        .some((id) => original.designs.some((design) => design.id === id)),
    ).toBe(false);
    expect(duplicated.shared.baseline.originalAssetId).toBe(original.shared.baseline.originalAssetId);
    expect(duplicated.roomHistory.past!.designs[0].id).toBe(duplicated.designs[0].id);
    duplicated.designs.forEach((design, index) => {
      expect(design.quote!.id).not.toBe(original.designs[index].quote!.id);
      expect(design.quote!.lines[0].sourceSurfaceIds).toEqual([design.scene.surfaces[0].id]);
      expect(design.quote!.sourceSignature).toBe(quoteSourceSignature(design.scene));
    });
  });
});

describe('late work and revision boundaries', () => {
  it('serializes rapid mixed creation commands against the latest five-design capacity', () => {
    const st = useEditor.getState();
    const results = Array.from({ length: 25 }, (_, index) =>
      index % 2 ? st.copyDesign() : st.createDesign(),
    );
    expect(results.filter(Boolean)).toHaveLength(4);
    expect(p().designs).toHaveLength(5);
    expect(new Set(p().designs.map((design) => design.id)).size).toBe(5);
    expect(useEditor.getState().error).toBe(DESIGN_LIMIT_MESSAGE);
    expect(projectFrameError(p())).toBeNull();
  });

  it('never reuses a deleted design revision when a room checkpoint restores the same ID', () => {
    const st = useEditor.getState();
    // Whole-project copies can retain design revisions while starting at editRevision zero.
    const loaded = structuredClone(p());
    loaded.editRevision = 0;
    loaded.designs[0].revision = 120;
    st.load(loaded);
    const id = active().id;
    st.resizeAll({ ...DEFAULT_ROOM, widthMm: 3200 }, newAssets());
    for (let index = 0; index < 8; index++)
      st.change((scene) => {
        scene.color.exposure = index / 10;
      });
    const deletedRevision = active().revision;
    st.deleteDesign(id);
    expect(p().editRevision).toBeGreaterThan(deletedRevision);
    st.restoreRoomChange();
    expect(active().id).toBe(id);
    expect(active().revision).toBeGreaterThan(deletedRevision);
    const firstRestoreRevision = active().revision;
    st.redoRoomChange();
    expect(p().designs).toEqual([]);
    st.restoreRoomChange();
    expect(active().revision).toBeGreaterThan(firstRestoreRevision);
  });

  it.each(['design name', 'project name', 'quote', 'scene', 'common Before'] as const)(
    'commits a live draft before changing %s instead of silently losing it',
    (command) => {
      const st = useEditor.getState();
      st.preview((scene) => {
        scene.fixtures[0].position.x = 0.82;
      });
      if (command === 'design name') st.renameDesign(active().id, '새 이름');
      if (command === 'project name') st.renamed('새 프로젝트 이름');
      if (command === 'quote') st.quoteChanged(createQuote(p(), {}));
      if (command === 'scene')
        st.change((scene) => {
          scene.color.exposure = 0.6;
        });
      if (command === 'common Before')
        st.changeProject((project) => {
          project.shared.comparison!.before.color.warmth = 0.3;
        });
      expect(useEditor.getState().draft).toBeNull();
      expect(active().scene.fixtures[0].position.x).toBe(0.82);
      if (command === 'quote' || command === 'scene') st.undo();
      st.undo();
      expect(active().scene.fixtures[0].position.x).toBe(0.6);
      if (command === 'common Before') expect(p().shared.comparison!.before.color.warmth).toBe(0.3);
    },
  );

  it('keeps newer view preferences and dirty state when an earlier save completes', () => {
    const st = useEditor.getState();
    const a = active().id;
    const b = st.createDesign()!;
    const saving = structuredClone(p());
    st.saving();
    st.selectDesign(a);
    st.toggleDesignComparison(b);
    st.viewport(1.5, { x: 8, y: 12 });
    st.saved({ ...saving, storageRevision: 3, updatedAt: '2026-09-07T01:00:00Z' });
    expect(p().activeDesignId).toBe(a);
    expect(p().comparisonDesignIds).toEqual([b]);
    expect(p().viewport).toEqual({ zoom: 1.5, pan: { x: 8, y: 12 } });
    expect(p().storageRevision).toBe(3);
    expect(useEditor.getState().saveStatus).toBe('dirty');
    const latest = structuredClone(p());
    st.saved({ ...latest, storageRevision: 4, updatedAt: '2026-09-07T02:00:00Z' });
    expect(useEditor.getState().saveStatus).toBe('saved');
    st.saved({ ...saving, storageRevision: 3, updatedAt: '2026-09-07T01:00:00Z' });
    expect(p().storageRevision).toBe(4);
    expect(p().updatedAt).toBe('2026-09-07T02:00:00Z');
    expect(p().activeDesignId).toBe(a);
    expect(useEditor.getState().saveStatus).toBe('saved');
  });

  it('separates legacy Before-only edits from the After timeline and retains incompatible references in the archive', () => {
    const source = legacy();
    const old = structuredClone(captureProjectFrame(source));
    old.comparison!.before.color.warmth = 0.5;
    const incompatible = structuredClone(old);
    incompatible.comparison!.referenceOriginalAssetId = crypto.randomUUID();
    incompatible.color.exposure = 0.9;
    source.history.past = [incompatible, old];
    const migrated = normalizeProjectDocument(source);
    expect(migrated.designs[0].history.past).toEqual([]);
    expect(migrated.shared.beforeHistory.past).toHaveLength(1);
    expect(migrated.shared.legacyHistory!.past).toHaveLength(2);
    stLoad(migrated);
    useEditor.getState().undo();
    expect(active().scene.color.exposure).toBe(0);
    useEditor.getState().setEditing('before');
    useEditor.getState().undo();
    expect(p().shared.comparison!.before.color.warmth).toBe(0.5);
    useEditor.getState().undo();
    expect(p().shared.comparison!.referenceOriginalAssetId).toBe(source.comparison!.referenceOriginalAssetId);
  });

  it('remaps entity aliases only once when a duplicated legacy archive shares surface objects', () => {
    const source = p();
    const frame = captureProjectFrame(source);
    source.shared.legacyHistory = { past: [frame], future: [] };
    getActiveDesign(source)!.quote = createQuote(source, {});
    const duplicated = duplicateProjectDocument(source);
    const design = getActiveDesign(duplicated)!;
    expect(design.scene.surfaces[0].id).toBe(duplicated.shared.legacyHistory!.past[0].surfaces[0].id);
    expect(design.quote!.lines[0].sourceSurfaceIds).toEqual([design.scene.surfaces[0].id]);
    expect(design.quote!.sourceSignature).toBe(quoteSourceSignature(design.scene));
  });
});
