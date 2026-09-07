import { create } from 'zustand';
import { normalizeRoomScene, resizedRoomScene } from './room-editing';
import { validateRoomDimensions } from './room-geometry';
import { ensureMaterialUsage } from './material-usage';
import type { MaterialUsageState } from './material-usage-types';
import type { QuoteDocument } from './quote-types';
import type { RoomDefinition } from './room-types';
import type { Point, ProjectDocument, ProjectInput, Scene, MaterialVersion } from './types';
import {
  captureBeforeFrame,
  captureDesignFrame,
  captureWorkspace,
  projectWorkspaces,
  getActiveDesign,
  getEditingScene,
  normalizeProjectDocument,
  projectFrameError,
  projectWriteError,
  LEGACY_MAX_DESIGNS,
  type EditingSide,
  MAX_DESIGNS,
  MAX_COMPARISON_DESIGNS,
  HISTORY_LIMIT,
  DESIGN_LIMIT_MESSAGE,
  COMPARISON_LIMIT_MESSAGE,
} from './comparison';
import { createBlankDesign, copyDesignDocument, validDesignName } from './designs';

export type Tool = 'select' | 'pan';
export type RoomResizeAssets = Pick<
  Scene,
  'originalAssetId' | 'previewAssetId' | 'imageWidth' | 'imageHeight'
