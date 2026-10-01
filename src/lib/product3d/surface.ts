import { keepSurface, productSurface, readySurface, type ProductSurface } from './shading';
import type { ProductMesh, ProductShading } from './state-types';

export interface SurfaceRequest {
  id: number;
  mode: ProductShading;
  mesh: ProductMesh;
}
export type SurfaceReply =
  | { id: number; colors: Float32Array; normals?: Float32Array; error?: undefined }
  | { id: number; error: string };

const pending = new WeakMap<ProductMesh, Map<ProductShading, Promise<ProductSurface>>>();
let sequence = 0;

/**
 * The colours of a mode, worked out in a Web Worker so the page keeps responding (about a second on
 * a 290k-vertex mesh, more on a slow device), and left where productSurface finds them: awaiting this
 * first makes the synchronous calls that follow instant. Without a Worker (a test, an old browser)
 * or if it fails, the page computes them itself.
 */
export function prepareProductSurface(mode: ProductShading, mesh: ProductMesh): Promise<ProductSurface> {
  const ready = readySurface(mode, mesh);
  if (ready) return Promise.resolve(ready);
  if (mode === 'baked' || typeof Worker === 'undefined') return Promise.resolve(productSurface(mode, mesh));
  const running = pending.get(mesh)?.get(mode);
  if (running) return running;
  const job = new Promise<ProductSurface>((resolve) => {
    const fallback = () => resolve(productSurface(mode, mesh));
    let worker: Worker;
    try {
      worker = new Worker(new URL('./surface-worker.ts', import.meta.url), {
        type: 'module',
        name: 'sjn-product3d-surface',
      });
    } catch {
      fallback();
      return;
    }
    const id = ++sequence;
    const done = (surface?: ProductSurface) => {
      worker.terminate();
      if (surface) {
        keepSurface(mode, mesh, surface);
        resolve(readySurface(mode, mesh)!);
      } else fallback();
    };
    worker.onmessage = (event: MessageEvent<SurfaceReply>) => {
      const reply = event.data;
      if (!reply || reply.id !== id) return;
      done(
        reply.error === undefined &&
          reply.colors instanceof Float32Array &&
          reply.colors.length === mesh.colors.length
          ? { colors: reply.colors, normals: reply.normals }
          : undefined,
      );
    };
    worker.onerror = (event) => {
      event.preventDefault();
      done();
    };
    worker.onmessageerror = () => done();
    // The arrays are copied in, so the page keeps its own mesh.
    worker.postMessage({ id, mode, mesh } satisfies SurfaceRequest);
  }).finally(() => pending.get(mesh)?.delete(mode));
  const modes = pending.get(mesh) ?? new Map();
  modes.set(mode, job);
  pending.set(mesh, modes);
  return job;
}
