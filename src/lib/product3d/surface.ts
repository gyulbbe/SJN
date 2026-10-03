import {
  computeFit,
  estimateProductFit,
  fitChangesMesh,
  fittedFrom,
  registerFitted,
  type FitEstimate,
  type ProductFit,
  type ProductSize,
  type Quaternion4,
} from './fit';
import { paintedFrom, registerPainted, type PhotoColors } from './painted';
import {
  paintFailureMessage,
  paintFromPhoto,
  paintReply,
  type PaintReply,
  type ProductPhoto,
} from './photo-color';
import type { PhotoCamera } from './photo-camera';
import { keepSurface, productSurface, readySurface, type ProductSurface } from './shading';
import type { ProductMesh, ProductShading } from './state-types';

/** What the page asks the worker (`kind` left out: the colours of a view mode). */
export type WorkerRequest =
  | { id: number; kind?: 'surface'; mode: ProductShading; mesh: ProductMesh; photo?: PhotoColors }
  | { id: number; kind: 'paint'; mesh: ProductMesh; photo: ProductPhoto; camera?: PhotoCamera }
  | { id: number; kind: 'fit'; mesh: ProductMesh; fit: ProductFit; size?: Partial<ProductSize> }
  | {
      id: number;
      kind: 'estimate';
      mesh: ProductMesh;
      upright: Quaternion4;
      size?: Partial<ProductSize>;
      mirror: boolean;
    };
export type WorkerReply =
  | { id: number; kind: 'surface'; colors: Float32Array; normals?: Float32Array }
  | { id: number; kind: 'fit'; positions: Float32Array; normalMatrix: number[] }
  | { id: number; kind: 'paint'; paint: PaintReply }
  | { id: number; kind: 'estimate'; estimate: FitEstimate }
  | { id: number; error: string };

let sequence = 0;

/**
 * Runs one job in a Web Worker and gives its reply; without a Worker (a test, an old browser), or if
 * the Worker fails or gives an unusable answer, `fallback` does the same job on the page.
 */
function inWorker<R extends WorkerReply>(
  request: (id: number) => WorkerRequest,
  usable: (reply: WorkerReply) => reply is R,
  fallback: () => R,
): Promise<R> {
  if (typeof Worker === 'undefined') return Promise.resolve().then(fallback);
  return new Promise<R>((resolve, reject) => {
    const again = () => Promise.resolve().then(fallback).then(resolve, reject);
    let worker: Worker;
    try {
      worker = new Worker(new URL('./surface-worker.ts', import.meta.url), {
        type: 'module',
        name: 'sjn-product3d-surface',
      });
    } catch {
      again();
      return;
    }
    const id = ++sequence;
    const finish = (reply?: R) => {
      worker.terminate();
      if (reply) resolve(reply);
      else again();
    };
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (!reply || reply.id !== id) return;
      finish(usable(reply) ? reply : undefined);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
    };
    worker.onmessageerror = () => finish();
    // The arrays are copied in, so the page keeps its own mesh.
    worker.postMessage(request(id));
  });
}

const pending = new WeakMap<ProductMesh, Map<string, Promise<unknown>>>();
/** One job per mesh and kind at a time: a second ask waits for the first. */
function once<T>(mesh: ProductMesh, key: string, start: () => Promise<T>): Promise<T> {
  const running = pending.get(mesh)?.get(key) as Promise<T> | undefined;
  if (running) return running;
  const job = start().finally(() => pending.get(mesh)?.delete(key));
  const jobs = pending.get(mesh) ?? new Map();
  jobs.set(key, job);
  pending.set(mesh, jobs);
  return job;
}

/**
 * The colours of a mode, worked out in a Web Worker so the page keeps responding (about a second on
 * a 290k-vertex mesh, more on a slow device), and left where productSurface finds them: awaiting this
 * first makes the synchronous calls that follow instant. For a fitted mesh (see prepareFittedMesh)
 * the colours are those of the mesh it was made from.
 */
export async function prepareProductSurface(
  mode: ProductShading,
  mesh: ProductMesh,
): Promise<ProductSurface> {
  const from = fittedFrom(mesh);
  if (from) {
    await prepareProductSurface(mode, from.source);
    return productSurface(mode, mesh);
  }
  const ready = readySurface(mode, mesh);
  if (ready) return ready;
  if (mode === 'baked') return productSurface(mode, mesh);
  return once(mesh, `surface:${mode}`, async () => {
    const reply = await inWorker(
      (id) => ({ id, mode, mesh, photo: paintedFrom(mesh) }),
      (r): r is Extract<WorkerReply, { kind: 'surface' }> =>
        'kind' in r &&
        r.kind === 'surface' &&
        r.colors instanceof Float32Array &&
        r.colors.length === mesh.colors.length,
      () => {
        const surface = productSurface(mode, mesh);
        return { id: 0, kind: 'surface' as const, colors: surface.colors, normals: surface.normals };
      },
    );
    keepSurface(mode, mesh, { colors: reply.colors, normals: reply.normals });
    return readySurface(mode, mesh)!;
  });
}

const fits = new WeakMap<ProductMesh, Map<string, ProductMesh>>();
const fitKey = (fit: ProductFit, size?: Partial<ProductSize>) =>
  JSON.stringify([fit, fit.size ? [size?.widthMm, size?.depthMm, size?.heightMm] : 0]);

/**
 * The mesh as its product is (see fit.ts): the same object when the fit changes nothing, else a new
 * mesh, made in a Web Worker and kept per mesh and fit.
 */
