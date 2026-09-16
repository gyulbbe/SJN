import { RoomViewerRenderer } from '../room-viewer/renderer';
import type { DesignPreviewRoomContext } from './design-preview-context';
import type { DesignPreviewRenderer } from './design-preview';

/** Created lazily by the serial preview service; never shares the editor's WebGL context. */
export function createRoomDesignPreviewRenderer(): DesignPreviewRenderer {
  const renderer = new RoomViewerRenderer();
  let context: DesignPreviewRoomContext | undefined;
  return {
    get maxOutputEdge() {
      return renderer.maxOutputEdge;
    },
    async setSnapshot(snapshot, reader, options) {
      context = options?.roomContext;
      if (!context) throw new Error('방 구조 미리보기의 공통 시점을 확인해 주세요.');
      await renderer.setSnapshot(snapshot, reader, { fitScenes: context.fitScenes });
    },
    render(width, height) {
      if (!context) throw new Error('방 구조 미리보기를 먼저 준비해 주세요.');
      return renderer.render(width, height, context.view, 'after');
    },
    async exportImage(_snapshot, width, height) {
      if (!context) throw new Error('방 구조 미리보기를 먼저 준비해 주세요.');
      return renderer.export(context.view, {
        format: 'png',
        mode: 'after',
        longEdge: Math.max(width, height),
      });
    },
    dispose() {
      context = undefined;
      renderer.dispose();
    },
  };
}
