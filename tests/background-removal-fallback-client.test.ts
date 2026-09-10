import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundRemovalClient } from '../src/lib/background-removal/client';
import type {
  BackgroundRemovalAttemptTimings,
  BackgroundRemovalReply,
  BackgroundRemovalRequest,
  BackgroundRemovalResult,
} from '../src/lib/background-removal/types';

class FakeWorker {
  static created: FakeWorker[] = [];
  static constructors = 0;
  static failConstructor = 0;
  static failPost = 0;
  readonly number: number;
  onmessage?: (event: MessageEvent<BackgroundRemovalReply>) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminated = false;
  requests: BackgroundRemovalRequest[] = [];
  constructor() {
    this.number = ++FakeWorker.constructors;
    if (FakeWorker.failConstructor === this.number) throw new Error('worker creation blocked');
    FakeWorker.created.push(this);
  }
  terminate() {
    this.terminated = true;
  }
  postMessage(request: BackgroundRemovalRequest) {
    if (FakeWorker.failPost === this.number) throw new Error('clone failed');
    this.requests.push(request);
  }
  reply(reply: BackgroundRemovalReply) {
    this.onmessage?.({ data: reply } as MessageEvent<BackgroundRemovalReply>);
  }
}
const carry: BackgroundRemovalAttemptTimings = {
  downloadMs: 100,
  initializationMs: 20,
  processingMs: 30,
  inferenceMs: 25,
  cacheSource: 'network',
};
const result = (): BackgroundRemovalResult => ({
  blob: new Blob(['transparent PNG']),
  width: 1200,
  height: 800,
  analysisWidth: 512,
  analysisHeight: 512,
  backend: 'wasm',
  precision: 'fp32',
  downloadMs: 0,
  initializationMs: 6,
  processingMs: 7,
  inferenceMs: 6,
  cacheSource: 'cache',
  fallbackReason: 'GPU failed',
  cacheNotice: 'GPU cache removed',
});
function retry(worker: FakeWorker, timings = carry) {
  worker.reply({ type: 'retry-cpu', id: 1, message: 'GPU failed', timings });
}
beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.created = [];
  FakeWorker.constructors = 0;
  FakeWorker.failConstructor = FakeWorker.failPost = 0;
});

describe('fresh-worker CPU fallback after a GPU attempt', () => {
  it('terminates GPU context, transfers the same job/photo to CPU, and adds actual attempt timings', async () => {
    const client = new BackgroundRemovalClient();
    const blob = new Blob(['original photo']);
    const progress = vi.fn();
    const pending = client.run(blob, progress);
    const gpu = FakeWorker.created[0];
    retry(gpu);
    const cpu = FakeWorker.created[1];
    expect(gpu.terminated).toBe(true);
    expect(cpu.requests).toEqual([
      { type: 'run', id: 1, blob, forceCpu: true, fallbackReason: 'GPU failed' },
    ]);
    expect(cpu.requests[0].blob).toBe(blob);
    expect(progress).toHaveBeenCalledWith({ stage: 'initializing', message: 'GPU failed' });
    const output = result();
    cpu.reply({ type: 'result', id: 1, result: output });
    expect(await pending).toEqual({
      ...output,
      downloadMs: 100,
      initializationMs: 26,
      processingMs: 37,
      inferenceMs: 31,
      cacheSource: 'network',
    });
    client.dispose();
  });

  it('keeps the final CPU cache source when the GPU attempt downloaded no model', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    retry(FakeWorker.created[0], { ...carry, downloadMs: 0, cacheSource: 'cache' });
    FakeWorker.created[1].reply({ type: 'result', id: 1, result: result() });
    expect(await pending).toMatchObject({ downloadMs: 0, cacheSource: 'cache', initializationMs: 26 });
    client.dispose();
  });

  it('ignores late GPU progress, result and error events even when their job ID equals the CPU job', async () => {
    const client = new BackgroundRemovalClient();
    const progress = vi.fn();
    const pending = client.run(new Blob(['photo']), progress);
    const gpu = FakeWorker.created[0];
    retry(gpu);
    const cpu = FakeWorker.created[1];
    progress.mockClear();
    gpu.reply({ type: 'progress', id: 1, progress: { stage: 'processing', message: 'old GPU' } });
    gpu.reply({ type: 'result', id: 1, result: { ...result(), backend: 'webgpu' } });
    gpu.reply({ type: 'error', id: 1, message: 'late GPU failure' });
    gpu.onerror?.();
    gpu.onmessageerror?.();
    expect(progress).not.toHaveBeenCalled();
    expect(cpu.terminated).toBe(false);
    cpu.reply({ type: 'result', id: 1, result: result() });
    expect(await pending).toMatchObject({ backend: 'wasm' });
    client.dispose();
  });

  it('keeps duplicate execution blocked throughout worker replacement', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    retry(FakeWorker.created[0]);
    await expect(client.run(new Blob(['other photo']), vi.fn())).rejects.toThrow('진행 중');
    expect(FakeWorker.created).toHaveLength(2);
    FakeWorker.created[1].reply({ type: 'result', id: 1, result: result() });
    await pending;
    client.dispose();
  });

  it('allows only one automatic CPU retry and rejects a repeated retry request', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    retry(FakeWorker.created[0]);
    retry(FakeWorker.created[1]);
    await expect(pending).rejects.toThrow('CPU 대체 처리를 완료하지 못했어요');
    expect(FakeWorker.created).toHaveLength(2);
    expect(FakeWorker.created[1].terminated).toBe(true);
  });

  it('rejects CPU failure and permits a subsequent explicit retry with a new worker', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    retry(FakeWorker.created[0]);
    FakeWorker.created[1].reply({ type: 'error', id: 1, message: 'CPU failed' });
    await expect(pending).rejects.toThrow('CPU failed');
    const next = client.run(new Blob(['photo again']), vi.fn());
    const rejected = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.created).toHaveLength(3);
    expect(FakeWorker.created[2].requests[0].id).toBe(2);
    client.dispose();
    await rejected;
  });

  it('does not carry the earlier GPU timings into another image processed by the surviving CPU session', async () => {
    const client = new BackgroundRemovalClient();
    const first = client.run(new Blob(['first photo']), vi.fn());
    retry(FakeWorker.created[0]);
    const cpu = FakeWorker.created[1];
    cpu.reply({ type: 'result', id: 1, result: result() });
    await first;
    const second = client.run(new Blob(['second photo']), vi.fn());
    const output = { ...result(), cacheSource: 'memory' as const, initializationMs: 0 };
    cpu.reply({ type: 'result', id: 2, result: output });
    expect(await second).toBe(output);
    expect(FakeWorker.created).toHaveLength(2);
    client.dispose();
  });
});

