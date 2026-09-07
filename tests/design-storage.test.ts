import { ensureMaterialUsage } from '../src/lib/material-usage';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalRepositories } from '../src/lib/repositories/local';
import { createCloudRepositories } from '../src/lib/repositories/cloud';
import { projectReferences, StorageConflictError } from '../src/lib/repositories/references';
import { captureWorkspace, getActiveDesign, normalizeProjectDocument } from '../src/lib/comparison';
import {
  copyDesignDocument,
  createBlankDesign,
  DESIGN_LIMIT_MESSAGE,
  COMPARISON_LIMIT_MESSAGE,
} from '../src/lib/designs';
import { projectV3Schema } from '../src/lib/supabase/validation';
import { createQuote, quoteSourceSignature } from '../src/lib/quote';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type AssetRecord,
  type LegacyProjectDocument,
  type MaterialInput,
  type ProjectDocument,
} from '../src/lib/types';

const stamp = '2020-01-01T00:00:00.000Z';
async function setup() {
  const name = 'design-storage-' + crypto.randomUUID();
  const repo = createLocalRepositories(name);
  async function asset(label = 'room.png', sourceAssetId?: string) {
    const record: AssetRecord = {
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: label,
      mime: 'image/png',
      kind: 'original',
      width: 1200,
      height: 800,
      size: 3,
      createdAt: stamp,
      blob: new Blob(['png'], { type: 'image/png' }),
      ...(sourceAssetId ? { sourceAssetId } : {}),
    };
    await repo.assets.put(record);
    return record.id;
  }
  const original = await asset();
  const legacy: LegacyProjectDocument = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '다중 시안',
    schemaVersion: 2,
    editRevision: 2,
    storageRevision: 0,
    createdAt: stamp,
    updatedAt: stamp,
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: original,
      previewAssetId: original,
      imageWidth: 1200,
      imageHeight: 800,
      room: { ...DEFAULT_ROOM },
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  };
  const project = normalizeProjectDocument(legacy);
  return { name, repo, asset, legacy, project };
}
function append(project: ProjectDocument, count: number) {
  while (project.designs.length < count) project.designs.push(createBlankDesign(project));
}
async function pricedProject() {
  const value = await setup();
  const texture = await value.asset('stone.png');
  const input: MaterialInput = {
    name: '차콜 스톤',
    brand: '',
    code: 'STONE',
    category: 'tile',
    scope: 'personal',
    description: '',
    color: '#aaaaaa',
    finish: '',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    coverAssetId: texture,
    imageAssetIds: [texture],
    textureAssetIds: [texture],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#aaaaaa',
    defaultPattern: 'grid',
    pricing: { unit: 'box', unitPrice: 30000, boxCoverageM2: 1.44, piecesPerBox: 4, wastePercent: 10 },
  };
  const material = await value.repo.materials.create(input);
  const design = getActiveDesign(value.project)!;
  design.scene.surfaces[0].materialVersionId = material.id;
  design.quote = createQuote(value.project, { [material.id]: material });
  design.quote.customerName = '견적 고객';
  design.quote.lines[0].unitPrice = 25500;
  return { ...value, texture, material };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('v3 workspace durable storage', () => {
  it('keeps legacy reads deterministic and read-only, and commits the upgrade only with CAS', async () => {
    const { repo, name, legacy } = await setup();
    const raw = await openDB(name);
    legacy.schemaVersion = 1;
    legacy.storageRevision = 7;
    await raw.put('projects', legacy);
    const a = await repo.projects.load(legacy.id),
      b = await repo.projects.load(legacy.id);
    expect(a).toEqual(b);
    expect(a.schemaVersion).toBe(3);
    expect(a.storageRevision).toBe(7);
    expect(a.editRevision).toBe(2);
    expect(a).not.toHaveProperty('scene');
    expect(a.designs[0].scene).toEqual(legacy.scene);
    expect((await raw.get('projects', legacy.id)).schemaVersion).toBe(1);
    const saved = await repo.projects.save(a, 7);
    expect(saved.storageRevision).toBe(8);
    expect((await raw.get('projects', legacy.id)).schemaVersion).toBe(3);
    await expect(repo.projects.save(b, 7)).rejects.toBeInstanceOf(StorageConflictError);
    raw.close();
  });
  it('round-trips five designs, selected IDs, every quote and cache revision without duplicate blobs', async () => {
    const { repo, name, project } = await pricedProject();
    const source = project.designs[0];
    for (let i = 1; i < 5; i++) project.designs.push(copyDesignDocument(source, '시안 ' + i));
    project.activeDesignId = project.designs[3].id;
    project.designs[3].revision = 12;
    project.designs[3].renderRevision = 7;
    project.shared.revision = 4;
    project.comparisonDesignIds = project.designs.slice(0, 5).map((design) => design.id);
    const saved = await repo.projects.create(project),
      loaded = await repo.projects.load(saved.id);
    expect(loaded).toEqual(saved);
    expect(loaded.designs).toHaveLength(5);
    expect(new Set(loaded.designs.map((design) => design.quote!.id)).size).toBe(5);
    expect(loaded.designs.every((design) => design.quote!.lines[0].unitPrice === 25500)).toBe(true);
    const raw = await openDB(name);
    expect(await raw.count('assets')).toBe(2);
    raw.close();
    expect((await repo.projects.list())[0]).toMatchObject({
      activeDesignId: project.activeDesignId,
      activeDesignRevision: 7,
      sharedRevision: 4,
    });
  });
  it('persists usage snapshots and history with independent price provenance, rejecting missing source versions atomically', async () => {
    const { repo, project, material } = await pricedProject();
    const design = getActiveDesign(project)!;
    design.materialUsage = ensureMaterialUsage(
      design.scene,
      { [material.id]: material },
      undefined,
      design.quote,
    );
    const surfaceId = design.scene.surfaces[0].id;
    design.materialUsage.areas[surfaceId] = { mode: 'manual', areaM2: 12 };
    design.materialUsage.assignments[surfaceId].pricing.unitPrice = 40_000;
    design.renderRevision = 4;
    design.revision = 8;
    design.history.past = [
      { scene: structuredClone(design.scene), materialUsage: structuredClone(design.materialUsage) },
    ];
    const saved = await repo.projects.create(project);
    expect((await repo.projects.load(saved.id)).designs[0].materialUsage).toEqual(design.materialUsage);
    const missing = structuredClone(saved),
      sourceVersionId = crypto.randomUUID();
    missing.designs[0].materialUsage!.assignments[surfaceId].pricing.sourceVersionId = sourceVersionId;
    await expect(repo.projects.save(missing, saved.storageRevision)).rejects.toThrow('연결된 자재 버전');
    expect(await repo.projects.load(saved.id)).toEqual(saved);
    expect(missing.designs[0].materialUsage!.assignments[surfaceId].pricing.sourceVersionId).toBe(
      sourceVersionId,
    );
    const duplicate = await repo.projects.duplicate(saved.id);
    const copied = duplicate.designs[0],
      freshId = copied.scene.surfaces[0].id;
    expect(freshId).not.toBe(surfaceId);
    expect(copied.materialUsage!.areas[freshId].areaM2).toBe(12);
    expect(copied.history.past[0].materialUsage!.assignments[freshId].pricing.sourceVersionId).toBe(
      material.id,
    );
  });
  it('rejects a sixth design and a sixth comparison without replacing the valid revision', async () => {
    const { repo, project } = await setup();
    append(project, 5);
    project.comparisonDesignIds = project.designs.slice(0, 5).map((design) => design.id);
    const saved = await repo.projects.create(project);
    const tooMany = structuredClone(saved);
    tooMany.designs.push(copyDesignDocument(tooMany.designs[0]));
    await expect(repo.projects.save(tooMany, 1)).rejects.toThrow(DESIGN_LIMIT_MESSAGE);
    const tooManyCompared = structuredClone(saved);
    tooManyCompared.comparisonDesignIds.push(crypto.randomUUID());
    await expect(repo.projects.save(tooManyCompared, 1)).rejects.toThrow(COMPARISON_LIMIT_MESSAGE);
    expect(await repo.projects.load(saved.id)).toEqual(saved);
  });
  it('rejects duplicate or dangling selections and nested checkpoints on both validation boundaries', async () => {
    const { repo, project } = await setup();
    append(project, 2);
    const saved = await repo.projects.create(project);
    const cases = [
      { ...saved, activeDesignId: crypto.randomUUID() },
      { ...saved, designs: [saved.designs[0], saved.designs[0]] },
      { ...saved, comparisonDesignIds: [saved.designs[0].id, saved.designs[0].id] },
      { ...saved, comparisonDesignIds: [crypto.randomUUID()] },
      { ...saved, roomHistory: { past: captureWorkspace(saved), future: captureWorkspace(saved) } },
      { ...saved, roomHistory: { past: { ...captureWorkspace(saved), roomHistory: {} } } },
    ];
    for (const invalid of cases) {
      expect(projectV3Schema.safeParse(invalid).success).toBe(false);
      await expect(repo.projects.save(invalid, 1)).rejects.toThrow();
    }
    expect((await repo.projects.load(saved.id)).storageRevision).toBe(1);
  });
  it('duplicates all designs, quotes and checkpoints with remapped IDs and shared immutable assets', async () => {
    const { repo, project } = await pricedProject();
    const source = project.designs[0],
      copied = copyDesignDocument(source);
    project.designs.push(copied);
    project.comparisonDesignIds = [source.id, copied.id];
    project.activeDesignId = copied.id;
    copied.history.past = [{ scene: structuredClone(copied.scene), quote: structuredClone(copied.quote) }];
    project.roomHistory.past = captureWorkspace(project);
    const saved = await repo.projects.create(project),
      duplicate = await repo.projects.duplicate(saved.id);
    expect(duplicate.id).not.toBe(saved.id);
    expect(duplicate.designs).toHaveLength(2);
    expect(duplicate.activeDesignId).toBe(duplicate.designs[1].id);
    expect(duplicate.designs[1].sourceDesignId).toBe(duplicate.designs[0].id);
    expect(duplicate.comparisonDesignIds).toEqual(duplicate.designs.map((design) => design.id));
    expect(duplicate.roomHistory.past!.activeDesignId).toBe(duplicate.activeDesignId);
    expect(duplicate.designs[1].history.past[0].quote!.id).toBe(duplicate.designs[1].quote!.id);
    for (let i = 0; i < 2; i++) {
      const a = saved.designs[i],
        b = duplicate.designs[i];
      expect(b.id).not.toBe(a.id);
      expect(b.scene.originalAssetId).toBe(a.scene.originalAssetId);
      expect(b.scene.surfaces[0].id).not.toBe(a.scene.surfaces[0].id);
      expect(b.quote!.id).not.toBe(a.quote!.id);
      expect(b.quote!.number).not.toBe(a.quote!.number);
      expect(b.quote!.lines[0].sourceSurfaceIds).toEqual([b.scene.surfaces[0].id]);
      expect(b.quote!.sourceSignature).toBe(quoteSourceSignature(b.scene));
    }
    await repo.projects.remove(saved.id);
    await repo.assets.removeUnused();
    for (const id of projectReferences(duplicate).assets) expect((await repo.assets.get(id)).id).toBe(id);
  });
  it('retains assets reachable only through another design, history, checkpoint, or its source ancestor', async () => {
    const { repo, project, asset } = await setup();
    append(project, 2);
    const ancestor = await asset('source.png'),
      current = await asset('second-background.png', ancestor);
    const undo = await asset('undo.png'),
      backupOnly = await asset('checkpoint.png'),
      orphan = await asset('orphan.png');
    project.designs[1].scene.backgroundAssetId = current;
    const frame = { scene: structuredClone(project.designs[1].scene) };
    frame.scene.backgroundAssetId = undo;
    project.designs[1].history.past.push(frame);
    project.roomHistory.past = captureWorkspace(project);
    project.roomHistory.past.designs[0].scene.backgroundAssetId = backupOnly;
    const saved = await repo.projects.create(project);
    expect(await repo.assets.removeUnused()).toBe(1);
    await expect(repo.assets.get(orphan)).rejects.toThrow();
    for (const id of [ancestor, current, undo, backupOnly]) expect((await repo.assets.get(id)).id).toBe(id);
    const stripped = structuredClone(saved);
    stripped.designs.splice(1);
    stripped.roomHistory = {};
    await repo.projects.save(stripped, 1);
    expect(await repo.assets.removeUnused()).toBe(4);
  });
  it('allows an intentional zero-design workspace and lists its shared baseline preview', async () => {
    const { repo, project } = await setup();
    project.designs = [];
    project.activeDesignId = null;
    const saved = await repo.projects.create(project);
    expect((await repo.projects.load(saved.id)).designs).toEqual([]);
    expect((await repo.projects.list())[0]).toMatchObject({
      activeDesignId: null,
      activeDesignRevision: 0,
      previewAssetId: project.shared.baseline.previewAssetId,
    });
  });
  it('rolls back quota failure and missing references across hidden designs while keeping the caller memory', async () => {
    const { repo, project } = await setup();
    append(project, 2);
    const saved = await repo.projects.create(project);
    const missing = structuredClone(saved);
    missing.designs[1].scene.backgroundAssetId = crypto.randomUUID();
    await expect(repo.projects.save(missing, 1)).rejects.toThrow('연결된 이미지');
    const current = structuredClone(saved);
    current.designs[1].name = '저장 전 이름';
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'projects') throw new DOMException('disk full', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    });
    await expect(repo.projects.save(current, 1)).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(current.designs[1].name).toBe('저장 전 이름');
    expect(await repo.projects.load(saved.id)).toEqual(saved);
  });
  it('round-trips five designs with fifty independent history frames each', async () => {
    const { repo, project } = await pricedProject();
    append(project, 5);
    for (const design of project.designs) {
      design.history.past = Array.from({ length: 50 }, (_, index) => {
        const scene = structuredClone(design.scene);
        scene.color.exposure = index / 100;
        return { scene, ...(design.quote ? { quote: structuredClone(design.quote) } : {}) };
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(project)).byteLength;
    const started = performance.now();
    const saved = await repo.projects.create(project);
    const savedAt = performance.now();
    const loaded = await repo.projects.load(saved.id);
    const loadedAt = performance.now();
    expect(loaded.designs.reduce((sum, design) => sum + design.history.past.length, 0)).toBe(250);
    expect(loaded.designs.every((design) => design.history.past[49].scene.color.exposure === 0.49)).toBe(
      true,
    );
    expect(loaded.designs[0].history.past[0].scene).not.toBe(loaded.designs[1].history.past[0].scene);
    console.info(
      'DESIGN_STORAGE_MEASUREMENT',
      JSON.stringify({
        environment: 'Node + fake-indexeddb (browser performance is measured separately)',
        designs: 5,
        historyFrames: 250,
        surfacesPerFrame: 4,
        fixturesPerFrame: 0,
        jsonBytes: bytes,
        saveMs: Math.round(savedAt - started),
        loadMs: Math.round(loadedAt - savedAt),
      }),
    );
  });
  it('sends only a document request for cloud save, never an image upload or AI request', async () => {
    const { project } = await setup();
    append(project, 3);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.invalid');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test-only');
    const fetch = vi.fn(async () => Response.json({ ...project, storageRevision: 1 }));
    vi.stubGlobal('fetch', fetch);
    const cloud = createCloudRepositories();
    const saved = await cloud.projects.save(project, 0);
    expect(saved.designs).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/cloud/projects');
    expect(init.credentials).toBe('same-origin');
    const body = JSON.parse(init.body as string);
    expect(body.document.schemaVersion).toBe(3);
    expect(body.document).not.toHaveProperty('scene');
    expect(body.expectedStorageRevision).toBe(0);
    expect(JSON.stringify(body)).not.toContain('blob:');
    expect(JSON.stringify(body)).not.toContain('data:image');
  });
});
