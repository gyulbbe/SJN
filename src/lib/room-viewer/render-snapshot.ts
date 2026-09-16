import type { RenderSnapshot, Scene } from '../types';
import type { AssetReader } from '../render/compositor';
import { normalizeRoomView, type RoomViewState } from './view-state';

/** Explicit renderer selection. Existing photo editing/export never switches camera implicitly. */
export async function renderRoomSnapshotImage(
  snapshot: RenderSnapshot,
  reader: AssetReader,
  options: {
    renderer: 'legacy-front' | 'room-view';
    mode: 'before' | 'after' | 'compare';
    longEdge: number;
    format?: 'png' | 'jpeg';
    view?: RoomViewState;
    /** Current project scenes used by the editor's shared Before/After camera fit. */
    fitScenes?: readonly Scene[];
  },
): Promise<Blob> {
  const input = structuredClone(snapshot);
  const format = options.format ?? 'png';
  if (options.renderer === 'room-view') {
    const { RoomViewerRenderer } = await import('./renderer');
    const renderer = new RoomViewerRenderer();
    try {
      if (options.fitScenes)
        await renderer.setSnapshot(input, reader, { fitScenes: structuredClone(options.fitScenes) });
      else await renderer.setSnapshot(input, reader);
      return await renderer.export(normalizeRoomView(options.view ?? input.roomView), {
        format,
        mode: options.mode,
        longEdge: options.longEdge,
      });
    } finally {
      renderer.dispose();
    }
  }
  // Preserve explicit camera selection: legacy photo planes cannot represent structural voids.
  // Check only the output sides; a feature on an unused comparison side is not a reason to reject.
  const outputScenes =
    options.mode === 'before'
      ? [input.beforeScene]
      : options.mode === 'after'
        ? [input.scene]
        : [input.beforeScene, input.scene];
  if (outputScenes.some((scene) => (scene?.wallFeatures?.length ?? 0) > 0))
    throw new Error('벽 구조가 있는 장면은 기존 정면 렌더로 내보낼 수 없어요. 공간 보기로 내보내 주세요.');
  const { PhotoCompositor } = await import('../render/compositor');
  const renderer = new PhotoCompositor();
  try {
    if (options.mode === 'before') {
      if (!input.beforeScene) throw new Error('Before 장면이 없습니다.');
      input.scene = input.beforeScene;
      delete input.beforeScene;
    }
    await renderer.setSnapshot(input, reader);
    return await renderer.exportImage(
      input,
      options.longEdge,
      options.longEdge,
      format === 'png' ? 'image/png' : 'image/jpeg',
      options.mode === 'compare',
    );
  } finally {
    renderer.dispose();
  }
}