>;
type EditorState = {
  project: ProjectDocument | null;
  editing: EditingSide;
  selection: string | null;
  tool: Tool;
  mode: 'before' | 'after' | 'split';
  split: number;
  draft: Scene | null;
  saveStatus: 'saved' | 'dirty' | 'saving' | 'error';
  error: string;
  load: (p: ProjectInput) => void;
  initializeUsage: (materials: Record<string, MaterialVersion>) => void;
  changeMaterialUsage: (fn: (usage: MaterialUsageState) => void) => void;
  setEditing: (side: EditingSide) => void;
  select: (id: string | null) => void;
  setTool: (t: Tool) => void;
  setMode: (m: 'before' | 'after' | 'split') => void;
  setSplit: (n: number) => void;
  change: (fn: (s: Scene) => void) => void;
  removeFixture: (id: string) => void;
  changeProject: (fn: (p: ProjectDocument) => void) => void;
  createDesign: (name?: string) => string | null;
  copyDesign: (id?: string) => string | null;
  renameDesign: (id: string, name: string) => void;
  deleteDesign: (id: string) => void;
  toggleDesignComparison: (id: string) => void;
  selectDesign: (id: string) => void;
  resizeAll: (room: RoomDefinition, assets: RoomResizeAssets) => void;
  restoreRoomChange: () => void;
  redoRoomChange: () => void;
  preview: (fn: (s: Scene) => void) => void;
  commit: () => void;
  cancel: () => void;
  undo: () => void;
  redo: () => void;
  viewport: (zoom: number, pan: Point) => void;
  renamed: (name: string) => void;
  quoteChanged: (quote: QuoteDocument) => void;
  saving: () => void;
  saved: (saved: ProjectDocument) => void;
  failed: (message: string) => void;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const stamp = () => new Date().toISOString();
function assertProject(project: ProjectDocument, previous?: ProjectDocument) {
  const error = previous
    ? projectWriteError(project, previous)
    : projectFrameError(project, LEGACY_MAX_DESIGNS);
  if (error) throw new Error(error);
}
function activeWritable(project: ProjectDocument, side: EditingSide) {
  return side === 'before' ? !!project.shared.comparison : !!getActiveDesign(project);
}
function selectionFor(project: ProjectDocument, side: EditingSide, selected: string | null) {
  if (!selected) return null;
  const scene = getEditingScene(project, side);
  return scene.surfaces.some((surface) => surface.id === selected) ||
    scene.fixtures.some((fixture) => fixture.id === selected)
    ? selected
    : null;
}
function setScene(project: ProjectDocument, side: EditingSide, scene: Scene) {
  if (side === 'before' && project.shared.comparison) project.shared.comparison.before = scene;
  else {
    const design = getActiveDesign(project);
    if (design) design.scene = scene;
  }
}
/** Retain revision high-water marks even when the corresponding design is later deleted. */
function revisionClock(project: ProjectDocument) {
  return Math.max(
    project.editRevision,
    project.shared.revision,
    ...project.designs.map((design) => design.revision),
  );
}
/** A new document edit invalidates only the common redo; its exact pre-resize backup survives. */
function documentEdit(previous: ProjectDocument, next: ProjectDocument) {
  next.editRevision = revisionClock(previous) + 1;
  delete next.roomHistory.future;
  delete next.thumbnailAssetId;
  assertProject(next, previous);
  return next;
}
function recordEdits(previous: ProjectDocument, next: ProjectDocument) {
  const now = stamp();
  normalizeRoomScene(previous.shared.baseline, next.shared.baseline);
  if (next.shared.comparison)
    normalizeRoomScene(
      previous.shared.comparison?.before ?? next.shared.comparison.before,
      next.shared.comparison.before,
    );
  if (!same(captureBeforeFrame(previous), captureBeforeFrame(next))) {
    next.shared.beforeHistory = {
      past: [...previous.shared.beforeHistory.past, captureBeforeFrame(previous)].slice(-HISTORY_LIMIT),
      future: [],
    };
    next.shared.revision = previous.shared.revision + 1;
  }
  for (const design of next.designs) {
    const old = previous.designs.find((item) => item.id === design.id);
    if (!old) continue;
    normalizeRoomScene(old.scene, design.scene);
    const sceneChanged = !same(old.scene, design.scene);
    if (sceneChanged || !same(old.quote, design.quote) || !same(old.materialUsage, design.materialUsage)) {
      design.history = {
        past: [...old.history.past, captureDesignFrame(old)].slice(-HISTORY_LIMIT),
        future: [],
      };
      design.revision = old.revision + 1;
      design.renderRevision = (old.renderRevision ?? old.revision) + (sceneChanged ? 1 : 0);
      design.updatedAt = now;
      if (sceneChanged) delete design.thumbnailAssetId;
    }
  }
  return documentEdit(previous, next);
}
function advanceRestoredRevisions(previous: ProjectDocument, next: ProjectDocument) {
  // A restored ID may have disappeared from the current workspace. The project clock
  // remembers its last revision, preventing an old preview/export result from matching again.
  const revision = Math.max(revisionClock(previous), revisionClock(next)) + 1;
  next.shared.revision = revision;
  next.designs.forEach((design) => {
    design.revision = revision;
    design.renderRevision = revision;
  });
  next.editRevision = revision;
  delete next.thumbnailAssetId;
  assertProject(next, previous);
  return next;
}
export const useEditor = create<EditorState>((set, get) => {
  let materialVersions: Record<string, MaterialVersion> | null = null;
  const syncUsage = (project: ProjectDocument) => {
    if (!materialVersions) return project;
    for (const design of project.designs)
      design.materialUsage = ensureMaterialUsage(
        design.scene,
        materialVersions,
        design.materialUsage,
        design.quote,
      );
    return project;
  };
  const fail = (error: unknown) => set({ error: error instanceof Error ? error.message : String(error) });
  const publish = (project: ProjectDocument, side = get().editing) =>
    set({
      project,
      editing: side,
      selection: selectionFor(project, side, get().selection),
      draft: null,
      saveStatus: 'dirty',
      error: '',
    });
  function create(copyId?: string, name?: string): string | null {
    const initial = get().project;
    if (!initial) return null;
    if (initial.designs.length >= MAX_DESIGNS) {
      fail(DESIGN_LIMIT_MESSAGE);
      return null;
    }
    if (copyId && !initial.designs.some((design) => design.id === copyId)) return null;
    try {
      if (name !== undefined) validDesignName(name);
      get().commit();
      const previous = get().project!,
        next = structuredClone(previous);
      const source = copyId ? next.designs.find((design) => design.id === copyId)! : undefined;
      const design = source ? copyDesignDocument(source) : createBlankDesign(next, name);
      next.designs.push(design);
      next.activeDesignId = design.id;
      publish(documentEdit(previous, next), 'after');
      set({ selection: null, tool: 'select', mode: 'after' });
      return design.id;
    } catch (error) {
      fail(error);
      return null;
    }
  }
  function history(direction: 'past' | 'future') {
    const state = get(),
      previous = state.project;
    if (!previous || state.draft) return;
    const next = structuredClone(previous);
    if (state.editing === 'before' && previous.shared.comparison) {
      const entries = previous.shared.beforeHistory[direction];
      if (!entries.length) return;
      const frame = structuredClone(direction === 'past' ? entries.at(-1)! : entries[0]);
      const current = captureBeforeFrame(previous);
      next.shared.baseline = frame.baseline;
      delete next.shared.comparison;
      if (frame.comparison) next.shared.comparison = frame.comparison;
      next.shared.beforeHistory =
        direction === 'past'
          ? {
              past: entries.slice(0, -1),
              future: [current, ...previous.shared.beforeHistory.future].slice(0, HISTORY_LIMIT),
            }
          : {
              past: [...previous.shared.beforeHistory.past, current].slice(-HISTORY_LIMIT),
              future: entries.slice(1),
            };
      next.shared.revision = previous.shared.revision + 1;
    } else {
      const design = getActiveDesign(next),
        old = getActiveDesign(previous);
      if (!design || !old || !old.history[direction].length) return;
      const entries = old.history[direction],
        frame = structuredClone(direction === 'past' ? entries.at(-1)! : entries[0]);
      design.scene = frame.scene;
      delete design.quote;
      if (frame.quote) design.quote = frame.quote;
      delete design.materialUsage;
      if (frame.materialUsage) design.materialUsage = frame.materialUsage;
      design.history =
        direction === 'past'
          ? {
              past: entries.slice(0, -1),
              future: [captureDesignFrame(old), ...old.history.future].slice(0, HISTORY_LIMIT),
            }
          : {
              past: [...old.history.past, captureDesignFrame(old)].slice(-HISTORY_LIMIT),
              future: entries.slice(1),
            };
      design.revision = old.revision + 1;
      const sceneChanged = !same(old.scene, design.scene);
      design.renderRevision = (old.renderRevision ?? old.revision) + (sceneChanged ? 1 : 0);
      design.updatedAt = stamp();
      if (sceneChanged) delete design.thumbnailAssetId;
    }
    const side = state.editing === 'before' && !next.shared.comparison ? 'after' : state.editing;
    publish(documentEdit(previous, next), side);
  }
  function restoreRoom(direction: 'past' | 'future') {
    if (!get().project?.roomHistory[direction]) return;
    get().commit();
    const previous = get().project!,
      snapshot = previous.roomHistory[direction];
    if (!snapshot) return;
    const next: ProjectDocument = {
      ...previous,
      ...structuredClone(snapshot),
      roomHistory:
        direction === 'past' ? { future: captureWorkspace(previous) } : { past: captureWorkspace(previous) },
    };
    publish(advanceRestoredRevisions(previous, next), 'after');
    set({ selection: null, mode: 'after', tool: 'select' });
  }
  return {
    project: null,
    editing: 'after',
    selection: null,
    tool: 'select',
    mode: 'after',
    split: 0.5,
    draft: null,
    saveStatus: 'saved',
    error: '',
    load: (input) => {
      materialVersions = null;
      const project = normalizeProjectDocument(input);
      assertProject(project);
      set({
        project,
        editing: 'after',
        selection: null,
        tool: 'select',
        mode: 'after',
        draft: null,
        saveStatus: 'saved',
        error: '',
      });
    },
    initializeUsage: (materials) => {
      materialVersions = materials;
      const current = get().project;
      if (!current) return;
      const project = structuredClone(current);
      for (const workspace of projectWorkspaces(project))
        for (const design of workspace.designs) {
          design.renderRevision ??= design.revision;
          for (const frame of [design, ...design.history.past, ...design.history.future])
            frame.materialUsage = ensureMaterialUsage(
              frame.scene,
              materials,
              frame.materialUsage,
              frame.quote,
            );
        }
      // Read migration only: the next ordinary transaction persists this state.
      if (!same(current, project)) set({ project });
    },
    changeMaterialUsage: (fn) => {
      get().commit();
      const previous = get().project;
      if (!previous || get().editing !== 'after' || !getActiveDesign(previous)) return;
      const next = structuredClone(previous);
      const design = getActiveDesign(next)!;
      design.materialUsage = ensureMaterialUsage(
        design.scene,
        materialVersions ?? {},
        design.materialUsage,
        design.quote,
      );
      fn(design.materialUsage);
      if (same(getActiveDesign(previous)?.materialUsage, design.materialUsage)) return;
      publish(recordEdits(previous, syncUsage(next)));
    },
    setEditing: (side) => {
      get().commit();
      set({
        editing: side === 'before' && get().project?.shared.comparison ? 'before' : 'after',
        selection: null,
        draft: null,
        tool: 'select',
        mode: 'after',
      });
    },
    select: (selection) => set({ selection }),
    setTool: (tool) => set({ tool }),
    setMode: (mode) => set({ mode }),
    setSplit: (split) => set({ split }),
    change: (fn) => {
      get().commit();
      const { project: previous, editing } = get();
      if (!previous || !activeWritable(previous, editing)) return;
      const next = structuredClone(previous),
        scene = getEditingScene(next, editing);
      fn(scene);
      setScene(next, editing, scene);
      publish(recordEdits(previous, syncUsage(next)));
    },
    changeProject: (fn) => {
      get().commit();
      const previous = get().project;
      if (!previous) return;
      const next = structuredClone(previous);
      fn(next);
      const side = get().editing === 'before' && next.shared.comparison ? 'before' : 'after';
      publish(recordEdits(previous, syncUsage(next)), side);
    },
    removeFixture: (id) => {
      const state = get(),
        previous = state.project;
      if (!previous || state.draft || state.mode !== 'after' || !activeWritable(previous, state.editing))
        return;
      const scene = getEditingScene(previous, state.editing),
        fixture = scene.fixtures.find((item) => item.id === id);
      if (!fixture || fixture.locked) return;
      get().change((s) => {
        s.fixtures = s.fixtures.filter((item) => item.id !== id);
      });
      set({ selection: null });
    },
    createDesign: (name) => create(undefined, name),
    copyDesign: (id) => {
      const source = id ?? get().project?.activeDesignId;
      return source ? create(source) : null;
    },
    renameDesign: (id, name) => {
      const initial = get().project?.designs.find((design) => design.id === id);
      if (!initial) return;
      try {
        const value = validDesignName(name);
        if (initial.name === value) return;
        get().commit();
        const previous = get().project!,
          next = structuredClone(previous),
          design = next.designs.find((item) => item.id === id)!;
        design.name = value;
        design.renderRevision ??= design.revision;
        design.revision++;
        design.updatedAt = stamp();
        publish(documentEdit(previous, next));
      } catch (error) {
        fail(error);
      }
    },
    deleteDesign: (id) => {
      const initial = get().project;
      if (!initial?.designs.some((design) => design.id === id)) return;
      get().commit();
      const previous = get().project!,
        next = structuredClone(previous);
      const index = next.designs.findIndex((design) => design.id === id);
      next.designs.splice(index, 1);
      next.comparisonDesignIds = next.comparisonDesignIds.filter((item) => item !== id);
      if (next.activeDesignId === id)
        next.activeDesignId = next.designs[Math.min(index, next.designs.length - 1)]?.id ?? null;
      publish(documentEdit(previous, next), 'after');
      set({ selection: null, mode: 'after', tool: 'select' });
    },
    toggleDesignComparison: (id) => {
      const previous = get().project;
      if (!previous?.designs.some((design) => design.id === id)) return;
      const included = previous.comparisonDesignIds.includes(id);
      if (!included && previous.comparisonDesignIds.length >= MAX_COMPARISON_DESIGNS) {
        fail(COMPARISON_LIMIT_MESSAGE);
        return;
      }
      const comparisonDesignIds = included
        ? previous.comparisonDesignIds.filter((item) => item !== id)
        : [...previous.comparisonDesignIds, id];
      set({ project: { ...previous, comparisonDesignIds }, saveStatus: 'dirty', error: '' });
    },
    selectDesign: (id) => {
      if (!get().project?.designs.some((design) => design.id === id)) return;
      get().commit();
      const project = get().project!;
      set({
        project: { ...project, activeDesignId: id },
        editing: 'after',
        selection: null,
        mode: 'after',
        tool: 'select',
        draft: null,
        saveStatus: 'dirty',
        error: '',
      });
    },
    resizeAll: (room, assets) => {
      const initial = get().project;
      if (!initial?.shared.baseline.room) return;
      if (
        !validateRoomDimensions(room) ||
        !Number.isFinite(assets.imageWidth) ||
        !Number.isFinite(assets.imageHeight) ||
        assets.imageWidth <= 0 ||
        assets.imageHeight <= 0
      ) {
        fail('공간 크기와 배경 이미지 크기를 확인해 주세요.');
        return;
      }
      if (same(initial.shared.baseline.room, room)) return;
      get().commit();
      const previous = get().project!,
        next = structuredClone(previous);
      next.shared.baseline = resizedRoomScene(previous.shared.baseline, room, assets);
      if (next.shared.comparison) {
        next.shared.comparison.before = resizedRoomScene(previous.shared.comparison!.before, room, assets);
        next.shared.comparison.room = structuredClone(room);
        next.shared.comparison.aspect = assets.imageWidth / assets.imageHeight;
      }
      next.shared.beforeHistory = { past: [], future: [] };
      next.shared.revision = previous.shared.revision + 1;
      next.designs.forEach((design) => {
        design.scene = resizedRoomScene(design.scene, room, assets);
        if (materialVersions)
          design.materialUsage = ensureMaterialUsage(
            design.scene,
            materialVersions,
            design.materialUsage,
            design.quote,
          );
        design.history = { past: [], future: [] };
        design.renderRevision = (design.renderRevision ?? design.revision) + 1;
        design.revision++;
        design.updatedAt = stamp();
        delete design.thumbnailAssetId;
      });
      next.roomHistory = { past: captureWorkspace(previous) };
      publish(documentEdit(previous, next), 'after');
      set({ selection: null, tool: 'select', mode: 'after' });
    },
    restoreRoomChange: () => restoreRoom('past'),
    redoRoomChange: () => restoreRoom('future'),
    preview: (fn) => {
      const { project, editing } = get();
      if (!project || !activeWritable(project, editing)) return;
      const previous = getEditingScene(project, editing),
        draft = structuredClone(previous);
      fn(draft);
      normalizeRoomScene(previous, draft);
      set({ draft });
    },
    commit: () => {
      const { project: previous, draft, editing } = get();
      if (!previous || !draft || !activeWritable(previous, editing)) return;
      const next = structuredClone(previous);
      setScene(next, editing, structuredClone(draft));
      publish(recordEdits(previous, syncUsage(next)));
    },
    cancel: () => set({ draft: null }),
    undo: () => history('past'),
    redo: () => history('future'),
    viewport: (zoom, pan) => {
      const project = get().project;
      if (project) set({ project: { ...project, viewport: { zoom, pan } }, saveStatus: 'dirty' });
    },
    renamed: (name) => {
      get().commit();
      const previous = get().project;
      if (previous)
        publish(documentEdit(previous, { ...previous, name, roomHistory: { ...previous.roomHistory } }));
    },
    quoteChanged: (quote) => {
      if (get().editing !== 'after' || !get().project || !getActiveDesign(get().project!)) return;
      get().changeProject((project) => {
        getActiveDesign(project)!.quote = { ...structuredClone(quote), updatedAt: stamp() };
      });
    },
    saving: () => set({ saveStatus: 'saving', error: '' }),
    saved: (saved) => {
      const current = get().project;
      if (!current || current.id !== saved.id || saved.storageRevision < current.storageRevision) return;
      const unchanged =
        current.editRevision === saved.editRevision &&
        same(current.viewport, saved.viewport) &&
        current.activeDesignId === saved.activeDesignId &&
        same(current.comparisonDesignIds, saved.comparisonDesignIds);
      set({
        project: { ...current, storageRevision: saved.storageRevision, updatedAt: saved.updatedAt },
        saveStatus: unchanged ? 'saved' : 'dirty',
      });
    },
    failed: (error) => set({ saveStatus: 'error', error }),
  };
});
