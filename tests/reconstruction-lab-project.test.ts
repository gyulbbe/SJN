import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveScene, normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { createLegacyLocalRepositories } from './helpers/legacy-local-repositories';
import type { LegacyProjectRepository as ProjectRepository } from './helpers/legacy-local-repositories';
import { projectReferences, StorageConflictError } from '../src/lib/repositories/references';
import { storedProjectV3Schema } from '../src/lib/storage/validation';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type ImageAssetRecord,
  type MaterialVersion,
  type Scene,
} from '../src/lib/types';
import {
  readLabProjectReport,
  saveLabResultAsProject,
  type LabProjectBundle,
} from './helpers/legacy-lab-project';
import type { ReconstructionLabReport } from '../src/lib/reconstruction/lab';

type AtomicProjectCreate = NonNullable<ProjectRepository['createWithResources']>;
function requireAtomicCreate(
  projects: ProjectRepository,
): asserts projects is ProjectRepository & { createWithResources: AtomicProjectCreate } {
  if (typeof projects.createWithResources !== 'function')
    throw new Error('The local repository must implement atomic project creation.');
}
const old = '2000-01-01T00:00:00.000Z';
const image = (kind: ImageAssetRecord['kind'], sourceAssetId?: string): ImageAssetRecord => ({
  id: crypto.randomUUID(),
  ownerId: 'lab-memory',
  name: kind + '.png',
  kind,
  sourceAssetId,
  mime: 'image/png',
  blob: new Blob(['synthetic image bytes'], { type: 'image/png' }),
  size: 21,
  width: 1600,
  height: 1067,
  createdAt: old,
});
function completed() {
  const photo = image('original'),
    preview = image('preview', photo.id),
    background = image('background'),
    product = image('product'),
    thumbnail = image('thumbnail', background.id);
  const version: MaterialVersion = {
    id: crypto.randomUUID(),
    materialId: crypto.randomUUID(),
    version: 1,
    createdAt: old,
    reconstruction: { version: 2, kind: 'vanity' },
    name: '표준 하부장',
    brand: '',
    code: '',
    category: 'vanity',
    scope: 'personal',
    description: '',
    color: '#ffffff',
    finish: 'matte',
    widthMm: 1200,
    heightMm: 800,
    depthMm: 500,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [],
    views: [{ assetId: product.id, direction: 'front', anchor: { x: 0.5, y: 1 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#dddddd',
    defaultPattern: 'grid',
  };
  const scene: Scene = {
    room: structuredClone(DEFAULT_ROOM),
    originalAssetId: background.id,
    previewAssetId: background.id,
    imageWidth: 1600,
    imageHeight: 1067,
    surfaces: createRoomSurfaces(DEFAULT_ROOM, 1600 / 1067),
    fixtures: [],
    protection: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
  const before = structuredClone(scene);
  before.fixtures.push({
    id: crypto.randomUUID(),
    name: '두 볼 하부장',
    materialVersionId: version.id,
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.4,
    height: 0.4,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
    reconstruction: {
      version: 2,
      kind: 'vanity',
      color: '#ffffff',
      widthMm: 1200,
      heightMm: 800,
      depthMm: 500,
      basinVariant: 'vanity',
      basinShape: 'round',
      bowlCount: 2,
      baseHeightMm: 0,
      provenance: {
        kind: 'model',
        position: 'user',
        dimensions: 'default',
        shape: 'user',
        bowlCount: 'model',
      },
    },
  });
  const review: ReconstructionLabReport['review'] = {
    version: 2,
    analysis: 'partial',
    candidates: [],
    planes: [],
    warnings: ['Held glass remains in the original report.'],
  };
  const document = normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: 'Lab comparison',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 0,
    createdAt: old,
    updatedAt: old,
    scene,
    comparison: {
      before,
      room: structuredClone(DEFAULT_ROOM),
      cameraVersion: 1,
      aspect: 1600 / 1067,
      referenceOriginalAssetId: photo.id,
      referencePreviewAssetId: preview.id,
      status: 'draft',
      review,
    },
    history: { past: [], future: [] },
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    thumbnailAssetId: thumbnail.id,
  });
  const report = {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    inputFingerprint: 'a'.repeat(64),
    room: structuredClone(DEFAULT_ROOM),
    review: structuredClone(review),
    fixtures: structuredClone(before.fixtures),
    pipeline: {
      model: { rawText: '{"original":"synthetic unit response, not AI recognition"}' },
      automaticUnderstanding: { candidates: [{ id: 'source-bowl', bowlCount: 2 }] },
    },
    correctionSnapshot: {
      version: 1,
      draft: { corrections: { 'source-bowl': { shape: 'round' } } },
      changedFieldCount: 1,
    },
  } as unknown as ReconstructionLabReport;
  const projectBundle: LabProjectBundle = {
    version: 1,
    runId: report.runId,
    inputFingerprint: report.inputFingerprint!,
    document,
    assets: [thumbnail, preview, product, background, photo], // Includes forward source references.
    versions: [version],
  };
  return { report, projectBundle };
}
const repositories = () => createLegacyLocalRepositories('lab-project-' + crypto.randomUUID());
afterEach(() => vi.restoreAllMocks());

describe('explicit lab project import (synthetic resources; no AI or renderer)', () => {
  it('persists editable Before, original photo, immutable versions and the completed raw/user archive together', async () => {
    const databaseName = 'lab-project-' + crypto.randomUUID(),
      repo = createLegacyLocalRepositories(databaseName);
    const input = completed(),
      original = structuredClone(input);
    const request = vi.spyOn(globalThis, 'fetch');
    const saved = await saveLabResultAsProject(input, { repositories: repo, name: '보정된 욕실' });
    expect(input).toEqual(original);
    expect(request).not.toHaveBeenCalled();
    const loaded = await createLegacyLocalRepositories(databaseName).projects.load(saved.id);
    expect(loaded.name).toBe('보정된 욕실');
    expect(loaded.storageRevision).toBe(1);
    expect(loaded.shared.comparison?.before).toEqual(
      original.projectBundle.document.shared.comparison?.before,
    );
    expect(getActiveScene(loaded).fixtures).toEqual([]);
    expect(getActiveScene(loaded).surfaces.every((surface) => !surface.materialVersionId)).toBe(true);
    expect(getActiveScene(loaded).room).toEqual(loaded.shared.comparison?.room);
    expect(loaded.shared.comparison?.cameraVersion).toBe(1);
    expect(readLabProjectReport(loaded)).toEqual(original.report);
    expect(storedProjectV3Schema.parse(loaded).shared.comparison?.labSource).toEqual(
      loaded.shared.comparison?.labSource,
    );
    for (const asset of original.projectBundle.assets)
      expect(await (await repo.assets.get(asset.id)).blob.text()).toBe(await asset.blob.text());
    expect(await repo.materials.getVersion(original.projectBundle.versions[0].id)).toEqual(
      original.projectBundle.versions[0],
    );
    expect((await repo.materials.list())[0].material.ownerId).toBe('local');
    expect(await repo.assets.removeUnused()).toBe(0);
    for (const id of projectReferences(loaded).assets)
      await expect(repo.assets.get(id)).resolves.toHaveProperty('id', id);
    input.report.pipeline!.model.rawText = 'later edits cannot relabel the saved result';
    expect(readLabProjectReport(await repo.projects.load(saved.id))).toEqual(original.report);
  });

  it('reloads an archived old reflection rule without migrating its original observations', async () => {
    const repo = repositories(),
      input = completed();
    const historical = {
      version: 1,
      ruleRevision: 'reflection-one-field-v1',
      decisions: [
        {
          candidateId: 'historical-panel',
          status: 'held',
          originalReflection: 'reflected',
          effectiveReflection: 'reflected',
        },
      ],
      observations: [{ rawText: '{"kind":"mirror_cabinet","targetExistence":"directly-visible-object"}' }],
    };
    Object.assign(input.report.pipeline!, { quality: { reflectionRecheck: historical } });
    const preserved = structuredClone(input.report);
    const saved = await saveLabResultAsProject(input, { repositories: repo });
    const loaded = storedProjectV3Schema.parse(await repo.projects.load(saved.id));
    const archived = readLabProjectReport(loaded);
    expect(archived).toEqual(preserved);
    expect(archived!.pipeline!.quality!.reflectionRecheck).toEqual(historical);
    expect(input.report).toEqual(preserved);
  });

  it('retains archived scene resources after Before edits and history expiry, then collects them only when the archive is removed', async () => {
    const repo = repositories(),
      input = completed();
    input.projectBundle.versions[0].name = '하부장 · 재구성 모형';
    input.projectBundle.versions[0].code = 'reconstruction-v2-' + 'a'.repeat(64);
    const saved = await saveLabResultAsProject(input, { repositories: repo });
    const edited = structuredClone(saved);
    edited.shared.comparison!.before.fixtures = [];
    edited.shared.beforeHistory = { past: [], future: [] };
    delete edited.thumbnailAssetId;
    const changed = await repo.projects.save(edited, saved.storageRevision);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await repo.assets.removeUnused()).toBe(0);
    const archivedVersionId = input.projectBundle.versions[0].id;
    expect(projectReferences(changed).versions).toContain(archivedVersionId);
    expect((await repo.materials.getVersion(archivedVersionId)).id).toBe(archivedVersionId);
    expect(readLabProjectReport(changed)?.fixtures).toHaveLength(1);
    for (const asset of input.projectBundle.assets)
      await expect(repo.assets.get(asset.id)).resolves.toHaveProperty('id', asset.id);
    delete changed.shared.comparison!.labSource;
    await repo.projects.save(changed, changed.storageRevision);
    expect(await repo.assets.removeUnused()).toBeGreaterThan(0);
    await expect(repo.materials.getVersion(archivedVersionId)).rejects.toThrow();
  });
  it('keeps existing project edits on double click and concurrent retries of the same completed run', async () => {
    const repo = repositories(),
      input = completed();
    const saves = await Promise.all([
      saveLabResultAsProject(input, { repositories: repo }),
      saveLabResultAsProject(input, { repositories: repo }),
    ]);
    expect(saves[0].id).toBe(saves[1].id);
    expect(await repo.projects.list()).toHaveLength(1);
    const edited = await repo.projects.save({ ...saves[0], name: 'later edit' }, 1);
    const retry = await saveLabResultAsProject(input, {
      repositories: repo,
      name: 'do not replace later edit',
    });
    expect(retry).toEqual(edited);
    expect(await repo.materials.list()).toHaveLength(1);
  });

  it('does not send the bundle or report to cloud storage', async () => {
    const local = repositories();
    requireAtomicCreate(local.projects);
    const create = vi.spyOn(local.projects, 'createWithResources');
    const request = vi.spyOn(globalThis, 'fetch');
    await expect(
      saveLabResultAsProject(completed(), { repositories: { ...local, mode: 'supabase' } }),
    ).rejects.toThrow('로컬');
    expect(create).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps an old report usable without inventing an editable bundle or rerunning analysis', async () => {
    const repo = repositories();
    await expect(
      saveLabResultAsProject({ report: completed().report }, { repositories: repo }),
    ).rejects.toThrow('AI 재분석은 필요하지');
    expect(await repo.projects.list()).toEqual([]);
  });

  it.each(['run', 'photo', 'room', 'fixtures', 'after'] as const)(
    'rejects mismatched completed %s before any persistent writes',
    async (change) => {
      const repo = repositories(),
        input = completed();
      if (change === 'run') input.report.runId = crypto.randomUUID();
      if (change === 'photo') input.report.inputFingerprint = 'b'.repeat(64);
      if (change === 'room') input.report.room.widthMm += 100;
      if (change === 'fixtures') input.report.fixtures[0].reconstruction!.bowlCount = 1;
      if (change === 'after')
        input.projectBundle.document.designs[0].scene.fixtures = structuredClone(input.report.fixtures);
      await expect(saveLabResultAsProject(input, { repositories: repo })).rejects.toThrow();
      expect(await repo.projects.list()).toEqual([]);
      expect(await repo.materials.list()).toEqual([]);
      await expect(repo.assets.get(input.projectBundle.assets[0].id)).rejects.toThrow();
    },
  );

  it('rejects an incomplete resource closure and leaves the original lab result intact', async () => {
    const repo = repositories(),
      input = completed();
    input.projectBundle.assets = input.projectBundle.assets.filter((asset) => asset.kind !== 'product');
    const original = structuredClone(input);
    await expect(saveLabResultAsProject(input, { repositories: repo })).rejects.toThrow('묶음');
    expect(input).toEqual(original);
    expect(await repo.projects.list()).toEqual([]);
    expect(await repo.materials.list()).toEqual([]);
  });

  it('rolls back assets and versions when the final project write fails, preserving existing projects and retry input', async () => {
    const repo = repositories(),
      existing = await saveLabResultAsProject(completed(), { repositories: repo });
    const input = completed(),
      original = structuredClone(input),
      add = IDBObjectStore.prototype.add;
    const fail = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'projects') throw new DOMException('disk full', 'QuotaExceededError');
      return add.call(this, value, key);
    });
    await expect(saveLabResultAsProject(input, { repositories: repo })).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    fail.mockRestore();
    expect(input).toEqual(original);
    expect(await repo.projects.load(existing.id)).toEqual(existing);
    expect(await repo.projects.list()).toHaveLength(1);
    expect(await repo.materials.list()).toHaveLength(1);
    for (const asset of input.projectBundle.assets) await expect(repo.assets.get(asset.id)).rejects.toThrow();
    await expect(repo.materials.getVersion(input.projectBundle.versions[0].id)).rejects.toThrow();
    await expect(saveLabResultAsProject(input, { repositories: repo })).resolves.toHaveProperty(
      'id',
      input.projectBundle.document.id,
    );
  });

  it('does not replace an existing immutable asset on an ID collision', async () => {
    const repo = repositories(),
      input = completed(),
      collision = input.projectBundle.assets[0];
    // Add the source before its dependent thumbnail through the ordinary repository API.
    const source = input.projectBundle.assets.find((asset) => asset.id === collision.sourceAssetId)!;
    await repo.assets.put(source);
    await repo.assets.put({ ...collision, name: 'existing image' });
    await expect(saveLabResultAsProject(input, { repositories: repo })).rejects.toBeInstanceOf(
      StorageConflictError,
    );
    expect((await repo.assets.get(collision.id)).name).toBe('existing image');
    expect(await repo.projects.list()).toEqual([]);
  });

  it('cancels before or during the transaction without leaving a partial import', async () => {
    const repo = repositories(),
      input = completed(),
      before = new AbortController();
    before.abort();
    await expect(
      saveLabResultAsProject(input, { repositories: repo, signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const during = new AbortController(),
      add = IDBObjectStore.prototype.add;
    const abort = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = add.call(this, value, key);
      if (this.name === 'assets') during.abort();
      return request;
    });
    await expect(
      saveLabResultAsProject(input, { repositories: repo, signal: during.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    abort.mockRestore();
    expect(await repo.projects.list()).toEqual([]);
    expect(await repo.materials.list()).toEqual([]);
    for (const asset of input.projectBundle.assets) await expect(repo.assets.get(asset.id)).rejects.toThrow();
  });

  it('preserves a successful commit if the page cancels after the transaction has finished', async () => {
    const repo = repositories(),
      controller = new AbortController();
    requireAtomicCreate(repo.projects);
    const create: AtomicProjectCreate = repo.projects.createWithResources.bind(repo.projects);
    vi.spyOn(repo.projects, 'createWithResources').mockImplementation(
      async (...args: Parameters<AtomicProjectCreate>): ReturnType<AtomicProjectCreate> => {
        const saved = await create(...args);
        controller.abort();
        return saved;
      },
    );
    const result = await saveLabResultAsProject(completed(), {
      repositories: repo,
      signal: controller.signal,
    });
    expect(await repo.projects.load(result.id)).toEqual(result);
  });

  it.each(['image-size', 'image-dimensions', 'source-cycle', 'report-size'] as const)(
    'retains existing guards for %s',
    async (invalid) => {
      const repo = repositories(),
        input = completed();
      if (invalid === 'image-size')
        input.projectBundle.assets[0].blob = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]);
      if (invalid === 'image-dimensions') (input.projectBundle.assets[0] as ImageAssetRecord).width = 0;
      if (invalid === 'source-cycle')
        input.projectBundle.assets[0].sourceAssetId = input.projectBundle.assets[0].id;
      if (invalid === 'report-size') input.report.pipeline!.model.rawText = 'x'.repeat(10 * 1024 * 1024);
      await expect(saveLabResultAsProject(input, { repositories: repo })).rejects.toThrow();
      expect(await repo.projects.list()).toEqual([]);
    },
  );
});
