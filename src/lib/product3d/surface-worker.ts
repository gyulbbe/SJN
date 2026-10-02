import { computeFit, estimateProductFit } from './fit';
import { productSurface } from './shading';
import type { ProductShading } from './state-types';
import type { WorkerReply, WorkerRequest } from './surface';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (reply: WorkerReply, transfer?: Transferable[]) => void;
};
/**
 * Does the slow work on a mesh off the page's main thread: the colours of a view mode, the fit of a
 * mesh to its product (symmetry, front, real size), and the search for that fit.
 */
scope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.kind === 'fit') {
      const { positions, normalMatrix } = computeFit(request.mesh, request.fit, request.size);
      scope.postMessage({ id: request.id, kind: 'fit', positions, normalMatrix }, [
        positions.buffer as ArrayBuffer,
      ]);
    } else if (request.kind === 'estimate') {
      scope.postMessage({
        id: request.id,
        kind: 'estimate',
        estimate: estimateProductFit(request.mesh, request.upright, {
          size: request.size,
          mirror: request.mirror,
        }),
      });
    } else {
      const surface = productSurface(request.mode as ProductShading, request.mesh);
      scope.postMessage(
        { id: request.id, kind: 'surface', colors: surface.colors, normals: surface.normals },
        [
          surface.colors.buffer as ArrayBuffer,
          ...(surface.normals ? [surface.normals.buffer as ArrayBuffer] : []),
        ],
      );
    }
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