export async function prepareFittedMesh(
  mesh: ProductMesh,
  fit: ProductFit | undefined,
  size?: Partial<ProductSize>,
): Promise<ProductMesh> {
  if (!fit || !fitChangesMesh(fit, size)) return mesh;
  const key = fitKey(fit, size);
  const known = fits.get(mesh)?.get(key);
  if (known) return known;
  return once(mesh, `fit:${key}`, async () => {
    const reply = await inWorker(
      (id) => ({ id, kind: 'fit', mesh, fit, size }),
      (r): r is Extract<WorkerReply, { kind: 'fit' }> =>
        'kind' in r &&
        r.kind === 'fit' &&
        r.positions instanceof Float32Array &&
        r.positions.length === mesh.positions.length,
      () => {
        const { positions, normalMatrix } = computeFit(mesh, fit, size);
        return { id: 0, kind: 'fit' as const, positions, normalMatrix };
      },
    );
    const fitted: ProductMesh = { positions: reply.positions, indices: mesh.indices, colors: mesh.colors };
    registerFitted(fitted, mesh, reply.normalMatrix);
    const memo = fits.get(mesh) ?? new Map();
    memo.set(key, fitted);
    fits.set(mesh, memo);
    return fitted;
  });
}

/** The search for a mesh's fit (mirror plane, front, real size), in a Web Worker. */
export async function prepareProductFit(
  mesh: ProductMesh,
  upright: Quaternion4,
  options: { size?: Partial<ProductSize>; mirror: boolean },
): Promise<FitEstimate> {
  const reply = await inWorker(
    (id) => ({ id, kind: 'estimate', mesh, upright, size: options.size, mirror: options.mirror }),
    (r): r is Extract<WorkerReply, { kind: 'estimate' }> => 'kind' in r && r.kind === 'estimate',
    () => ({
      id: 0,
      kind: 'estimate' as const,
      estimate: estimateProductFit(mesh, upright, { size: options.size, mirror: options.mirror }),
    }),
  );
  return reply.estimate;
}

export type PaintOutcome =
  | { status: 'ok'; mesh: ProductMesh; camera: PhotoCamera; iou: number }
  | { status: 'failed'; reason: 'outline' | 'empty' | 'photo'; iou: number; message: string };

const paints = new WeakMap<ProductMesh, Map<string, Promise<PaintOutcome>>>();

/**
 * The mesh with the input photo's colours on it (see photo-color.ts), made in a Web Worker: a new
 * mesh that shows the photo where the photo shows the product (finer where the photo has detail),
 * or a plain-language reason it was not. `known` is a camera found earlier (it is not searched for
 * again). The result is kept per mesh and camera, and `photo` is asked for only when there is none.
 */
export function preparePaintedMesh(
  mesh: ProductMesh,
  photo: () => Promise<ProductPhoto>,
  known?: PhotoCamera,
): Promise<PaintOutcome> {
  const key = known ? JSON.stringify(known) : 'search';
  const memo = paints.get(mesh)?.get(key);
  if (memo) return memo;
  const job = (async (): Promise<PaintOutcome> => {
    let pixels: ProductPhoto;
    try {
      pixels = await photo();
    } catch {
      return { status: 'failed', reason: 'photo', iou: 0, message: paintFailureMessage('photo', 0) };
    }
    let reply: Extract<WorkerReply, { kind: 'paint' }>;
    try {
      reply = await inWorker(
        (id) => ({ id, kind: 'paint', mesh, photo: pixels, camera: known }),
        (r): r is Extract<WorkerReply, { kind: 'paint' }> => 'kind' in r && r.kind === 'paint',
        () => {
          const found = paintFromPhoto(mesh, pixels, known);
          return { id: 0, kind: 'paint' as const, paint: paintReply(found) };
        },
      );
    } catch {
      return { status: 'failed', reason: 'photo', iou: 0, message: paintFailureMessage('photo', 0) };
    }
    const { paint } = reply;
    if (paint.status === 'failed')
      return {
        status: 'failed',
        reason: paint.reason,
        iou: paint.iou,
        message: paintFailureMessage(paint.reason, paint.iou),
      };
    if (
      paint.photo.colors.length !== (paint.mesh ?? mesh).colors.length ||
      paint.photo.weight.length !== paint.photo.colors.length / 3
    )
      return { status: 'failed', reason: 'photo', iou: 0, message: paintFailureMessage('photo', 0) };
    // Always a new object: one that carries the photo's colours must not be mistaken for the mesh without.
    const painted: ProductMesh = paint.mesh
      ? { positions: paint.mesh.positions, indices: paint.mesh.indices, colors: paint.mesh.colors }
      : { positions: mesh.positions, indices: mesh.indices, colors: mesh.colors };
    registerPainted(painted, paint.photo);
    return { status: 'ok', mesh: painted, camera: paint.camera, iou: paint.iou };
  })();
  const jobs = paints.get(mesh) ?? new Map();
  jobs.set(key, job);
  paints.set(mesh, jobs);
  void job.then((outcome) => {
    // A photo that could not be read may be read the next time: only the other outcomes are kept.
    if (outcome.status === 'failed' && outcome.reason === 'photo') jobs.delete(key);
    // The camera that was found answers the next ask that names it, without another search.
    else if (outcome.status === 'ok') jobs.set(JSON.stringify(outcome.camera), job);
  });
  return job;
}
