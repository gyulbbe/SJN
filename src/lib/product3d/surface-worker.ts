import { productSurface } from './shading';
import type { ProductShading } from './state-types';
import type { SurfaceReply, SurfaceRequest } from './surface';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SurfaceRequest>) => void) | null;
  postMessage: (reply: SurfaceReply, transfer?: Transferable[]) => void;
};
/** Works out the colours of one view mode for a mesh off the page's main thread. */
scope.onmessage = (event) => {
  const { id, mode, mesh } = event.data;
  try {
    const surface = productSurface(mode as ProductShading, mesh);
    scope.postMessage({ id, colors: surface.colors, normals: surface.normals }, [
      surface.colors.buffer as ArrayBuffer,
      ...(surface.normals ? [surface.normals.buffer as ArrayBuffer] : []),
    ]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
