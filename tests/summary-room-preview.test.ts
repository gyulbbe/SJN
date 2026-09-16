import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR, type ProjectDocument } from '../src/lib/types';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { defaultRoomView } from '../src/lib/room-viewer/view-state';
import { createLocalRepositories } from '../src/lib/repositories/local';
import type { Repositories } from '../src/lib/repositories/contracts';
import {
  designPreviewRoomContextKey,
  projectDesignPreviewRoomContext,
} from '../src/lib/render/design-preview-context';
import { prepareSummaryRoomThumbnail } from '../src/lib/render/summary-design-preview';

const boundary = vi.hoisted(() => ({
  request: vi.fn(),
  instances: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
}));
vi.mock('../src/lib/render/design-preview', () => ({
  DesignPreviewCancelled: class extends Error {},
  DesignPreviewService: class {
    dispose = vi.fn();
    request = boundary.request;
    constructor() {
      boundary.instances.push(this);
    }
  },
}));
function project(): ProjectDocument {
  const scene = {
    originalAssetId: 'original',
    previewAssetId: 'preview',
    imageWidth: 1200,
    imageHeight: 800,
    room: { ...DEFAULT_ROOM },
    surfaces: createRoomSurfaces(DEFAULT_ROOM),
    fixtures: [],
    protection: { polygon: [], strokes: [] },
    color: { ...DEFAULT_COLOR },
  };
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '목록',
    schemaVersion: 3,
    editRevision: 0,
    storageRevision: 0,
    createdAt: now,
    updatedAt: now,
    roomView: defaultRoomView(),
    roomHistory: {},
    shared: {
      baseline: {
        ...scene,
        wallFeatures: [
          {
            version: 1,
            id: crypto.randomUUID(),
            kind: 'closed-niche',
            source: 'user',
            face: 'back',
            leftMm: 500,
            topMm: 600,
            widthMm: 500,
            heightMm: 500,
            depthMm: 250,
          },
        ],
      },
      revision: 0,
      beforeHistory: { past: [], future: [] },
    },
    designs: [
      {
        id: crypto.randomUUID(),
        name: '시안',
        revision: 1,
        scene: structuredClone(scene),
        createdAt: now,
        updatedAt: now,
        history: { past: [], future: [] },
      },
    ],
    activeDesignId: null,
    comparisonDesignIds: [],
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  };
}
async function identity(p: ProjectDocument) {
  const active = p.designs.find((d) => d.id === p.activeDesignId);
  return {
    projectId: p.id,
    designId: active?.id ?? 'baseline',
    revision: active?.revision ?? 0,
    sharedRevision: p.shared.revision,
    contextKey: await designPreviewRoomContextKey(projectDesignPreviewRoomContext(p)),
  };
}
function repository(p: ProjectDocument) {
  return {
    projects: { load: vi.fn(async () => structuredClone(p)), save: vi.fn(), create: vi.fn() },
    materials: { getVersion: vi.fn(async (id: string) => ({ id })) },
    assets: { get: vi.fn(), put: vi.fn() },
    mode: 'local',
  } as unknown as Repositories;
}
afterEach(() => {
  boundary.instances.length = 0;
  boundary.request.mockReset();
});
describe('summary room image preparation — mock renderer, real context/cache boundary', () => {
  it('local listing invalidates its context key for common view/other design while preserving stored documents', async () => {
    const dbName = 'room-summary-' + crypto.randomUUID(),
      repo = createLocalRepositories(dbName);
    await repo.projects.list();
    const db = await openDB(dbName),
      p = project();
    p.activeDesignId = p.designs[0].id;
    await db.put('projects', p);
    const first = (await repo.projects.list())[0];
    expect(first.designPreviewContextKey).toBe(
      await designPreviewRoomContextKey(projectDesignPreviewRoomContext(p)),
    );
    expect(await db.get('projects', p.id)).toEqual(p);
    p.roomView!.zoom = 2;
    await db.put('projects', p);
    const second = (await repo.projects.list())[0];
    expect(second.activeDesignRevision).toBe(first.activeDesignRevision);
    expect(second.sharedRevision).toBe(first.sharedRevision);
    expect(second.designPreviewContextKey).not.toBe(first.designPreviewContextKey);
    delete p.shared.baseline.wallFeatures;
    await db.put('projects', p);
    expect((await repo.projects.list())[0]).not.toHaveProperty('designPreviewContextKey');
    db.close();
  });

  it('loads the exact saved context and all fit-scene materials without writing project/assets', async () => {
    const p = project();
    p.activeDesignId = p.designs[0].id;
    p.shared.baseline.surfaces[0].materialVersionId = 'before-tile';
    const repo = repository(p),
      original = structuredClone(p);
    boundary.request.mockResolvedValue({});
    await prepareSummaryRoomThumbnail(repo, await identity(p), new AbortController().signal);
    expect(boundary.request.mock.calls[0][1]).toMatchObject({
      roomContext: projectDesignPreviewRoomContext(p),
      materials: { 'before-tile': { id: 'before-tile' } },
    });
    expect(repo.materials.getVersion).toHaveBeenCalledWith('before-tile');
    expect(repo.projects.save).not.toHaveBeenCalled();
    expect(repo.assets.put).not.toHaveBeenCalled();
    expect(p).toEqual(original);
    expect(boundary.instances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('handles baseline-only projects without fabricating a persisted design', async () => {
    const p = project();
    p.designs = [];
    const repo = repository(p);
    boundary.request.mockResolvedValue({});
    await prepareSummaryRoomThumbnail(repo, await identity(p), new AbortController().signal);
    expect(boundary.request.mock.calls[0][1].design).toMatchObject({
      id: 'baseline',
      revision: 0,
      scene: p.shared.baseline,
    });
    expect(repo.projects.create).not.toHaveBeenCalled();
    expect(repo.projects.save).not.toHaveBeenCalled();
  });

  it('rejects stale view and revision before allocating a renderer', async () => {
    const p = project();
    p.activeDesignId = p.designs[0].id;
    const repo = repository(p),
      id = await identity(p);
    await expect(
      prepareSummaryRoomThumbnail(repo, { ...id, contextKey: 'old-view' }, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      prepareSummaryRoomThumbnail(repo, { ...id, revision: 999 }, new AbortController().signal),
    ).rejects.toThrow();
    expect(boundary.instances).toHaveLength(0);
  });

  it('serializes different project cards and skips aborted jobs before they read or render', async () => {
    const p = project(),
      q = project();
    p.designs = [];
    q.designs = [];
    const a = repository(p),
      b = repository(q);
    let release!: () => void;
    boundary.request.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = prepareSummaryRoomThumbnail(a, await identity(p), new AbortController().signal);
    await vi.waitFor(() => expect(release).toBeDefined());
    const cancel = new AbortController();
    const second = prepareSummaryRoomThumbnail(b, await identity(q), cancel.signal);
    const rejected = expect(second).rejects.toThrow();
    cancel.abort();
    expect(b.projects.load).not.toHaveBeenCalled();
    release();
    await first;
    await rejected;
    expect(b.projects.load).not.toHaveBeenCalled();
    expect(boundary.instances).toHaveLength(1);
    expect(boundary.instances[0].dispose).toHaveBeenCalledTimes(1);
  });
});
