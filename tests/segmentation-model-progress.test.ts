import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSegmentation, SegmentationReply } from '../src/lib/segmentation';
import { DEEPLAB_MODEL_BYTES } from '../src/lib/ai-progress';

class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<SegmentationReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: { id: number }[] = [];
  constructor() {
    FakeWorker.created.push(this);
  }
  postMessage(request: { id: number }) {
    this.requests.push(request);
  }
  terminate() {}
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
  FakeWorker.created = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe('DeepLab model loading progress', () => {
  for (const withSignal of [false, true])
    it(`forwards runtime, byte and ready events without ending the job (${withSignal ? 'dedicated' : 'shared'} worker)`, async () => {
      const { segmentRoom } = await import('../src/lib/segmentation');
      const events: unknown[] = [];
      const stages: string[] = [];
      const job = segmentRoom(blob(), (message) => stages.push(message), {
        signal: withSignal ? new AbortController().signal : undefined,
        onModelProgress: (event) => events.push(event),
      });
      const worker = FakeWorker.created[0];
      const id = worker.requests[0].id;
      worker.reply({ id, type: 'model-progress', phase: 'runtime' });
      worker.reply({ id, type: 'model-progress', phase: 'download', fraction: 0.5 });
      worker.reply({ id, type: 'model-progress', phase: 'ready' });
      worker.reply({ id, type: 'stage', message: '사진 크기와 방향 확인 중' });
      worker.reply({ id, type: 'result', result: result() });
      await expect(job).resolves.toEqual(result());
      expect(events).toEqual([
        { phase: 'runtime', message: '브라우저 분석 엔진 준비 중' },
        {
          phase: 'download',
          message: '앱에 포함된 공간 분석 모델 읽는 중',
          loaded: Math.round(DEEPLAB_MODEL_BYTES / 2),
          total: DEEPLAB_MODEL_BYTES,
        },
        { phase: 'ready', message: '공간 분석 모델 준비 완료' },
      ]);
      // Stage text keeps working for existing callers.
      expect(stages).toContain('사진 크기와 방향 확인 중');
    });
});
