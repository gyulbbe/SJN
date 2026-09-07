import { calculateMaterialUsage } from '../src/lib/material-usage';
import { getActiveDesign } from '../src/lib/designs';
import { describe, expect, it } from 'vitest';
import { createBaseRoomSurfaces } from '../src/lib/base-room';
import { useEditor } from '../src/lib/editor-store';
import {
  createCustomQuoteLine,
  createQuote,
  quantityForLine,
  quoteSourceSignature,
  resyncRoomQuote,
  roomAreaForSurfaces,
} from '../src/lib/quote';
import { quoteDocumentSchema } from '../src/lib/quote-validation';
import type { QuoteDocument } from '../src/lib/quote-types';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type MaterialVersion,
  type LegacyProjectDocument as ProjectDocument,
  type Scene,
} from '../src/lib/types';

function setup() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const material: MaterialVersion = {
    id,
    materialId: crypto.randomUUID(),
    version: 1,
    name: '600 스톤',
    brand: '개인 자재',
    code: 'S-600',
    category: 'tile',
    scope: 'personal',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 600,
    depthMm: 9,
    usage: 'both',
    installation: 'floor',
    coverAssetId: crypto.randomUUID(),
    imageAssetIds: [],
    textureAssetIds: [],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ddd',
    defaultPattern: 'grid',
    createdAt: now,
    pricing: { unit: 'box', unitPrice: 30000, boxCoverageM2: 1.44, piecesPerBox: 4, wastePercent: 0 },
  };
  const surfaces = createBaseRoomSurfaces().map((surface, index) => ({
    ...surface,
    roomFace: (['floor', 'left', 'back', 'right'] as const)[index],
    geometryMode: 'room' as const,
  }));
  surfaces[0].materialVersionId = id;
  const project: ProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '치수 연동 공간',
    schemaVersion: 1,
    editRevision: 0,
    storageRevision: 1,
    createdAt: now,
    updatedAt: now,
    scene: {
      room: { kind: 'parametric', version: 1, widthMm: 2400, depthMm: 2400, heightMm: 2400 },
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 1536,
      imageHeight: 1024,
      surfaces,
      protection: EMPTY_MASK(),
      fixtures: [],
      color: { ...DEFAULT_COLOR },
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  };
  project.quote = createQuote(project, { [id]: material });
  return { project, material, quote: project.quote };
}
function resized(scene: Scene, widthMm: number) {
  const next = structuredClone(scene);
  next.room!.widthMm = widthMm;
  return next;
}
function quoteFromStore(): QuoteDocument {
  return getActiveDesign(useEditor.getState().project!)!.quote!;
}

