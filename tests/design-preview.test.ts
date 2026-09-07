import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR, DEFAULT_TILE, type MaterialVersion, type RenderSnapshot } from '../src/lib/types';
import {
  acquireDesignPreviewSession,
  DesignPreviewService,
  DesignPreviewCancelled,
  designPreviewKey,
  designPreviewSize,
  designGrid,
  type DesignPreviewInput,
  type DesignPreviewRenderer,
} from '../src/lib/render/design-preview';
import {
  clampDesignView,
  comparisonPreviewEdge,
  fitDesignBox,
  fittedDesignView,
  panDesignView,
  zoomDesignView,
} from '../src/lib/render/design-comparison-view';

function input(id = 'a'): DesignPreviewInput {
  return {
    projectId: 'project',
    sharedRevision: 0,
    design: {
      id,
      name: '시안 ' + id,
      revision: 1,
      scene: {
        originalAssetId: 'original',
        previewAssetId: 'preview',
        imageWidth: 4096,
        imageHeight: 2730,
        surfaces: [],
        fixtures: [],
        protection: { polygon: [], strokes: [] },
        color: { ...DEFAULT_COLOR },
      },
    },
    materials: {},
  };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  const snapshots: RenderSnapshot[] = [];
  const render = vi.fn(() => ({ width: 360, height: 240 }) as HTMLCanvasElement);
  const dispose = vi.fn();
  const prepare = vi.fn(async (snapshot: RenderSnapshot) => {
    snapshots.push(snapshot);
  });
  const renderer: DesignPreviewRenderer = {
    maxOutputEdge: 4096,
    setSnapshot: prepare,
    render,
    dispose,
    exportImage: vi.fn(async () => new Blob(['export'])),
  };
  const createRenderer = vi.fn(() => renderer);
  const readCache = vi.fn(async () => undefined);
  const writeCache = vi.fn(async () => undefined);
  const capture = vi.fn(async () => new Blob([JSON.stringify(snapshots.at(-1)?.scene.color)]));
  const reader = vi.fn();
  const service = new DesignPreviewService(reader, { createRenderer, readCache, writeCache, capture });
  return {
    service,
    snapshots,
    prepare,
    render,
    dispose,
    createRenderer,
    readCache,
    writeCache,
    capture,
    renderer,
  };
}

describe('serial design preview queue', () => {
  it('keeps decoded assets across same-flush subscriber handover and disposes a real unmount', async () => {
    vi.useFakeTimers();
    try {
      const id = crypto.randomUUID(),
        reader = vi.fn();
      const first = acquireDesignPreviewSession(id, reader);
      first.release();
      const replacement = acquireDesignPreviewSession(id, reader);
      expect(replacement.service).toBe(first.service);
      await vi.runAllTimersAsync();
      const joined = acquireDesignPreviewSession(id, reader);
      expect(joined.service).toBe(first.service);
      replacement.release();
      joined.release();
      await vi.runAllTimersAsync();
      await expect(first.service.request('closed', input())).rejects.toBeInstanceOf(DesignPreviewCancelled);
      const next = acquireDesignPreviewSession(id, reader);
      expect(next.service).not.toBe(first.service);
      next.release();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses a single renderer for five independent images and reuses a finished immutable snapshot', async () => {
    const h = harness(),
      gate = deferred();
    h.prepare.mockImplementationOnce(async (snapshot) => {
      h.snapshots.push(snapshot);
      await gate.promise;
    });
    const jobs = Array.from({ length: 5 }, (_, n) => h.service.request(String(n), input(String(n))));
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledTimes(1));
    expect(h.render).not.toHaveBeenCalled();
    gate.resolve();
    const results = await Promise.all(jobs);
    expect(h.createRenderer).toHaveBeenCalledTimes(1);
    expect(h.render).toHaveBeenCalledTimes(5);
    expect(new Set(results.map((result) => result.key)).size).toBe(5);
    const cached = await h.service.request('again', input('0'));
    expect(cached).toBe(results[0]);
    expect(h.render).toHaveBeenCalledTimes(5);
    h.service.dispose();
    expect(h.dispose).toHaveBeenCalledTimes(1);
  });
  it('rejects an old revision finishing late and never writes its PNG', async () => {
    const h = harness(),
      gate = deferred();
    h.prepare.mockImplementationOnce(async (snapshot) => {
      h.snapshots.push(snapshot);
      await gate.promise;
    });
    const old = h.service.request('card', input()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.prepare).toHaveBeenCalledTimes(1));
    const newer = input();
    newer.design.revision++;
    newer.design.scene.color.warmth = 0.3;
    const current = h.service.request('card', newer);
    expect(await old).toBeInstanceOf(DesignPreviewCancelled);
    gate.resolve();
    const result = await current;
    expect(await result.blob.text()).toContain('0.3');
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.writeCache).toHaveBeenCalledTimes(1);
    h.service.dispose();
  });
  it('captures edits by value before the job waits for cache or another render', async () => {
    const h = harness(),
      source = input(),
      original = structuredClone(source.design.scene);
    const pending = h.service.request('card', source);
    source.design.scene.color.exposure = 4;
    source.design.scene.previewAssetId = 'uncommitted';
    await pending;
    expect(h.snapshots[0].scene).toEqual(original);
    expect(h.prepare.mock.calls[0][0]).not.toBe(source.design.scene);
    h.service.dispose();
  });
  it('cancels queued and active work on disposal without publishing or writing a late image', async () => {
    const h = harness(),
      gate = deferred<Blob>();
    h.capture.mockImplementationOnce(() => gate.promise);
    const active = h.service.request('active', input()).catch((error: unknown) => error);
    const queued = h.service.request('queued', input('b')).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledTimes(1));
    h.service.dispose();
    h.service.dispose();
    expect(await active).toBeInstanceOf(DesignPreviewCancelled);
    expect(await queued).toBeInstanceOf(DesignPreviewCancelled);
    gate.resolve(new Blob(['late']));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.writeCache).not.toHaveBeenCalled();
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    await expect(h.service.request('closed', input())).rejects.toBeInstanceOf(DesignPreviewCancelled);
  });
  it('uses 360px thumbnails and bounded comparison resolution without touching scene color or selection', async () => {
    const h = harness(),
      source = input();
    source.design.scene.color.exposure = 0.7;
    await h.service.request('thumbnail', source);
    expect(h.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ scene: source.design.scene }),
      expect.any(Function),
      { maxPreviewEdge: 360 },
    );
    expect(h.render).toHaveBeenLastCalledWith(360, 240, 'after');
    const compare = { ...source, purpose: 'comparison' as const, edge: 9999 };
    expect(designPreviewSize(compare)).toEqual({ width: 2048, height: 1365 });
    await h.service.request('comparison', compare);
    expect(h.prepare).toHaveBeenLastCalledWith(expect.anything(), expect.any(Function), {
      maxPreviewEdge: 2048,
    });
    expect(source.design.scene.color.exposure).toBe(0.7);
    h.service.dispose();
  });
  it('exports the full original scene through the same renderer at the 4096 limit', async () => {
    const h = harness(),
      source = input();
    await h.service.exportDesign('download', source);
    expect(h.renderer.exportImage).toHaveBeenCalledWith(
      { scene: source.design.scene, materials: {} },
      4096,
      4096,
      'image/png',
      false,
    );
    h.service.dispose();
  });
});

