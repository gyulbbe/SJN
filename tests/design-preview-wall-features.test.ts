import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR, type ProjectDocument, type Scene, type MaterialVersion } from '../src/lib/types';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { createRoomDesignPreviewRenderer } from '../src/lib/render/room-design-preview';
import { defaultRoomView } from '../src/lib/room-viewer/view-state';
import {
  designPreviewMaterialIds,
  designPreviewRoomContextKey,
  projectDesignPreviewRoomContext,
} from '../src/lib/render/design-preview-context';
import {
  DesignPreviewService,
  DesignPreviewCancelled,
  designPreviewKey,
  type DesignPreviewInput,
  type DesignPreviewRenderer,
} from '../src/lib/render/design-preview';
import {
  DESIGN_RENDER_REVISION,
  getCachedDesignThumbnail,
  writeDesignPreviewCache,
} from '../src/lib/render/design-preview-cache';

const spatial = vi.hoisted(() => ({
  instances: [] as Array<{
    setSnapshot: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    export: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('../src/lib/room-viewer/renderer', () => ({
  RoomViewerRenderer: class {
    maxOutputEdge = 4096;
    setSnapshot = vi.fn(async () => {});
    render = vi.fn(() => ({ width: 360, height: 240 }) as HTMLCanvasElement);
    export = vi.fn(async () => new Blob(['room PNG']));
    dispose = vi.fn();
    constructor() {
      spatial.instances.push(this);
    }
  },
}));

const scene = (features = false): Scene => ({
  originalAssetId: 'original',
  previewAssetId: 'preview',
  imageWidth: 1200,
  imageHeight: 800,
  room: { ...DEFAULT_ROOM },
  surfaces: createRoomSurfaces(DEFAULT_ROOM),
  fixtures: [],
  protection: { polygon: [], strokes: [] },
  color: { ...DEFAULT_COLOR },
  ...(features
    ? {
        wallFeatures: [
          {
            version: 1,
            id: '10000000-0000-4000-8000-000000000001',
            kind: 'closed-niche',
            source: 'user',
            face: 'back',
            leftMm: 700,
            topMm: 500,
            widthMm: 500,
            heightMm: 500,
            depthMm: 200,
          },
        ],
      }
    : {}),
});
function project(): ProjectDocument {
  const baseline = scene(true),
    now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '방',
    schemaVersion: 3,
    editRevision: 0,
    storageRevision: 0,
    createdAt: now,
    updatedAt: now,
    roomView: defaultRoomView(),
    roomHistory: {},
    shared: { baseline, revision: 0, beforeHistory: { past: [], future: [] } },
    designs: ['a', 'b'].map((id) => ({
      id,
      name: id,
      scene: scene(),
      revision: 1,
      history: { past: [], future: [] },
      createdAt: now,
      updatedAt: now,
    })),
    activeDesignId: 'a',
    comparisonDesignIds: ['a', 'b'],
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
  };
}
function input(p = project()): DesignPreviewInput {
  return {
    projectId: p.id,
    sharedRevision: 0,
    design: p.designs[0],
    materials: {},
    roomContext: projectDesignPreviewRoomContext(p),
  };
}
function harness(capture = async () => new Blob(['PNG'])) {
  const photo: DesignPreviewRenderer = {
    maxOutputEdge: 4096,
    setSnapshot: vi.fn(async () => {}),
    render: vi.fn(() => ({ width: 360, height: 240 }) as HTMLCanvasElement),
    exportImage: vi.fn(async () => new Blob(['photo'])),
    dispose: vi.fn(),
  };
  const createRenderer = vi.fn(() => photo),
    writeCache = vi.fn(async (record: unknown) => {
      void record;
    });
  const service = new DesignPreviewService(vi.fn(), {
    createRenderer,
    capture,
    readCache: async () => undefined,
    writeCache,
  });
  return { service, photo, createRenderer, writeCache };
}
afterEach(() => {
  vi.unstubAllGlobals();
  spatial.instances.length = 0;
});

describe('wall-feature preview boundary — renderer calls mocked, no visual quality claim', () => {
  it('uses shared Before and all current designs, deduplicating equivalent scenes and excluding history', () => {
    const p = project(),
      original = structuredClone(p);
    p.designs[1].scene.color.warmth = 0.1;
    const context = projectDesignPreviewRoomContext(p)!;
    expect(context.beforeScene).toBe(p.shared.baseline);
    expect(context.fitScenes).toEqual([p.shared.baseline, p.designs[0].scene, p.designs[1].scene]);
    expect(context.view).toEqual(defaultRoomView());
    const oldOnly = project();
    oldOnly.shared.beforeHistory.past.push({ baseline: original.shared.baseline });
    oldOnly.shared.baseline = scene();
    expect(projectDesignPreviewRoomContext(oldOnly)).toBeUndefined();
    p.designs = [];
    p.activeDesignId = null;
    expect(projectDesignPreviewRoomContext(p)?.fitScenes).toEqual([p.shared.baseline]);
  });

  it('uses room renderer for a flat After when the shared Before has a feature, preserving view and fit materials', async () => {
    const p = project();
    p.shared.baseline.surfaces[0].materialVersionId = 'before-tile';
    p.designs[1].scene.surfaces[0].materialVersionId = 'other-tile';
    p.roomView!.pan.x = 0.15;
    const source = input(p),
      h = harness();
    source.materials = Object.fromEntries(
      ['before-tile', 'other-tile', 'unused'].map((id) => [id, { id } as MaterialVersion]),
    );
    const original = structuredClone(source);
    await h.service.request('card', source);
    expect(h.createRenderer).not.toHaveBeenCalled();
    const renderer = spatial.instances[0];
    expect(renderer.setSnapshot.mock.calls[0][0]).toEqual({
      scene: source.design.scene,
      beforeScene: p.shared.baseline,
      roomView: p.roomView,
      materials: { 'before-tile': { id: 'before-tile' }, 'other-tile': { id: 'other-tile' } },
    });
    expect(renderer.setSnapshot.mock.calls[0][2]).toEqual({ fitScenes: source.roomContext!.fitScenes });
    expect(renderer.render).toHaveBeenCalledWith(360, 240, source.roomContext!.view, 'after');
    expect(h.writeCache.mock.calls[0][0]).toMatchObject({
      contextKey: await designPreviewRoomContextKey(source.roomContext),
    });
    expect(source).toEqual(original);
    h.service.dispose();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it('invalidates keys for shared camera, other-design geometry and its used material without changing the active revision', async () => {
    const source = input();
    source.roomContext!.fitScenes[1].surfaces[0].materialVersionId = 'tile';
    source.materials.tile = { id: 'tile', color: '#fff' } as MaterialVersion;
    const key = await designPreviewKey(source);
    for (const change of [
      (v: DesignPreviewInput) => {
        v.roomContext!.view.zoom = 2;
      },
      (v: DesignPreviewInput) => {
        v.roomContext!.beforeScene.wallFeatures![0].depthMm = 300;
      },
      (v: DesignPreviewInput) => {
        v.roomContext!.fitScenes[1].color.warmth = 0.4;
      },
      (v: DesignPreviewInput) => {
        v.materials.tile.color = '#ddd';
      },
    ]) {
      const next = structuredClone(source);
      change(next);
      expect(await designPreviewKey(next)).not.toBe(key);
    }
    const renamed = structuredClone(source);
    renamed.design.name = '다른 이름';
    expect(await designPreviewKey(renamed)).toBe(key);
    expect(designPreviewMaterialIds(source.design.scene, source.roomContext)).toContain('tile');
  });

  it('does not silently fall back to PhotoCompositor when structure context is missing', async () => {
    const source = input();
    source.design.scene = scene(true);
    delete source.roomContext;
    const h = harness();
    await expect(h.service.request('invalid', source)).rejects.toThrow('공통 공간 시점');
    expect(h.createRenderer).not.toHaveBeenCalled();
    h.service.dispose();
  });

  it('serially changes renderer kinds and disposes the old context before creating another', async () => {
    const h = harness(),
      room = input(),
      photo = structuredClone(room);
    delete photo.roomContext;
    await h.service.request('photo', photo);
    await h.service.request('room', room);
    expect(h.photo.dispose).toHaveBeenCalledTimes(1);
    await h.service.request('photo2', { ...photo, sharedRevision: 2 });
    expect(spatial.instances[0].dispose).toHaveBeenCalledTimes(1);
    h.service.dispose();
  });

  it('captures view and fit scenes before queued exports and uses the spatial PNG route', async () => {
    const source = input(),
      expected = structuredClone(source),
      h = harness();
    const promise = h.service.exportDesign('png', source);
    source.roomContext!.view.zoom = 4;
    source.roomContext!.beforeScene.wallFeatures![0].depthMm = 700;
    expect(await (await promise).text()).toBe('room PNG');
    const renderer = spatial.instances[0];
    expect(renderer.setSnapshot.mock.calls[0][2]).toEqual({ fitScenes: expected.roomContext!.fitScenes });
    expect(renderer.export).toHaveBeenCalledWith(expected.roomContext!.view, {
      format: 'png',
      mode: 'after',
      longEdge: 4096,
    });
    h.service.dispose();
  });

  it('preserves the requested long edge for a non-square spatial export', async () => {
    const source = input(),
      renderer = createRoomDesignPreviewRenderer();
    const snapshot = {
      scene: source.design.scene,
      beforeScene: source.roomContext!.beforeScene,
      materials: {},
    };
    await renderer.setSnapshot(snapshot, vi.fn(), { roomContext: source.roomContext });
    await renderer.exportImage(snapshot, 600, 400, 'image/png', false);
    expect(spatial.instances[0].export).toHaveBeenCalledWith(source.roomContext!.view, {
      format: 'png',
      mode: 'after',
      longEdge: 600,
    });
    renderer.dispose();
  });

  it('rejects comparison exports with different spatial views before allocating a renderer', async () => {
    const a = input(),
      b = structuredClone(a);
    b.design.id = 'b';
    b.roomContext!.view.zoom = 2;
    const h = harness();
    await expect(h.service.exportComparison('grid', [a, b])).rejects.toThrow('공통 공간 시점');
    expect(spatial.instances).toHaveLength(0);
    expect(h.createRenderer).not.toHaveBeenCalled();
    h.service.dispose();
  });

  it('exports every comparison cell with identical fit context and closes decoded bitmaps', async () => {
    const drawImage = vi.fn(),
      close = vi.fn();
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 1,
        height: 1,
        getContext: () => ({ drawImage, fillRect: vi.fn() }),
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['grid'])),
      }),
    });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ close })),
    );
    const a = input(),
      b = structuredClone(a);
    b.design.id = 'b';
    const h = harness();
    await h.service.exportComparison('grid', [a, b]);
    const renderer = spatial.instances[0];
    expect(spatial.instances).toHaveLength(1);
    expect(renderer.setSnapshot).toHaveBeenCalledTimes(2);
    for (const call of renderer.setSnapshot.mock.calls)
      expect(call[2]).toEqual({ fitScenes: a.roomContext!.fitScenes });
    expect(renderer.export).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    h.service.dispose();
  });

  it('late cancellation never writes a spatial thumbnail and disposes its renderer', async () => {
    let release!: () => void;
    const h = harness(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => resolve(new Blob(['late']));
        }),
    );
    const pending = h.service.request('pending', input());
    const rejected = expect(pending).rejects.toBeInstanceOf(DesignPreviewCancelled);
    await vi.waitFor(() => expect(release).toBeDefined());
    h.service.dispose();
    release();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.writeCache).not.toHaveBeenCalled();
    expect(spatial.instances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('does not return a legacy or another-view disposable thumbnail for the same project revision', async () => {
    const identity = { projectId: crypto.randomUUID(), designId: 'a', revision: 1, sharedRevision: 0 };
    const record = {
      ...identity,
      key: crypto.randomUUID(),
      rendererRevision: DESIGN_RENDER_REVISION,
      purpose: 'thumbnail' as const,
      width: 360,
      height: 240,
      blob: new Blob(['old']),
      updatedAt: Date.now(),
    };
    await writeDesignPreviewCache(record);
    expect(await getCachedDesignThumbnail({ ...identity, contextKey: 'room-A' })).toBeUndefined();
    await writeDesignPreviewCache({
      ...record,
      key: crypto.randomUUID(),
      contextKey: 'room-A',
      blob: new Blob(['room']),
    });
    expect(await (await getCachedDesignThumbnail({ ...identity, contextKey: 'room-A' }))?.text()).toBe(
      'room',
    );
    expect(await getCachedDesignThumbnail({ ...identity, contextKey: 'room-B' })).toBeUndefined();
  });
});
