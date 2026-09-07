import { calculateMaterialUsage } from '../src/lib/material-usage';
import { applyRoomSurfaceBand } from '../src/lib/room-surface-bands';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../src/lib/editor-store';
import { captureWorkspace, getActiveDesign, normalizeProjectDocument } from '../src/lib/comparison';
import { copyDesignDocument, duplicateProjectDocument } from '../src/lib/designs';
import { designPreviewKey } from '../src/lib/render/design-preview';
import { projectReferences } from '../src/lib/repositories/references';
import { projectV3Schema } from '../src/lib/supabase/validation';
import { createQuote } from '../src/lib/quote';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type LegacyProjectDocument,
  type MaterialVersion,
} from '../src/lib/types';

const stamp = '2026-09-07T00:00:00Z';
function material(): MaterialVersion {
  const image = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    materialId: crypto.randomUUID(),
    version: 1,
    name: '스톤',
    brand: '',
    code: 'S1',
    category: 'tile',
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    coverAssetId: image,
    imageAssetIds: [image],
    textureAssetIds: [image],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    createdAt: stamp,
    pricing: { unit: 'box', unitPrice: 40_000, boxCoverageM2: 1.44, piecesPerBox: 4, wastePercent: 20 },
  };
}
const tile = material(),
  replacement = material();
const materials = { [tile.id]: tile, [replacement.id]: replacement };
function project() {
  const scene = {
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
  scene.surfaces[0].materialVersionId = tile.id;
  const legacy: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '자재 사용',
    schemaVersion: 2,
    scene,
    editRevision: 8,
    storageRevision: 3,
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    createdAt: stamp,
    updatedAt: stamp,
  };
  return normalizeProjectDocument(legacy);
}
const current = () => useEditor.getState().project!;
const active = () => getActiveDesign(current())!;
const surfaceId = () => active().scene.surfaces[0].id;
const pricing = () => active().materialUsage!.assignments[surfaceId()].pricing;
beforeEach(() => {
  useEditor.getState().load(project());
  useEditor.getState().initializeUsage(materials);
});