describe('design cache identity', () => {
  it('ignores display name and unused inventory but changes for image, used material, revision and shared geometry', async () => {
    const source = input();
    source.design.scene.surfaces.push({
      id: 'wall',
      name: '벽',
      kind: 'wall',
      mask: { polygon: [], strokes: [] },
      quad: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      widthMm: 3000,
      heightMm: 2400,
      calibrated: true,
      materialVersionId: 'tile',
      tile: { ...DEFAULT_TILE },
      color: { ...DEFAULT_COLOR },
    });
    source.materials.tile = { id: 'tile', color: '#ddd', textureAssetIds: ['texture'] } as MaterialVersion;
    const original = await designPreviewKey(source);
    const renamed = structuredClone(source);
    renamed.design.name = '다른 이름';
    renamed.materials.unused = { id: 'unused' } as MaterialVersion;
    expect(await designPreviewKey(renamed)).toBe(original);
    for (const mutate of [
      (value: DesignPreviewInput) => value.design.revision++,
      (value: DesignPreviewInput) => value.sharedRevision++,
      (value: DesignPreviewInput) => {
        value.design.scene.color.warmth = 0.2;
      },
      (value: DesignPreviewInput) => {
        value.design.scene.backgroundAssetId = 'new-background';
      },
      (value: DesignPreviewInput) => {
        value.materials.tile.textureAssetIds = ['new-texture'];
      },
      (value: DesignPreviewInput) => {
        value.design.scene.surfaces[0].widthMm = 4200;
      },
    ]) {
      const changed = structuredClone(source);
      mutate(changed);
      expect(await designPreviewKey(changed)).not.toBe(original);
    }
  });
});

describe('normalized comparison navigation', () => {
  it('uses 2/3 columns or 2x2/3x2 while fitting every same-aspect image without distortion', () => {
    expect([2, 3, 4, 5].map(designGrid)).toEqual([
      { columns: 2, rows: 1 },
      { columns: 3, rows: 1 },
      { columns: 2, rows: 2 },
      { columns: 3, rows: 2 },
    ]);
    for (const [width, height] of [
      [1200, 500],
      [500, 1200],
      [310, 310],
    ]) {
      const fit = fitDesignBox(width, height, 1.5);
      expect(fit.width / fit.height).toBeCloseTo(1.5);
      expect(fit.width).toBeLessThanOrEqual(width);
      expect(fit.height).toBeLessThanOrEqual(height);
    }
    expect(() => designGrid(6)).toThrow();
  });
  it('shares normalized coordinates across differently sized viewports and keeps zoom anchored', () => {
    const initial = zoomDesignView(fittedDesignView(), 2);
    const first = panDesignView(initial, 60, -40, 600, 400),
      second = panDesignView(initial, 30, -20, 300, 200);
    expect(first).toEqual(second);
    const anchor = { x: 0.65, y: 0.4 },
      zoomed = zoomDesignView(first, 3, anchor);
    expect(first.center.x + (anchor.x - 0.5) / first.zoom).toBeCloseTo(
      zoomed.center.x + (anchor.x - 0.5) / zoomed.zoom,
    );
    expect(first.center.y + (anchor.y - 0.5) / first.zoom).toBeCloseTo(
      zoomed.center.y + (anchor.y - 0.5) / zoomed.zoom,
    );
    expect(clampDesignView({ zoom: 1, center: { x: -20, y: 40 } })).toEqual(fittedDesignView());
    expect(zoomDesignView(first, 1)).toEqual(fittedDesignView());
  });
  it('requests another image only at bounded resolution steps, never on a pan', () => {
    expect(comparisonPreviewEdge(350, 240, 1, 1)).toBe(512);
    expect(comparisonPreviewEdge(350, 240, 1.2, 1)).toBe(512);
    expect(comparisonPreviewEdge(350, 240, 2, 1)).toBe(1024);
    expect(comparisonPreviewEdge(1200, 900, 5, 3)).toBe(2048);
  });
});
