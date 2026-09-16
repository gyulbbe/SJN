import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MogeBrowserClient } from '../src/lib/reconstruction/moge-browser/client';
import type {
  MogeBrowserResult,
  MogeReply,
  MogeRequest,
  MogeTimings,
} from '../src/lib/reconstruction/moge-browser/protocol';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: MessageEvent<MogeReply>) => void;
  onerror?: () => void;
  terminated = false;
  requests: { request: MogeRequest; transfer?: Transferable[] }[] = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: MogeRequest, transfer?: Transferable[]) {
    this.requests.push({ request, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  reply(reply: MogeReply) {
    this.onmessage?.({ data: reply } as MessageEvent<MogeReply>);
  }
}
const timings: MogeTimings = {
  downloadMs: 50,
  cacheMs: 2,
  initializationMs: 3,
  preprocessingMs: 4,
  inferenceMs: 5,
  postprocessingMs: 0,
  planeExtractionMs: 0,
  totalMs: 64,
};
const retry = (worker: FakeWorker) => {
  const bytes = new Uint8Array([1, 2, 3]);
  worker.reply({
    type: 'retry-cpu',
    id: 1,
    message: 'GPU compute failed',
    timings,
    model: { bytes, downloadMs: 50, cacheMs: 2, cacheSource: 'network', cacheNotice: 'quota denied' },
  });
  return bytes;
};
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MoGe client job lifecycle (mocked Worker, no model execution)', () => {
  it('moves verified model bytes to a new CPU worker without a second download even if cache failed', async () => {
    const client = new MogeBrowserClient(),
      blob = new Blob(['photo']);
    const pending = client.run(blob);
    const gpu = FakeWorker.instances[0],
      bytes = retry(gpu),
      cpu = FakeWorker.instances[1];
    expect(gpu.terminated).toBe(true);
    expect(cpu.requests[0].request).toMatchObject({
      mode: 'wasm',
      blob,
      model: { bytes, cacheNotice: 'quota denied' },
      carryTimings: timings,
    });
    expect(cpu.requests[0].transfer).toEqual([bytes.buffer]);
    await expect(client.run(blob)).rejects.toThrow('진행 중');
    gpu.reply({ type: 'error', id: 1, code: 'runtime', message: 'late event' });
    expect(cpu.terminated).toBe(false);
    const result = { backend: 'wasm', requestedMode: 'wasm', timings } as MogeBrowserResult;
    cpu.reply({ type: 'result', id: 1, result });
    expect(await pending).toMatchObject({ backend: 'wasm', requestedMode: 'auto' });
    expect(cpu.terminated).toBe(true);
  });
  it.each(['download', 'integrity'] as const)('does not treat a %s error as GPU failure', async (code) => {
    const client = new MogeBrowserClient(),
      pending = client.run(new Blob(['photo']));
    FakeWorker.instances[0].reply({ type: 'error', id: 1, code, message: 'model unavailable' });
    await expect(pending).rejects.toThrow('model unavailable');
    expect(FakeWorker.instances).toHaveLength(1);
  });
  it('forced GPU fails without CPU fallback', async () => {
    const client = new MogeBrowserClient(),
      pending = client.run(new Blob(['photo']), { mode: 'webgpu' });
    retry(FakeWorker.instances[0]);
    await expect(pending).rejects.toThrow('GPU compute failed');
    expect(FakeWorker.instances).toHaveLength(1);
  });
  it('cancellation from a fallback progress callback prevents creation of a CPU worker', async () => {
    const controller = new AbortController(),
      client = new MogeBrowserClient();
    const pending = client.run(new Blob(['photo']), {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    retry(FakeWorker.instances[0]);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(1);
  });
  it('times out and terminates computation, then permits an explicit retry', async () => {
    vi.useFakeTimers();
    const client = new MogeBrowserClient(),
      pending = client.run(new Blob(['photo']), { timeoutMs: 100 });
    const expectation = expect(pending).rejects.toThrow('제한 시간');
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
    expect(FakeWorker.instances[0].terminated).toBe(true);
    const second = client.run(new Blob(['photo']));
    client.dispose();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  });
});
