import type {
  BackgroundRemovalAttemptTimings,
  BackgroundRemovalProgress,
  BackgroundRemovalReply,
  BackgroundRemovalResult,
} from './types';

interface Pending {
  id: number;
  blob: Blob;
  cpuRetried: boolean;
  carryTimings?: BackgroundRemovalAttemptTimings;
  onProgress: (progress: BackgroundRemovalProgress) => void;
  resolve: (result: BackgroundRemovalResult) => void;
  reject: (error: Error) => void;
}

/** One worker/session per preview. Photos are passed as Blobs; nothing is uploaded or persisted. */
export class BackgroundRemovalClient {
  private worker?: Worker;
  private pending?: Pending;
  private sequence = 0;

  run(
    blob: Blob,
    onProgress: (progress: BackgroundRemovalProgress) => void,
  ): Promise<BackgroundRemovalResult> {
    if (this.pending)
      return Promise.reject(new Error('배경 제거가 진행 중이에요. 완료하거나 취소한 뒤 다시 실행해 주세요.'));
    if (typeof Worker === 'undefined')
      return Promise.reject(
        new Error('이 브라우저는 Web Worker를 지원하지 않아요. 최신 Chrome 또는 Edge에서 실행해 주세요.'),
      );
    if (!blob.size || blob.size > 25 * 1024 * 1024)
      return Promise.reject(new Error('제품 사진은 25MB 이하의 이미지여야 해요.'));
    try {
      if (!this.worker) this.createWorker();
    } catch (error) {
      return Promise.reject(
        new Error(`AI 작업을 시작할 수 없어요. ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending = { id, blob, cpuRetried: false, onProgress, resolve, reject };
      try {
        this.worker!.postMessage({ type: 'run', id, blob });
      } catch {
        this.fail('제품 사진을 AI 작업에 전달하지 못했어요. 사진을 다시 선택해 주세요.');
      }
    });
  }

  private createWorker() {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'sjn-background-removal',
    });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<BackgroundRemovalReply>) => {
      // GPU and CPU attempts share a job ID. Worker identity also gates late GPU events.
      if (this.worker !== worker) return;
      const message = event.data;
      const pending = this.pending;
      if (!pending || message.id !== pending.id) return;
      if (message.type === 'progress') {
        pending.onProgress(message.progress);
        return;
      }
      if (message.type === 'retry-cpu') {
        if (pending.cpuRetried) {
          this.fail('CPU 대체 처리를 완료하지 못했어요. 다시 시도해 주세요.');
          return;
        }
        pending.cpuRetried = true;
        pending.carryTimings = message.timings;
        // A failed GPU can poison the entire ORT/WASM instance. CPU needs a new worker,
        // not another InferenceSession in the old worker.
        worker.terminate();
        this.worker = undefined;
        try {
          pending.onProgress({ stage: 'initializing', message: message.message });
          if (this.pending !== pending) return; // The owner may cancel from its progress callback.
          const cpuWorker = this.createWorker();
          cpuWorker.postMessage({
            type: 'run',
            id: pending.id,
            blob: pending.blob,
            forceCpu: true,
            fallbackReason: message.message,
          });
        } catch (error) {
          this.fail(
            `CPU 대체 작업을 시작하지 못했어요. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      this.pending = undefined;
      if (message.type === 'result') {
        const carry = pending.carryTimings;
        pending.resolve(
          carry
            ? {
                ...message.result,
                downloadMs: carry.downloadMs + message.result.downloadMs,
                initializationMs: carry.initializationMs + message.result.initializationMs,
                processingMs: carry.processingMs + message.result.processingMs,
                inferenceMs: carry.inferenceMs + message.result.inferenceMs,
                cacheSource: carry.downloadMs > 0 ? 'network' : message.result.cacheSource,
              }
            : message.result,
        );
      } else {
        worker.terminate();
        this.worker = undefined;
        pending.reject(new Error(message.message));
      }
    };
    worker.onerror = () => {
      if (this.worker === worker)
        this.fail('AI 실행 엔진을 불러오지 못했어요. 브라우저와 네트워크 상태를 확인한 뒤 재시도해 주세요.');
    };
    worker.onmessageerror = () => {
      if (this.worker === worker) this.fail('AI 결과를 읽지 못했어요. 다시 시도해 주세요.');
    };
    return worker;
  }

  private fail(message: string) {
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    pending?.reject(new Error(message));
  }

  dispose() {
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    pending?.reject(new DOMException('배경 제거 테스트를 취소했어요.', 'AbortError'));
  }
}
