import { computeFit, estimateProductFit } from './fit';
import { registerPainted } from './painted';
import { paintFromPhoto, paintReply } from './photo-color';
import { productSurface } from './shading';
import type { ProductShading } from './state-types';
import type { WorkerReply, WorkerRequest } from './surface';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (reply: WorkerReply, transfer?: Transferable[]) => void;
};
/**
 * Does the slow work on a mesh off the page's main thread: the colours of a view mode, the fit of a
 * mesh to its product (symmetry, front, real size), the search for that fit, and the input photo's
 * camera and colours.
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
    } else if (request.kind === 'paint') {
      const paint = paintReply(paintFromPhoto(request.mesh, request.photo, request.camera), request.mesh);
      scope.postMessage(
        { id: request.id, kind: 'paint', paint },
        paint.status === 'ok'
          ? [
              paint.photo.colors.buffer as ArrayBuffer,
              paint.photo.weight.buffer as ArrayBuffer,
              ...(paint.mesh
                ? [
                    paint.mesh.positions.buffer as ArrayBuffer,
                    paint.mesh.indices.buffer as ArrayBuffer,
                    paint.mesh.colors.buffer as ArrayBuffer,
                  ]
                : []),
            ]
          : [],
      );
    } else {
      // A mesh that carries the photo's colours arrives with them, and is drawn with them.
      if (request.photo) registerPainted(request.mesh, request.photo);
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