describe('room-linked quotation areas', () => {
  it('uses actual floor dimensions for 600 mm tiles and packaged orders', () => {
    const { project, quote } = setup();
    const line = quote.lines[0];
    expect(line.areaSource).toBe('room');
    expect(line.sourceSurfaceIds).toEqual([project.scene.surfaces[0].id]);
    expect(line.areaM2).toBe(5.76);
    expect(quantityForLine(line)).toBe(4);
    expect(quantityForLine({ ...line, unit: 'piece' })).toBe(16);
    const larger = resyncRoomQuote(quote, resized(project.scene, 3600));
    expect(larger.lines[0].areaM2).toBe(8.64);
    expect(quantityForLine(larger.lines[0])).toBe(6);
    expect(quantityForLine({ ...larger.lines[0], unit: 'piece' })).toBe(24);
  });

  it('sums only applied full faces using independent width, depth and height', () => {
    const { project, material } = setup();
    project.scene.room = { kind: 'parametric', version: 1, widthMm: 2400, depthMm: 3600, heightMm: 3000 };
    project.scene.surfaces.forEach((surface) => {
      surface.materialVersionId = material.id;
    });
    const line = createQuote(project, { [material.id]: material }).lines[0];
    expect(line.areaM2).toBe(37.44); // floor 8.64 + back 7.2 + two sides 10.8 each
    expect(line.sourceSurfaceIds).toHaveLength(4);
    project.scene.surfaces[1].materialVersionId = undefined;
    expect(createQuote(project, { [material.id]: material }).lines[0].areaM2).toBe(26.64);
  });

  it('never estimates a partial group from manual, unknown, duplicate or missing faces', () => {
    const { project, material } = setup();
    const floor = project.scene.surfaces[0];
    project.scene.surfaces[1].materialVersionId = material.id;
    project.scene.surfaces[1].geometryMode = 'manual';
    expect(createQuote(project, { [material.id]: material }).lines[0]).toMatchObject({
      areaSource: 'manual',
      areaM2: null,
    });
    project.scene.surfaces[1].geometryMode = 'room';
    project.scene.surfaces[1].roomFace = 'floor';
    expect(roomAreaForSurfaces(project.scene, [floor.id, project.scene.surfaces[1].id])).toBeNull();
    expect(roomAreaForSurfaces(project.scene, [floor.id, floor.id])).toBeNull();
    expect(roomAreaForSurfaces(project.scene, ['missing'])).toBeNull();
    expect(roomAreaForSurfaces(project.scene, [floor.id], 'other-version')).toBeNull();
    project.scene.room!.widthMm = Number.NaN;
    expect(roomAreaForSurfaces(project.scene, [floor.id])).toBeNull();
    delete project.scene.room;
    expect(roomAreaForSurfaces(project.scene, [floor.id])).toBeNull();
  });

  it('preserves quote overrides, composition and catalog snapshots when dimensions change', () => {
    const { project, material, quote } = setup();
    const originalCatalog = structuredClone(material);
    quote.lines[0].unitPrice = 25000;
    quote.lines[0].specification = '현장 확인 규격';
    quote.lines[0].quantityConfirmed = true;
    quote.customerName = '고객';
    quote.discount = 2000;
    quote.taxRate = 10;
    quote.lines.push({
      ...createCustomQuoteLine(),
      name: '시공비',
      unitPrice: 50000,
      quantityConfirmed: true,
    });
    const nextScene = resized(project.scene, 3600);
    nextScene.surfaces[1].materialVersionId = material.id;
    const next = resyncRoomQuote(quote, nextScene);
    expect(next.lines).toHaveLength(2);
    expect(next.lines[0]).toMatchObject({
      areaM2: 8.64,
      unitPrice: 25000,
      specification: '현장 확인 규격',
      quantityConfirmed: false,
    });
    expect(next.lines[1]).toEqual(quote.lines[1]);
    expect(next.customerName).toBe('고객');
    expect(next.discount).toBe(2000);
    expect(next.taxRate).toBe(10);
    expect(next.sourceSignature).toBe(quote.sourceSignature);
    expect(next.sourceSignature).not.toBe(quoteSourceSignature(nextScene));
    expect(material).toEqual(originalCatalog);
    expect(quote.lines[0].areaM2).toBe(5.76);
  });

  it('retains manually entered quantity or area while updating only linked area', () => {
    const { project, quote } = setup();
    quote.lines[0].quantityMode = 'manual';
    quote.lines[0].quantity = 11;
    quote.lines[0].quantityConfirmed = true;
    const next = resyncRoomQuote(quote, resized(project.scene, 3600));
    expect(next.lines[0]).toMatchObject({ areaM2: 8.64, quantity: 11, quantityConfirmed: true });
    const manual = structuredClone(quote);
    manual.lines[0].areaSource = 'manual';
    manual.lines[0].areaM2 = 20;
    expect(resyncRoomQuote(manual, resized(project.scene, 3600))).toBe(manual);
    const legacy = structuredClone(manual);
    delete legacy.lines[0].areaSource;
    expect(resyncRoomQuote(legacy, resized(project.scene, 3600))).toBe(legacy);
  });

  it('invalidates manual or removed source faces and restores area when the face is reconnected', () => {
    const { project, quote } = setup();
    quote.lines[0].quantityConfirmed = true;
    const edited = structuredClone(project.scene);
    edited.surfaces[0].geometryMode = 'manual';
    const manual = resyncRoomQuote(quote, edited);
    expect(manual.lines[0]).toMatchObject({ areaSource: 'room', areaM2: null, quantityConfirmed: false });
    expect(quantityForLine(manual.lines[0])).toBeNull();
    expect(resyncRoomQuote(manual, project.scene).lines[0].areaM2).toBe(5.76);
    edited.surfaces = [];
    expect(resyncRoomQuote(quote, edited).lines[0].areaM2).toBeNull();
  });

  it('does not change totals for masking, shading, object placement or an unchanged rounded order quantity', () => {
    const { project, quote } = setup();
    quote.lines[0].quantityConfirmed = true;
    const masked = structuredClone(project.scene);
    masked.protection.polygon = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ];
    masked.surfaces[0].mask.holes = [masked.protection.polygon];
    masked.surfaces[0].tile.shading = 0.5;
    expect(resyncRoomQuote(quote, masked)).toBe(quote);
    expect(quoteSourceSignature(resized(project.scene, 3600))).toBe(quote.sourceSignature);
    const smaller = resyncRoomQuote(quote, resized(project.scene, 2399));
    expect(quantityForLine(smaller.lines[0])).toBe(4);
    expect(smaller.lines[0].quantityConfirmed).toBe(true);
  });

  it('synchronizes shared room resize and exact restore without losing manual price changes', () => {
    const { project, material } = setup();
    const state = useEditor.getState();
    state.load(project);
    const quote = structuredClone(quoteFromStore());
    quote.lines[0].unitPrice = 25000;
    state.quoteChanged(quote);
    state.initializeUsage({ [material.id]: material });
    const usage = () => {
      const design = getActiveDesign(useEditor.getState().project!)!;
      return calculateMaterialUsage(design.scene, { [material.id]: material }, design.materialUsage);
    };
    const archive = structuredClone(quoteFromStore());
    state.resizeAll(
      { ...project.scene.room!, widthMm: 3600 },
      {
        originalAssetId: project.scene.originalAssetId,
        previewAssetId: project.scene.previewAssetId,
        imageWidth: project.scene.imageWidth,
        imageHeight: project.scene.imageHeight,
      },
    );
    expect(usage().rows[0].quantity).toBe(6);
    expect(quoteFromStore()).toEqual(archive);
    state.restoreRoomChange();
    expect(usage().rows[0].quantity).toBe(4);
    expect(quoteFromStore().lines[0].unitPrice).toBe(25000);
    state.redoRoomChange();
    expect(usage().rows[0].quantity).toBe(6);
    expect(quoteFromStore()).toEqual(archive);
    state.preview((scene) => {
      scene.color.exposure = 0.3;
    });
    expect(usage().rows[0].quantity).toBe(6);
    expect(quoteFromStore()).toEqual(archive);
    state.commit();
    state.undo();
    expect(usage().rows[0].quantity).toBe(6);
    expect(quoteFromStore()).toEqual(archive);
    expect(quoteFromStore().lines[0].unitPrice).toBe(25000);
  });

  it('keeps migration and archived areas read-only while usage derives the current room area', () => {
    const { project, quote, material } = setup();
    expect(quoteDocumentSchema.parse(quote)).toEqual(quote);
    useEditor.getState().load(project);
    expect(useEditor.getState().saveStatus).toBe('saved');
    const stale = structuredClone(project);
    stale.scene.room!.widthMm = 3600;
    useEditor.getState().load(stale);
    useEditor.getState().initializeUsage({ [material.id]: material });
    expect(quoteFromStore().lines[0].areaM2).toBe(5.76);
    expect(useEditor.getState().saveStatus).toBe('saved');
    expect(useEditor.getState().project!.editRevision).toBe(stale.editRevision);
    expect(getActiveDesign(useEditor.getState().project!)!.history).toEqual(stale.history);
    useEditor.getState().change((scene) => {
      scene.color.exposure = 0.2;
    });
    expect(quoteFromStore().lines[0].areaM2).toBe(5.76);
    const design = getActiveDesign(useEditor.getState().project!)!;
    expect(
      calculateMaterialUsage(design.scene, { [material.id]: material }, design.materialUsage).rows[0].areaM2,
    ).toBe(8.64);
    expect(useEditor.getState().saveStatus).toBe('dirty');
    delete stale.quote!.lines[0].areaSource;
    useEditor.getState().load(stale);
    expect(useEditor.getState().saveStatus).toBe('saved');
    expect(quoteFromStore().lines[0].areaM2).toBe(5.76);
  });
});
