/** Server adapters only: SQL, R2, authenticated clients and fetch are mocked. No live service. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type ProjectDocument, type ProjectSummary } from '../src/lib/types';
import {
  createProjectSummary,
  PROJECT_SUMMARY_PREVIEW_REVISION,
  readCurrentProjectSummary,
} from '../src/lib/repositories/project-summary';
import {
  designPreviewRoomContextKey,
  projectDesignPreviewRoomContext,
} from '../src/lib/render/design-preview-context';
import { projects } from '../src/lib/d1/projects';
import type { Context } from '../src/lib/d1/database';
import { createCloudRepositories } from '../src/lib/repositories/cloud';
import { storedProjectSchema } from '../src/lib/storage/validation';

const mock = vi.hoisted(() => ({
  sql: vi.fn(),
  read: vi.fn(),
  batch: vi.fn(),
  stage: vi.fn(),
}));
vi.mock('../src/lib/d1/database', () => ({
  sql: mock.sql,
  dataOwnerId: (ctx: Context) => ctx.adminProject?.ownerId ?? ctx.actor.id,
  readDocument: mock.read,
  batch: mock.batch,
  stageObject: mock.stage,
  stamp: () => '2026-09-15T01:00:00.000Z',
  referenceJson: (ids: string[]) => JSON.stringify(ids),
  validateReferences: async () => {},
  assertion: () => ({ kind: 'check' }),
  assetAssertion: () => ({ kind: 'asset-check' }),
  versionAssertion: () => ({ kind: 'version-check' }),
  committedObject: () => ({ kind: 'commit' }),
  queueObject: () => ({ kind: 'queue' }),
  mutationStatement: () => [],
}));
const ctx = { actor: { id: 'tenant-a' }, env: {} } as Context;
const stamp = '2026-09-15T00:00:00.000Z';
function project(withStructure = true): ProjectDocument {
  const assetId = crypto.randomUUID();
  const result = normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'tenant-a',
    name: '원격 구조',
    schemaVersion: 2,
    editRevision: 0,
    storageRevision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: assetId,
      previewAssetId: assetId,
      imageWidth: 1200,
      imageHeight: 800,
      room: { ...DEFAULT_ROOM },
      surfaces: createRoomSurfaces(DEFAULT_ROOM, 1.5),
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  });
  if (withStructure)
    result.designs[0].scene.wallFeatures = [
      {
        version: 1,
        id: crypto.randomUUID(),
        kind: 'closed-niche',
        face: 'back',
        source: 'user',
        leftMm: 300,
        topMm: 300,
        widthMm: 500,
        heightMm: 500,
        depthMm: 200,
      },
    ];
  return result;
}
type Row = { owner: string; object_key: string; summary_json: string };
function listRows(rows: Row[]) {
  mock.sql.mockImplementation((_ctx, query: string, owner: string) => {
    expect(query).toBe(
      'SELECT object_key,summary_json FROM d1_projects WHERE owner_id=? ORDER BY updated_at DESC',
    );
    return { all: async () => ({ results: rows.filter((row) => row.owner === owner) }) };
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [mock.sql, mock.read]) fn.mockReset();
  mock.batch.mockResolvedValue(undefined);
  mock.stage.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('shared current project summary', () => {
  it('derives the same room-context key without changing the document and preserves current cached keys', async () => {
    const p = project(),
      original = structuredClone(p);
    const summary = await createProjectSummary(p);
    expect(summary.designPreviewContextKey).toBe(
      await designPreviewRoomContextKey(projectDesignPreviewRoomContext(p)),
    );
    expect(summary.designPreviewRendererRevision).toBe(PROJECT_SUMMARY_PREVIEW_REVISION);
    expect(readCurrentProjectSummary(JSON.stringify(summary))).toEqual(JSON.parse(JSON.stringify(summary)));
    expect(p).toEqual(original);
  });
  it('marks no-structure summaries too, allowing a no-read photo fast path', async () => {
    const summary = await createProjectSummary(project(false));
    expect(summary).not.toHaveProperty('designPreviewContextKey');
    expect(readCurrentProjectSummary(JSON.stringify(summary))).toMatchObject({
      designPreviewRendererRevision: PROJECT_SUMMARY_PREVIEW_REVISION,
    });
  });
  it.each(['missing-marker', 'old-renderer', 'bad-context-key', 'bad-revision', 'invalid-json'] as const)(
    'does not trust %s as a current cached summary',
    async (state) => {
      const summary: Record<string, unknown> = { ...(await createProjectSummary(project())) };
      if (state === 'missing-marker') delete summary.designPreviewRendererRevision;
      if (state === 'old-renderer')
        summary.designPreviewRendererRevision = 'project-summary-v1/room-view-old';
      if (state === 'bad-context-key') summary.designPreviewContextKey = 'stale';
      if (state === 'bad-revision') summary.activeDesignRevision = -1;
      expect(
        readCurrentProjectSummary(state === 'invalid-json' ? '{broken' : JSON.stringify(summary)),
      ).toBeUndefined();
    },
  );
});

describe('D1 list and writes without a database', () => {
  it('returns current structured/photo summaries unchanged with zero R2 reads or writes', async () => {
    const a = await createProjectSummary(project()),
      b = await createProjectSummary(project(false));
    listRows([
      { owner: 'tenant-a', object_key: 'a', summary_json: JSON.stringify(a) },
      { owner: 'tenant-a', object_key: 'b', summary_json: JSON.stringify(b) },
    ]);
    expect(await projects(ctx, { operation: 'list' })).toEqual(JSON.parse(JSON.stringify([a, b])));
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.stage).not.toHaveBeenCalled();
    expect(mock.batch).not.toHaveBeenCalled();
  });
  it('derives missing/outdated summaries only from the authenticated tenant rows, without rewriting them', async () => {
    const a = project(),
      b = project();
    b.designs[0].scene.wallFeatures![0].depthMm = 350;
    const before = [structuredClone(a), structuredClone(b)];
    const stale = {
      ...(await createProjectSummary(b)),
      designPreviewRendererRevision: 'old-renderer',
      designPreviewContextKey: '0'.repeat(64),
    };
    const rows = [
      { owner: 'tenant-a', object_key: 'a', summary_json: '{}' },
      { owner: 'tenant-a', object_key: 'b', summary_json: JSON.stringify(stale) },
      { owner: 'tenant-b', object_key: 'forbidden', summary_json: '{}' },
    ];
    const storedRows = structuredClone(rows);
    listRows(rows);
    let inflight = 0,
      maxInflight = 0;
    mock.read.mockImplementation(async (_ctx, key: string) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await Promise.resolve();
      inflight--;
      if (key === 'a') return a;
      if (key === 'b') return b;
      throw new Error('foreign read');
    });
    expect(storedProjectSchema.parse(a)).toEqual(a);
    // The loaded D1 value keeps raw key order; validation must not silently replace it.
    expect(await createProjectSummary(normalizeProjectDocument(storedProjectSchema.parse(a)))).not.toEqual(
      await createProjectSummary(a),
    );
    const result = (await projects(ctx, { operation: 'list' })) as ProjectSummary[];
    expect(result).toEqual([await createProjectSummary(a), await createProjectSummary(b)]);
    expect(result[1].designPreviewContextKey).not.toBe(stale.designPreviewContextKey);
    expect(mock.read.mock.calls.map((call) => call[1])).toEqual(['a', 'b']);
    expect(mock.sql.mock.calls[0][2]).toBe('tenant-a');
    expect(maxInflight).toBe(1);
    expect(mock.stage).not.toHaveBeenCalled();
    expect(mock.batch).not.toHaveBeenCalled();
    expect([a, b]).toEqual(before);
    expect(rows).toEqual(storedRows);
  });
  it('does not turn a missing or invalid legacy document into a successful flat fallback', async () => {
    listRows([{ owner: 'tenant-a', object_key: 'broken', summary_json: '{}' }]);
    mock.read.mockRejectedValueOnce(new Error('Committed document is missing'));
    await expect(projects(ctx, { operation: 'list' })).rejects.toThrow('Committed document is missing');
    mock.read.mockResolvedValueOnce({ id: 'malformed' });
    await expect(projects(ctx, { operation: 'list' })).rejects.toThrow();
    expect(mock.batch).not.toHaveBeenCalled();
  });
  it.each(['create', 'save'] as const)(
    'commits one derived summary with the matching %s document and reuses it on listing',
    async (operation) => {
      const p = project();
      mock.read.mockResolvedValue(structuredClone(p));
      mock.sql.mockImplementation((_ctx, query: string, ...values: unknown[]) => ({
        query,
        values,
        first: async () => ({
          id: p.id,
          owner_id: 'tenant-a',
          object_key: 'old',
          storage_revision: p.storageRevision,
          created_at: stamp,
        }),
        all: async () => ({ results: [] }),
      }));
      const saved = (await projects(ctx, {
        operation,
        document: p,
        expectedStorageRevision: p.storageRevision,
      })) as ProjectDocument;
      const change = mock.sql.mock.calls.find((call) =>
        operation === 'create'
          ? call[1].startsWith('INSERT INTO d1_projects')
          : call[1].startsWith('UPDATE d1_projects'),
      )!;
      const persisted = JSON.parse(change[operation === 'create' ? 8 : 6] as string) as ProjectSummary;
      expect(persisted).toEqual(JSON.parse(JSON.stringify(await createProjectSummary(saved))));
      expect(JSON.parse(mock.stage.mock.calls[0][2] as string)).toEqual(saved);
      expect(mock.stage).toHaveBeenCalledTimes(1);
      expect(mock.batch).toHaveBeenCalledTimes(1);
      mock.read.mockClear();
      mock.batch.mockClear();
      mock.stage.mockClear();
      listRows([{ owner: 'tenant-a', object_key: 'saved', summary_json: JSON.stringify(persisted) }]);
      expect(await projects(ctx, { operation: 'list' })).toEqual([persisted]);
      expect(mock.read).not.toHaveBeenCalled();
      expect(mock.stage).not.toHaveBeenCalled();
      expect(mock.batch).not.toHaveBeenCalled();
    },
  );
});

describe('D1 client response boundary', () => {
  it.each(['d1'] as const)(
    'passes %s summary context through the existing client without image transfer',
    async (mode) => {
      const summary = JSON.parse(JSON.stringify(await createProjectSummary(project())));
      const fetcher = vi.fn().mockResolvedValue(Response.json([summary]));
      vi.stubGlobal('fetch', fetcher);
      expect(await createCloudRepositories(mode, 'tenant-a').projects.list()).toEqual([summary]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ operation: 'list' });
    },
  );
});
