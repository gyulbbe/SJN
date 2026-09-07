import { getActiveDesign, normalizeProjectDocument } from '../src/lib/comparison';
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { StorageConflictError } from '../src/lib/repositories/references';
import { createQuote } from '../src/lib/quote';
import { materialPricingSchema, quoteDocumentSchema } from '../src/lib/quote-validation';
import { projectSchema, materialInputSchema } from '../src/lib/supabase/validation';
import { createBaseRoomSurfaces } from '../src/lib/base-room';
import { useEditor } from '../src/lib/editor-store';
import { DEFAULT_COLOR, EMPTY_MASK, type MaterialInput, type LegacyProjectDocument } from '../src/lib/types';

async function setup() {
  const repo = createLocalRepositories('quote-' + crypto.randomUUID());
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await repo.assets.put({
    id,
    ownerId: 'local',
    name: 'photo.png',
    mime: 'image/png',
    size: 3,
    width: 100,
    height: 100,
    kind: 'original',
    createdAt: now,
    blob: new Blob(['png']),
  });
  const input: MaterialInput = {
    name: '견적 타일',
    brand: '',
    code: 'T1',
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
    coverAssetId: id,
    imageAssetIds: [],
    textureAssetIds: [id],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#dddddd',
    defaultPattern: 'grid',
    pricing: { unit: 'box', unitPrice: 30000, boxCoverageM2: 1.44, piecesPerBox: 4, wastePercent: 10 },
  };
  const material = await repo.materials.create(input);
  const surfaces = createBaseRoomSurfaces();
  surfaces[0].materialVersionId = material.id;
  const p: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '견적 공간',
    schemaVersion: 1,
    editRevision: 0,
    storageRevision: 0,
    createdAt: now,
    updatedAt: now,
    scene: {
      originalAssetId: id,
      previewAssetId: id,
      imageWidth: 100,
      imageHeight: 100,
      surfaces,
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  };
  p.quote = createQuote(p, { [material.id]: material });
  return { repo, input, material, project: await repo.projects.create(p) };
}

describe('quote persistence and isolation', () => {
  it('persists a project override while retaining both old and new catalog prices', async () => {
    const { repo, input, material, project } = await setup();
    useEditor.getState().load(project);
    const changed = structuredClone(getActiveDesign(project)!.quote!);
    changed.lines[0].unitPrice = 25000;
    changed.lines[0].areaM2 = 12;
    changed.lines[0].quantityConfirmed = true;
    useEditor.getState().quoteChanged(changed);
    const current = useEditor.getState().project!;
    expect(getActiveDesign(current)!.scene).toEqual(getActiveDesign(project)!.scene);
    expect(getActiveDesign(current)!.history.past).toHaveLength(1);
    expect(getActiveDesign(current)!.history.past[0].quote).toEqual(getActiveDesign(project)!.quote);
    expect(current.editRevision).toBe(project.editRevision + 1);
    const saved = await repo.projects.save(current, current.storageRevision);
    const newer = await repo.materials.update(
      material.materialId,
      { ...input, pricing: { ...input.pricing!, unitPrice: 45000 } },
      material.id,
    );
    expect((await repo.materials.getVersion(material.id)).pricing!.unitPrice).toBe(30000);
    expect(newer.pricing!.unitPrice).toBe(45000);
    expect(getActiveDesign(await repo.projects.load(project.id))!.quote!.lines[0].unitPrice).toBe(25000);
    expect(getActiveDesign(normalizeProjectDocument(projectSchema.parse(saved)))!.quote).toEqual(
      getActiveDesign(saved)!.quote,
    );
    expect(materialInputSchema.parse(input).pricing).toEqual(input.pricing);
    useEditor.getState().load(saved);
    useEditor.getState().change((scene) => {
      scene.surfaces = [];
    });
    useEditor.getState().undo();
    expect(getActiveDesign(useEditor.getState().project!)!.quote).toEqual(getActiveDesign(saved)!.quote);
  });
  it('keeps pending quote edits dirty after an older save returns', async () => {
    const { project } = await setup();
    useEditor.getState().load(project);
    const first = structuredClone(getActiveDesign(project)!.quote!);
    first.customerName = '첫 값';
    useEditor.getState().quoteChanged(first);
    const earlier = structuredClone(useEditor.getState().project!);
    const second = structuredClone(first);
    second.customerName = '마지막 값';
    useEditor.getState().quoteChanged(second);
    useEditor.getState().saved({ ...earlier, storageRevision: earlier.storageRevision + 1 });
    expect(useEditor.getState().saveStatus).toBe('dirty');
    expect(getActiveDesign(useEditor.getState().project!)!.quote!.customerName).toBe('마지막 값');
  });
  it('duplicates with an independent quote number and rejects stale or invalid overwrites', async () => {
    const { repo, project } = await setup();
    const copy = await repo.projects.duplicate(project.id);
    expect(getActiveDesign(copy)!.quote!.id).not.toBe(getActiveDesign(project)!.quote!.id);
    expect(getActiveDesign(copy)!.quote!.number).not.toBe(getActiveDesign(project)!.quote!.number);
    expect(getActiveDesign(copy)!.quote!.lines[0].unitPrice).toBe(
      getActiveDesign(project)!.quote!.lines[0].unitPrice,
    );
    expect(getActiveDesign(copy)!.quote!.lines[0].id).not.toBe(getActiveDesign(project)!.quote!.lines[0].id);
    const edited = structuredClone(project);
    getActiveDesign(edited)!.quote!.lines[0].unitPrice = 12345;
    const saved = await repo.projects.save(edited, project.storageRevision);
    await expect(repo.projects.save(project, project.storageRevision)).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    const invalid = structuredClone(saved);
    getActiveDesign(invalid)!.quote!.lines[0].unitPrice = -1;
    await expect(repo.projects.save(invalid, saved.storageRevision)).rejects.toThrow();
    expect(getActiveDesign(await repo.projects.load(project.id))!.quote!.lines[0].unitPrice).toBe(12345);
    expect(getActiveDesign(await repo.projects.load(copy.id))!.quote!.lines[0].unitPrice).toBe(30000);
  });
  it('validates pricing ranges and accepts legacy materials without pricing', async () => {
    const { input, project } = await setup();
    const legacy = { ...input };
    delete legacy.pricing;
    expect(materialInputSchema.safeParse(legacy).success).toBe(true);
    expect(materialPricingSchema.safeParse({ ...input.pricing, unitPrice: 0 }).success).toBe(true);
    for (const bad of [NaN, Infinity, -1, 100000001, 1.5])
      expect(materialPricingSchema.safeParse({ ...input.pricing, unitPrice: bad }).success).toBe(false);
    expect(quoteDocumentSchema.safeParse({ ...getActiveDesign(project)!.quote, taxRate: 101 }).success).toBe(
      false,
    );
    expect(
      quoteDocumentSchema.safeParse({
        ...getActiveDesign(project)!.quote,
        lines: Array(301).fill(getActiveDesign(project)!.quote!.lines[0]),
      }).success,
    ).toBe(false);
  });
});