describe('fresh-worker startup errors and cancellation', () => {
  it('rejects a failed initial worker constructor without leaving an in-flight job', async () => {
    const client = new BackgroundRemovalClient();
    FakeWorker.failConstructor = 1;
    await expect(client.run(new Blob(['photo']), vi.fn())).rejects.toThrow('AI 작업을 시작');
    const pending = client.run(new Blob(['retry photo']), vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    client.dispose();
    await rejected;
  });

  it('rejects a failed CPU worker constructor after terminating the GPU', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    FakeWorker.failConstructor = 2;
    retry(FakeWorker.created[0]);
    await expect(pending).rejects.toThrow('CPU 대체 작업을 시작');
    expect(FakeWorker.created[0].terminated).toBe(true);
  });

  it('rejects a failed CPU postMessage and terminates the newly created CPU worker', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    FakeWorker.failPost = 2;
    retry(FakeWorker.created[0]);
    await expect(pending).rejects.toThrow('CPU 대체 작업을 시작');
    expect(FakeWorker.created[1].terminated).toBe(true);
  });

  it('rejects an initial postMessage failure', async () => {
    FakeWorker.failPost = 1;
    const client = new BackgroundRemovalClient();
    await expect(client.run(new Blob(['photo']), vi.fn())).rejects.toThrow('전달하지 못했어요');
    expect(FakeWorker.created[0].terminated).toBe(true);
  });

  it('cancels a CPU fallback in progress and ignores its late result', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    retry(FakeWorker.created[0]);
    const cpu = FakeWorker.created[1];
    client.dispose();
    await rejected;
    expect(cpu.terminated).toBe(true);
    cpu.reply({ type: 'result', id: 1, result: result() });
    expect(FakeWorker.created).toHaveLength(2);
  });

  it('does not spawn a CPU worker when the owner cancels during the transition progress callback', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), () => client.dispose());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    retry(FakeWorker.created[0]);
    await rejected;
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0].terminated).toBe(true);
  });

  it('rejects a CPU worker script failure and releases the worker', async () => {
    const client = new BackgroundRemovalClient();
    const pending = client.run(new Blob(['photo']), vi.fn());
    retry(FakeWorker.created[0]);
    FakeWorker.created[1].onerror?.();
    await expect(pending).rejects.toThrow('실행 엔진');
    expect(FakeWorker.created[1].terminated).toBe(true);
  });
});
