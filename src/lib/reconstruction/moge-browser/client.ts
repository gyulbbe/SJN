import { mogeModelUrl } from './artifact';
import type {
  MogeBrowserResult,
  MogeExecutionMode,
  MogeGeometryInput,
  MogeProgress,
  MogeReply,
  MogeRequest,
} from './protocol';

export type MogeRunOptions = {
  mode?: MogeExecutionMode;
  geometry?: MogeGeometryInput;
  modelUrl?: string;
  signal?: AbortSignal;
  onProgress?: (progress: MogeProgress) => void;
  timeoutMs?: number;
};
type Pending = {
  request: MogeRequest;
  options: MogeRunOptions;
  retried: boolean;
  resolve: (result: MogeBrowserResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** One bounded job, one Worker at a time. A failed GPU is replaced by a fresh CPU Worker. */
export class MogeBrowserClient {
  private worker?: Worker;
  private pending?: Pending;
  private sequence = 0;

  run(blob: Blob, options: MogeRunOptions = {}): Promise<MogeBrowserResult> {
    if (this.pending)
      return Promise.reject(new Error('이미 형상 분석이 진행 중이에요. 완료하거나 취소한 뒤 실행해 주세요.'));
    if (options.signal?.aborted)
      return Promise.reject(new DOMException('형상 분석을 취소했어요.', 'AbortError'));
    if (typeof Worker === 'undefined')
      return Promise.reject(new Error('이 브라우저는 Web Worker를 지원하지 않아요.'));
    return new Promise((resolve, reject) => {
      let modelUrl: string;
      try {
        modelUrl = mogeModelUrl(options.modelUrl);
      } catch (error) {
        reject(error);
        return;
      }
      const request: MogeRequest = {
        type: 'run',
        id: ++this.sequence,
        blob,
        mode: options.mode ?? 'auto',
        geometry: options.geometry,
        modelUrl,
      };
      const abort = () => this.cancel();
      const timeout = setTimeout(
        () =>
          this.fail(
            new Error('형상 분석 제한 시간을 초과했어요. CPU 모드 또는 기본 분석으로 다시 시도해 주세요.'),
          ),
        options.timeoutMs ?? 10 * 60_000,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
      };
      this.pending = { request, options, retried: false, resolve, reject, cleanup };
      try {
        this.createWorker().postMessage(request);
      } catch (error) {
        this.fail(
          new Error(
            `형상 분석 작업을 시작하지 못했어요. ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  private createWorker() {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'sjn-moge2' });
    this.worker = worker;
    worker.onmessage = ({ data: reply }: MessageEvent<MogeReply>) => {
      if (this.worker !== worker || !this.pending || reply.id !== this.pending.request.id) return;
      const pending = this.pending;
      if (reply.type === 'progress') {
        pending.options.onProgress?.(reply.progress);
        return;
      }
      if (reply.type === 'retry-cpu') {
        if (pending.retried || pending.request.mode !== 'auto') {
          this.fail(new Error(reply.message));
          return;
        }
        pending.retried = true;
        worker.terminate();
        this.worker = undefined;
        pending.options.onProgress?.({ stage: 'initializing', message: reply.message });
        if (this.pending !== pending) return;
        try {
          // Passing the already verified bytes also prevents a second download when CacheStorage is unavailable.
          const request: MogeRequest = {
            ...pending.request,
            mode: 'wasm',
            model: reply.model,
            carryTimings: reply.timings,
            fallbackReason: reply.message,
          };
          this.createWorker().postMessage(request, [reply.model.bytes.buffer]);
        } catch (error) {
          this.fail(new Error(`CPU 형상 분석을 시작하지 못했어요. ${String(error)}`));
        }
        return;
      }
      if (reply.type === 'error') {
        this.fail(new Error(reply.message));
        return;
      }
      this.pending = undefined;
      pending.cleanup();
      worker.terminate();
      this.worker = undefined;
      pending.resolve({ ...reply.result, requestedMode: pending.request.mode });
    };
    worker.onerror = () => {
      if (this.worker === worker)
        this.fail(new Error('MoGe 실행 엔진이 종료되었어요. 브라우저와 메모리 상태를 확인해 주세요.'));
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.fail(new Error('MoGe 형상 분석 결과를 읽지 못했어요.'));
    };
    return worker;
  }

  private fail(error: Error) {
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    pending?.cleanup();
    pending?.reject(error);
  }
  cancel() {
    this.fail(new DOMException('형상 분석을 취소했어요.', 'AbortError'));
  }
  dispose() {
    this.cancel();
  }
}

export type { MogeBrowserResult, MogeExecutionMode, MogeGeometryInput, MogeProgress } from './protocol';
