import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSegmentation, SegmentationReply } from '../src/lib/segmentation';
class FakeWorker {
  static created: FakeWorker[] = [];
  static failConstructor = false;
  static failPost = false;
  onmessage: ((event: MessageEvent<SegmentationReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: {
    id: number;
    blob: Blob;
    quality?: string;
    captureBasins?: boolean;
    captureSemanticLabels?: boolean;
  }[] = [];
  terminated = false;
  constructor() {
    if (FakeWorker.failConstructor) throw new Error('worker blocked');
    FakeWorker.created.push(this);
  }
  postMessage(request: {
    id: number;
    blob: Blob;
    quality?: string;
    captureBasins?: boolean;
    captureSemanticLabels?: boolean;
  }) {
    if (FakeWorker.failPost) throw new Error('clone failed');
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  reply(message: SegmentationReply) {
    this.onmessage?.({ data: message } as MessageEvent<SegmentationReply>);
  }
}
const result = (): RoomSegmentation => ({
  width: 1,
  height: 1,
  wall: new Uint8Array([255]),
  floor: new Uint8Array([0]),
});
const blob = () => new Blob(['photo'], { type: 'image/png' });
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeWorker.created = [];
  FakeWorker.failConstructor = FakeWorker.failPost = false;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('segmentation shared cache and dedicated cancellation', () => {
  it('retains the shared worker/cache for calls without a signal', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    const first = segmentRoom(blob());
    const worker = FakeWorker.created[0];
    worker.reply({ id: worker.requests[0].id, type: 'result', result: result() });
    await first;
    const second = segmentRoom(blob());
    expect(FakeWorker.created).toHaveLength(1);
    worker.reply({ id: worker.requests[1].id, type: 'result', result: result() });
    await second;
    expect(worker.terminated).toBe(false);
  });
  it('cancels only the owned worker and leaves an ongoing shared job alive', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    const shared = segmentRoom(blob());
    const common = FakeWorker.created[0];
    const controller = new AbortController();
    const stage = vi.fn();
    const own = segmentRoom(blob(), stage, { quality: 'reconstruction', signal: controller.signal });
    const worker = FakeWorker.created[1],
      late = worker.onmessage!;
    const rejection = expect(own).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    expect(worker.terminated).toBe(true);
    expect(common.terminated).toBe(false);
    const count = stage.mock.calls.length;
    late({
      data: { id: worker.requests[0].id, type: 'stage', message: 'late' },
    } as MessageEvent<SegmentationReply>);
    late({
      data: { id: worker.requests[0].id, type: 'result', result: result() },
    } as MessageEvent<SegmentationReply>);
    expect(stage.mock.calls).toHaveLength(count);
    common.reply({ id: common.requests[0].id, type: 'result', result: result() });
    await shared;
  });
  it('releases an owned model worker on success and ignores replies for another request', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    const stage = vi.fn();
    const promise = segmentRoom(blob(), stage, { signal: new AbortController().signal });
    const worker = FakeWorker.created[0],
      id = worker.requests[0].id;
    worker.reply({ id: id + 1, type: 'result', result: result() });
    expect(worker.terminated).toBe(false);
    worker.reply({ id, type: 'stage', message: 'inference' });
    expect(stage).toHaveBeenCalledWith('inference');
    worker.reply({ id, type: 'result', result: result() });
    expect((await promise).width).toBe(1);
    expect(worker.terminated).toBe(true);
    expect(worker.onmessage).toBeNull();
  });
  it('keeps raw basin diagnostics opt-in in shared and owned worker requests', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    for (const signal of [undefined, new AbortController().signal]) {
      const ordinary = segmentRoom(blob(), undefined, { signal });
      const normal = FakeWorker.created.at(-1)!;
      expect(normal.requests.at(-1)?.captureBasins).toBeUndefined();
      normal.reply({ id: normal.requests.at(-1)!.id, type: 'result', result: result() });
      expect(await ordinary).not.toHaveProperty('basinDiagnostics');
      const explicit = segmentRoom(blob(), undefined, { signal, captureBasins: true });
      const capture = FakeWorker.created.at(-1)!;
      expect(capture.requests.at(-1)?.captureBasins).toBe(true);
      capture.reply({
        id: capture.requests.at(-1)!.id,
        type: 'result',
        result: { ...result(), basinDiagnostics: { version: 1, passes: [] } },
      });
      expect((await explicit).basinDiagnostics?.version).toBe(1);
    }
  });
  it('captures full-photo semantic labels only for explicit shared or dedicated requests', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    for (const signal of [undefined, new AbortController().signal]) {
      const ordinary = segmentRoom(blob(), undefined, { signal });
      const normal = FakeWorker.created.at(-1)!;
      expect(normal.requests.at(-1)?.captureSemanticLabels).toBeUndefined();
      normal.reply({ id: normal.requests.at(-1)!.id, type: 'result', result: result() });
      expect(await ordinary).not.toHaveProperty('semanticLabels');
      const explicit = segmentRoom(blob(), undefined, {
        signal,
        captureSemanticLabels: true,
        captureBasins: true,
      });
      const capture = FakeWorker.created.at(-1)!;
      expect(capture.requests.at(-1)).toMatchObject({ captureSemanticLabels: true, captureBasins: true });
      const labels = new Uint8Array([11]);
      capture.reply({
        id: capture.requests.at(-1)!.id,
        type: 'result',
        result: { ...result(), semanticLabels: labels },
      });
      expect((await explicit).semanticLabels).toBe(labels);
    }
  });
  it('starts no worker for an already aborted input', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    const controller = new AbortController();
    controller.abort();
    await expect(segmentRoom(blob(), undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(FakeWorker.created).toHaveLength(0);
  });
  it('cleans up model errors, worker crashes, bad messages and postMessage failures', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    for (const failure of ['model', 'crash', 'message', 'post']) {
      FakeWorker.failPost = failure === 'post';
      const promise = segmentRoom(blob(), undefined, { signal: new AbortController().signal });
      const rejection = expect(promise).rejects.toBeInstanceOf(Error);
      const worker = FakeWorker.created.at(-1)!;
      if (failure === 'model')
        worker.reply({ id: worker.requests[0].id, type: 'error', message: 'model failed' });
      if (failure === 'crash') worker.onerror?.();
      if (failure === 'message') worker.onmessageerror?.();
      await rejection;
      expect(worker.terminated).toBe(true);
    }
    FakeWorker.failConstructor = true;
    await expect(segmentRoom(blob(), undefined, { signal: new AbortController().signal })).rejects.toThrow(
      'worker blocked',
    );
  });
  it('allows slow dedicated inference for 15 minutes while retaining the shared 2-minute timeout', async () => {
    const { segmentRoom } = await import('../src/lib/segmentation');
    const own = segmentRoom(blob(), undefined, { signal: new AbortController().signal });
    const worker = FakeWorker.created[0];
    const ownRejection = expect(own).rejects.toThrow('제한 시간');
    await vi.advanceTimersByTimeAsync(120_001);
    expect(worker.terminated).toBe(false);
    const shared = segmentRoom(blob());
    const common = FakeWorker.created[1];
    const sharedRejection = expect(shared).rejects.toThrow('초과');
    await vi.advanceTimersByTimeAsync(120_000);
    await sharedRejection;
    expect(common.terminated).toBe(true);
    expect(worker.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(660_000);
    await ownRejection;
    expect(worker.terminated).toBe(true);
  });
});
