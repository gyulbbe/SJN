import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Product3dClient } from '../src/lib/product3d/client';
import type { Product3dReply } from '../src/lib/product3d/types';
class WorkerStub {
  static all: WorkerStub[] = [];
  onmessage?: (e: { data: Product3dReply }) => void;
  onerror?: (e: { preventDefault: () => void }) => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerStub.all.push(this);
  }
  reply(data: Product3dReply) {
    this.onmessage?.({ data });
  }
}
const mesh = {
  positions: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
  colors: new Float32Array(9),
};
const timings = {
  downloadMs: 0,
  initializationMs: 1,
  processingMs: 2,
  cacheSource: 'cache' as const,
  modelId: 'model',
  modelRevision: 'revision',
};
beforeEach(() => {
  vi.stubGlobal('Worker', WorkerStub);
  WorkerStub.all = [];
});
afterEach(() => vi.unstubAllGlobals());
describe('product reconstruction worker lifecycle', () => {
  it('returns the actual mesh once, without image rendering or direction inference', async () => {
    const client = new Product3dClient(),
      blob = new Blob(['photo']);
    const job = client.run(blob, vi.fn());
    const worker = WorkerStub.all[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'run', id: 1, blob });
    worker.reply({ type: 'mesh', id: 1, mesh, timings });
    expect(await job).toEqual({ mesh, timings });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('rejects duplicates and ignores a cancelled worker after retry', async () => {
    const client = new Product3dClient();
    const old = client.run(new Blob(['p']), vi.fn());
    const rejected = expect(old).rejects.toThrow('취소');
    await expect(client.run(new Blob(['p']), vi.fn())).rejects.toThrow('진행 중');
    client.dispose();
    await rejected;
    const job = client.run(new Blob(['p']), vi.fn());
    WorkerStub.all[0].onerror?.({ preventDefault: vi.fn() });
    WorkerStub.all[0].reply({ type: 'mesh', id: 1, mesh, timings });
    WorkerStub.all[1].reply({ type: 'mesh', id: 2, mesh, timings });
    await expect(job).resolves.toHaveProperty('mesh');
  });
  it('retries GPU once with the same bytes and accounts for both attempts', async () => {
    const client = new Product3dClient(),
      blob = new Blob(['p']);
    const job = client.run(blob, vi.fn());
    WorkerStub.all[0].reply({
      type: 'error',
      id: 1,
      message: 'GPU',
      retryCpu: true,
      timings: { ...timings, downloadMs: 10, cacheSource: 'network' },
    });
    expect(WorkerStub.all[0].terminate).toHaveBeenCalledOnce();
    expect(WorkerStub.all[1].postMessage).toHaveBeenCalledWith({ type: 'run', id: 1, blob, forceCpu: true });
    WorkerStub.all[1].reply({ type: 'mesh', id: 1, mesh, timings: { ...timings, backend: 'wasm' } });
    expect((await job).timings).toMatchObject({
      downloadMs: 10,
      initializationMs: 2,
      processingMs: 4,
      backend: 'wasm',
      cacheSource: 'network',
    });
  });
  it('does not loop after CPU failure', async () => {
    const client = new Product3dClient(),
      job = client.run(new Blob(['p']), vi.fn()),
      reject = expect(job).rejects.toThrow('CPU');
    WorkerStub.all[0].reply({ type: 'error', id: 1, message: 'GPU', retryCpu: true });
    WorkerStub.all[1].reply({ type: 'error', id: 1, message: 'CPU', retryCpu: true });
    await reject;
    expect(WorkerStub.all).toHaveLength(2);
  });
  it.each([
    null,
    { type: 'mesh', id: 1, mesh },
    { type: 'mesh', id: 1, mesh, timings: { ...timings, processingMs: NaN } },
  ])('rejects invalid responses and permits another attempt', async (payload) => {
    const client = new Product3dClient(),
      job = client.run(new Blob(['p']), vi.fn()),
      reject = expect(job).rejects.toThrow('입체화');
    WorkerStub.all[0].reply(payload as unknown as Product3dReply);
    await reject;
    const retry = client.run(new Blob(['p']), vi.fn()),
      cancel = expect(retry).rejects.toThrow('취소');
    client.dispose();
    await cancel;
  });
});
