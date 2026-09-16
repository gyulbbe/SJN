/** Invocation/cleanup boundary only. Both graphics renderers are mocked; no image-quality claim. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COLOR, type RenderSnapshot, type Scene } from '../src/lib/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { WallFeatureV1 } from '../src/lib/wall-features';
import { defaultRoomView } from '../src/lib/room-viewer/view-state';
import { renderRoomSnapshotImage } from '../src/lib/room-viewer/render-snapshot';

const boundary = vi.hoisted(() => ({
  photo: { construct: vi.fn(), prepare: vi.fn(), export: vi.fn(), dispose: vi.fn() },
  room: { construct: vi.fn(), prepare: vi.fn(), export: vi.fn(), dispose: vi.fn() },
}));
vi.mock('../src/lib/render/compositor', () => ({
  PhotoCompositor: class {
    constructor() {
      boundary.photo.construct();
    }
    setSnapshot = boundary.photo.prepare;
    exportImage = boundary.photo.export;
    dispose = boundary.photo.dispose;
  },
}));
vi.mock('../src/lib/room-viewer/renderer', () => ({
  RoomViewerRenderer: class {
    constructor() {
      boundary.room.construct();
    }
    setSnapshot = boundary.room.prepare;
    export = boundary.room.export;
    dispose = boundary.room.dispose;
  },
}));

const photoBlob = new Blob(['authored legacy renderer result']),
  roomBlob = new Blob(['authored room renderer result']);
const feature = (kind: WallFeatureV1['kind']): WallFeatureV1 =>
  ({
    version: 1,
    id: '10000000-0000-4000-8000-000000000001',
    kind,
    face: 'back',
    source: 'user',
    leftMm: 600,
    topMm: 500,
    widthMm: 500,
    depthMm: 200,
    ...(kind === 'closed-niche' ? { heightMm: 600 } : {}),
  }) as WallFeatureV1;
const scene = (id: string, kind?: WallFeatureV1['kind']): Scene => ({
  originalAssetId: id,
  previewAssetId: id + '-preview',
  imageWidth: 1200,
  imageHeight: 800,
  room: { ...DEFAULT_ROOM },
  surfaces: [],
  fixtures: [],
  protection: { polygon: [], strokes: [] },
  color: { ...DEFAULT_COLOR },
  ...(kind ? { wallFeatures: [feature(kind)] } : {}),
});
function snapshot(beforeKind?: WallFeatureV1['kind'], afterKind?: WallFeatureV1['kind']): RenderSnapshot {
  return {
    beforeScene: scene('before', beforeKind),
    scene: scene('after', afterKind),
    materials: {},
    roomView: defaultRoomView(),
  };
}
const reader = vi.fn(async () => {
  throw new Error('Asset reads are forbidden in this mocked boundary test');
});
beforeEach(() => {
  vi.clearAllMocks();
  for (const item of [boundary.photo, boundary.room]) {
    item.prepare.mockReset();
    item.export.mockReset();
    item.prepare.mockResolvedValue(undefined);
  }
  boundary.photo.export.mockResolvedValue(photoBlob);
  boundary.room.export.mockResolvedValue(roomBlob);
});

const cases = (['closed-niche', 'floor-alcove'] as const).flatMap((kind) =>
  (['before', 'after', 'compare'] as const).flatMap((mode) =>
    [false, true].flatMap((before) =>
      [false, true].map((after) => ({
        kind,
        mode,
        before,
        after,
        rejects: mode === 'before' ? before : mode === 'after' ? after : before || after,
      })),
    ),
  ),
);

describe('legacy-front wall structure output guard', () => {
  it.each(cases)(
    '$kind / $mode / Before=$before After=$after rejects=$rejects',
    async ({ kind, mode, before, after, rejects }) => {
      const input = snapshot(before ? kind : undefined, after ? kind : undefined);
      const original = structuredClone(input),
        options = { renderer: 'legacy-front' as const, mode, longEdge: 900 };
      const optionsBefore = structuredClone(options);
      const pending = renderRoomSnapshotImage(input, reader, options);
      if (rejects) {
        await expect(pending).rejects.toThrow('벽 구조가 있는 장면은 기존 정면 렌더로 내보낼 수 없어요');
        expect(boundary.photo.construct).not.toHaveBeenCalled();
        expect(boundary.photo.prepare).not.toHaveBeenCalled();
        expect(boundary.photo.export).not.toHaveBeenCalled();
        expect(boundary.photo.dispose).not.toHaveBeenCalled();
      } else {
        expect(await pending).toBe(photoBlob);
        const expected = structuredClone(input);
        if (mode === 'before') {
          expected.scene = expected.beforeScene!;
          delete expected.beforeScene;
        }
        expect(boundary.photo.construct).toHaveBeenCalledTimes(1);
        expect(boundary.photo.prepare).toHaveBeenCalledWith(expected, reader);
        expect(boundary.photo.export).toHaveBeenCalledWith(
          expected,
          900,
          900,
          'image/png',
          mode === 'compare',
        );
        expect(boundary.photo.dispose).toHaveBeenCalledTimes(1);
      }
      expect(boundary.room.construct).not.toHaveBeenCalled();
      expect(reader).not.toHaveBeenCalled();
      expect(input).toEqual(original);
      expect(options).toEqual(optionsBefore);
    },
  );

  it('permits After-only export when only the non-output Before has structure', async () => {
    const input = snapshot('closed-niche');
    expect(
      await renderRoomSnapshotImage(input, reader, {
        renderer: 'legacy-front',
        mode: 'after',
        longEdge: 700,
        format: 'jpeg',
      }),
    ).toBe(photoBlob);
    expect(boundary.photo.export).toHaveBeenCalledWith(input, 700, 700, 'image/jpeg', false);
  });

  it('permits Before-only export when only the non-output After has structure', async () => {
    const input = snapshot(undefined, 'floor-alcove');
    await renderRoomSnapshotImage(input, reader, { renderer: 'legacy-front', mode: 'before', longEdge: 700 });
    expect(boundary.photo.prepare.mock.calls[0][0]).toEqual({
      scene: input.beforeScene,
      materials: input.materials,
      roomView: input.roomView,
    });
  });

  it.each(['before', 'after', 'compare'] as const)(
    'preserves %s output for empty wallFeatures arrays',
    async (mode) => {
      const input = snapshot();
      input.scene.wallFeatures = [];
      input.beforeScene!.wallFeatures = [];
      expect(
        await renderRoomSnapshotImage(input, reader, { renderer: 'legacy-front', mode, longEdge: 800 }),
      ).toBe(photoBlob);
      expect(boundary.photo.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the existing missing-Before error even when the unused After has structure', async () => {
    const input = snapshot(undefined, 'closed-niche');
    delete input.beforeScene;
    const original = structuredClone(input);
    await expect(
      renderRoomSnapshotImage(input, reader, { renderer: 'legacy-front', mode: 'before', longEdge: 800 }),
    ).rejects.toThrow('Before 장면이 없습니다.');
    expect(boundary.photo.construct).toHaveBeenCalledTimes(1);
    expect(boundary.photo.dispose).toHaveBeenCalledTimes(1);
    expect(boundary.photo.prepare).not.toHaveBeenCalled();
    expect(input).toEqual(original);
  });

  it('can export a plain After without Before and rejects its actual structure', async () => {
    const input = snapshot();
    delete input.beforeScene;
    expect(
      await renderRoomSnapshotImage(input, reader, {
        renderer: 'legacy-front',
        mode: 'after',
        longEdge: 800,
      }),
    ).toBe(photoBlob);
    input.scene.wallFeatures = [feature('floor-alcove')];
    await expect(
      renderRoomSnapshotImage(input, reader, { renderer: 'legacy-front', mode: 'after', longEdge: 800 }),
    ).rejects.toThrow('벽 구조');
    expect(boundary.photo.construct).toHaveBeenCalledTimes(1);
  });
});

describe('unchanged explicit room-view and resource contract', () => {
  it('passes the editor shared fit scenes by value without altering the caller project', async () => {
    const input = snapshot('closed-niche');
    const fitScenes = [input.beforeScene!, scene('other-design', 'floor-alcove')];
    const originalFit = structuredClone(fitScenes);
    await renderRoomSnapshotImage(input, reader, {
      renderer: 'room-view',
      mode: 'before',
      longEdge: 900,
      fitScenes,
    });
    const prepared = boundary.room.prepare.mock.calls[0][2];
    expect(prepared).toEqual({ fitScenes: originalFit });
    expect(prepared.fitScenes).not.toBe(fitScenes);
    prepared.fitScenes[1].room.widthMm = 3200;
    expect(fitScenes).toEqual(originalFit);
    expect(boundary.room.export).toHaveBeenCalledWith(input.roomView, {
      format: 'png',
      mode: 'before',
      longEdge: 900,
    });
  });

  it.each(
    (['closed-niche', 'floor-alcove'] as const).flatMap((kind) =>
      (['before', 'after', 'compare'] as const).map((mode) => ({ kind, mode })),
    ),
  )('keeps room-view $kind/$mode and the requested view', async ({ kind, mode }) => {
    const input = snapshot(kind, kind),
      original = structuredClone(input);
    const view = { ...defaultRoomView(), zoom: 1.7, pan: { x: 0.2, y: -0.1 } };
    const options = { renderer: 'room-view' as const, mode, longEdge: 1100, format: 'jpeg' as const, view };
    expect(await renderRoomSnapshotImage(input, reader, options)).toBe(roomBlob);
    expect(boundary.room.prepare).toHaveBeenCalledWith(input, reader);
    expect(boundary.room.export).toHaveBeenCalledWith(view, { format: 'jpeg', mode, longEdge: 1100 });
    expect(boundary.room.dispose).toHaveBeenCalledTimes(1);
    expect(boundary.photo.construct).not.toHaveBeenCalled();
    expect(input).toEqual(original);
    expect(reader).not.toHaveBeenCalled();
  });

  it('keeps roomView fallback and default PNG rather than switching cameras', async () => {
    const input = snapshot('closed-niche');
    input.roomView!.zoom = 2;
    await renderRoomSnapshotImage(input, reader, { renderer: 'room-view', mode: 'before', longEdge: 650 });
    expect(boundary.room.export).toHaveBeenCalledWith(input.roomView, {
      format: 'png',
      mode: 'before',
      longEdge: 650,
    });
    expect(boundary.photo.construct).not.toHaveBeenCalled();
  });

  it.each(
    (['legacy-front', 'room-view'] as const).flatMap((renderer) =>
      (['prepare', 'export'] as const).map((phase) => ({ renderer, phase })),
    ),
  )('$renderer $phase failure still disposes exactly once', async ({ renderer, phase }) => {
    const target = renderer === 'room-view' ? boundary.room : boundary.photo;
    target[phase].mockRejectedValueOnce(new Error('authored ' + phase + ' failure'));
    const input = snapshot(),
      original = structuredClone(input);
    await expect(
      renderRoomSnapshotImage(input, reader, { renderer, mode: 'compare', longEdge: 800 }),
    ).rejects.toThrow('authored ' + phase + ' failure');
    expect(target.dispose).toHaveBeenCalledTimes(1);
    expect(input).toEqual(original);
  });
});