describe('per-design material usage storage and history', () => {
  it('initializes in memory without revising or dirtying the saved document and captures the first immutable price', () => {
    const raw = project(),
      preserved = structuredClone(raw);
    useEditor.getState().load(raw);
    useEditor.getState().initializeUsage(materials);
    expect(raw).toEqual(preserved);
    expect(current().editRevision).toBe(8);
    expect(useEditor.getState().saveStatus).toBe('saved');
    expect(pricing().unitPrice).toBe(40_000);
    expect(active().history.past).toHaveLength(0);
    useEditor.getState().initializeUsage({
      ...materials,
      [tile.id]: { ...tile, pricing: { ...tile.pricing!, unitPrice: 90_000 } },
    });
    expect(pricing().unitPrice).toBe(40_000);
  });
  it('records one cost command, undo and redo without altering the visual revision or preview key', async () => {
    const st = useEditor.getState(),
      original = structuredClone(active()),
      revision = current().editRevision;
    const input = () => ({
      projectId: current().id,
      sharedRevision: current().shared.revision,
      design: active(),
      materials,
    });
    const key = await designPreviewKey(input());
    st.changeMaterialUsage((usage) => {
      usage.assignments[surfaceId()].pricing.unitPrice = 55_000;
    });
    expect(pricing().unitPrice).toBe(55_000);
    expect(current().editRevision).toBeGreaterThan(revision);
    expect(active().revision).toBe(original.revision + 1);
    expect(active().renderRevision).toBe(original.renderRevision);
    expect(active().history.past).toHaveLength(1);
    expect(await designPreviewKey(input())).toBe(key);
    st.undo();
    expect(pricing().unitPrice).toBe(40_000);
    expect(active().renderRevision).toBe(original.renderRevision);
    expect(await designPreviewKey(input())).toBe(key);
    st.redo();
    expect(pricing().unitPrice).toBe(55_000);
    expect(active().renderRevision).toBe(original.renderRevision);
    const saved = structuredClone(current());
    st.load(saved);
    st.initializeUsage(materials);
    expect(pricing().unitPrice).toBe(55_000);
    expect(projectV3Schema.safeParse(current()).success).toBe(true);
  });
  it('can edit After costs while showing Before, but prevents editing the common Before costs', () => {
    const st = useEditor.getState();
    st.setMode('before');
    st.changeMaterialUsage((usage) => {
      usage.assignments[surfaceId()].pricing.unitPrice = 0;
    });
    expect(pricing().unitPrice).toBe(0);
    expect(useEditor.getState().mode).toBe('before');
    st.changeProject((project) => {
      const scene = structuredClone(getActiveDesign(project)!.scene);
      project.shared.comparison = {
        before: scene,
        room: scene.room!,
        cameraVersion: 1,
        aspect: 1.5,
        referenceOriginalAssetId: scene.originalAssetId,
        referencePreviewAssetId: scene.previewAssetId,
        status: 'draft',
      };
    });
    st.setEditing('before');
    st.changeMaterialUsage((usage) => {
      usage.assignments[surfaceId()].pricing.unitPrice = 7;
    });
    expect(pricing().unitPrice).toBe(0);
  });
  it('snapshots replacement prices, prunes removed assignments, and restores old usage independently', () => {
    const st = useEditor.getState(),
      oldRender = active().renderRevision!;
    st.changeMaterialUsage((usage) => {
      usage.assignments[surfaceId()].pricing.unitPrice = 1;
    });
    st.change((scene) => {
      scene.surfaces[0].materialVersionId = replacement.id;
    });
    expect(pricing().sourceVersionId).toBe(replacement.id);
    expect(pricing().unitPrice).toBe(40_000);
    expect(active().renderRevision).toBeGreaterThan(oldRender);
    st.undo();
    expect(pricing().sourceVersionId).toBe(tile.id);
    expect(pricing().unitPrice).toBe(1);
    st.change((scene) => {
      delete scene.surfaces[0].materialVersionId;
    });
    expect(active().materialUsage!.assignments).toEqual({});
    st.undo();
    expect(pricing().unitPrice).toBe(1);
  });
  it('deep copies usage areas and price provenance with new surface references, retaining the source timeline', () => {
    const st = useEditor.getState(),
      id = surfaceId();
    st.changeMaterialUsage((usage) => {
      usage.areas[id] = { mode: 'manual', areaM2: 12 };
      usage.assignments[id].pricing.unitPrice = 123;
      usage.aggregateAreas.push({ materialVersionId: tile.id, surfaceIds: [id], areaM2: 12 });
    });
    const original = structuredClone(active()),
      copy = copyDesignDocument(active());
    const freshId = copy.scene.surfaces[0].id;
    expect(freshId).not.toBe(id);
    expect(copy.materialUsage!.areas[freshId].areaM2).toBe(12);
    expect(copy.materialUsage!.assignments[freshId].pricing.sourceVersionId).toBe(tile.id);
    expect(copy.materialUsage!.aggregateAreas[0].surfaceIds).toEqual([freshId]);
    copy.materialUsage!.areas[freshId].areaM2 = 20;
    copy.materialUsage!.assignments[freshId].pricing.unitPrice = 99;
    expect(active()).toEqual(original);
    expect(copy.history).toEqual({ past: [], future: [] });
  });
  it('resizes all scenes while preserving costs and restores exact usage across later design creation and deletion', () => {
    const st = useEditor.getState(),
      id = surfaceId();
    st.changeMaterialUsage((usage) => {
      usage.areas[id] = { mode: 'manual', areaM2: 12 };
      usage.quantities['manual-test-row'] = { mode: 'manual', quantity: 9 };
      usage.assignments[id].pricing.unitPrice = 19;
    });
    const original = structuredClone(active().materialUsage),
      a = active().id;
    st.copyDesign();
    st.resizeAll(
      { ...DEFAULT_ROOM, widthMm: 3_000 },
      {
        originalAssetId: crypto.randomUUID(),
        previewAssetId: crypto.randomUUID(),
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    expect(current().designs.every((design) => design.history.past.length === 0)).toBe(true);
    expect(Object.values(active().materialUsage!.assignments)[0].pricing.unitPrice).toBe(19);
    const b = active().id;
    st.createDesign();
    st.deleteDesign(a);
    st.deleteDesign(b);
    st.restoreRoomChange();
    expect(current().designs).toHaveLength(2);
    expect(getActiveDesign(current(), a)!.materialUsage).toEqual(original);
    st.redoRoomChange();
    expect(current().designs).toHaveLength(1);
    expect(active().scene.surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
  });
  it('keeps full-face material and a lower band when resizing, assigning their area once', () => {
    const st = useEditor.getState();
    st.change((scene) => {
      const back = scene.surfaces.find((surface) => surface.roomFace === 'back')!;
      back.materialVersionId = tile.id;
      const band = applyRoomSurfaceBand(
        { ...structuredClone(back), id: crypto.randomUUID() },
        { from: 0.5, to: 1 },
      );
      scene.surfaces.push(band);
    });
    const beforeIds = active().scene.surfaces.map((surface) => surface.id);
    st.resizeAll(
      { ...DEFAULT_ROOM, widthMm: 3_000 },
      {
        originalAssetId: crypto.randomUUID(),
        previewAssetId: crypto.randomUUID(),
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    expect(
      active()
        .scene.surfaces.map((surface) => surface.id)
        .sort(),
    ).toEqual(beforeIds.sort());
    const result = calculateMaterialUsage(active().scene, materials, active().materialUsage);
    expect(result.rows[0].areaM2).toBe(14.4);
    expect(result.rows[0].quantity).toBe(10);
    expect(result.complete).toBe(true);
  });
  it('rejects unsupported product price units and invalid snapshot values at the storage boundary', () => {
    const original = structuredClone(current()),
      assignment = original.designs[0].materialUsage!.assignments[surfaceId()];
    assignment.category = 'fixture';
    assignment.pricing.unit = 'box';
    expect(projectV3Schema.safeParse(original).success).toBe(false);
    assignment.pricing.unit = 'piece';
    assignment.pricing.unitPrice = -1;
    expect(projectV3Schema.safeParse(original).success).toBe(false);
    assignment.pricing.unitPrice = 0;
    expect(projectV3Schema.safeParse(original).success).toBe(true);
  });
  it('includes price provenance in current, historical and room backup references and preserves archived quotes', () => {
    const st = useEditor.getState(),
      source = crypto.randomUUID();
    const quote = createQuote(current(), materials);
    st.quoteChanged(quote);
    const archived = structuredClone(active().quote);
    st.changeMaterialUsage((usage) => {
      usage.assignments[surfaceId()].pricing.sourceVersionId = source;
    });
    st.resizeAll(
      { ...DEFAULT_ROOM, widthMm: 3_000 },
      {
        originalAssetId: crypto.randomUUID(),
        previewAssetId: crypto.randomUUID(),
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
    st.change((scene) => {
      delete scene.surfaces[0].materialVersionId;
    });
    expect(active().quote).toEqual(archived);
    expect(projectReferences(current()).versions).toContain(source);
    const duplicate = duplicateProjectDocument(current());
    expect(projectReferences(duplicate).versions).toContain(source);
    expect(projectV3Schema.safeParse(duplicate).success).toBe(true);
    expect(captureWorkspace(duplicate).designs[0].history.past[0].materialUsage).toBeDefined();
  });
});
