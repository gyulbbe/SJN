import type { Product3dProgress, Product3dReply, Product3dResult, Product3dTimings } from './types';
interface Pending {
  id: number;
  blob: Blob;
  cpuRetried: boolean;
  carry?: Product3dTimings;
  onProgress: (progress: Product3dProgress) => void;
  resolve: (result: Product3dResult) => void;
  reject: (reason: Error) => void;
}
function validTimings(t: Product3dTimings | undefined): t is Product3dTimings {
  return (
    !!t &&
    [t.downloadMs, t.initializationMs, t.processingMs].every((n) => Number.isFinite(n) && n >= 0) &&
    ['cache', 'network'].includes(t.cacheSource) &&
    typeof t.modelId === 'string' &&
    typeof t.modelRevision === 'string'
  );
}
export class Product3dClient {
  private worker?: Worker;
  private pending?: Pending;
  private sequence = 0;
  run(blob: Blob, onProgress: Pending['onProgress']): Promise<Product3dResult> {
    if (this.pending) return Promise.reject(new Error('입체화가 진행 중이에요. 완료하거나 취소해 주세요.'));
    if (typeof Worker === 'undefined')
      return Promise.reject(new Error('이 브라우저는 Web Worker를 지원하지 않아요.'));
    if (!blob.size || blob.size > 100 * 1024 * 1024)
      return Promise.reject(new Error('제품 사진이 비어 있거나 너무 커요.'));
    return new Promise((resolve, reject) => {
      this.pending = { id: ++this.sequence, blob, cpuRetried: false, onProgress, resolve, reject };
      this.startWorker();
    });
  }
  private startWorker(forceCpu = false) {
    const job = this.pending;
    if (!job) return;
    try {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
        name: 'sjn-product3d',
      });
      this.worker = worker;
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker === worker)
          this.fail('입체화 작업이 중단됐어요. 브라우저와 메모리를 확인한 뒤 다시 시도해 주세요.');
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) this.fail('입체화 결과를 읽지 못했어요.');
      };
      worker.onmessage = (event: MessageEvent<Product3dReply>) => {
        const pending = this.pending;
        if (!pending || this.worker !== worker) return;
        const message = event.data;
        if (!message || typeof message !== 'object' || !Number.isInteger(message.id)) {
          this.fail('입체화 응답 형식이 올바르지 않아요.');
          return;
        }
        if (message.id !== pending.id) return;
        if (message.type === 'progress') {
          if (!message.progress || typeof message.progress.message !== 'string') {
            this.fail('입체화 진행 상태를 읽지 못했어요.');
            return;
          }
          pending.onProgress(message.progress);
          return;
        }
        if (message.type === 'error') {
          if (message.retryCpu && !pending.cpuRetried) {
            pending.cpuRetried = true;
            pending.carry = validTimings(message.timings) ? message.timings : undefined;
            worker.terminate();
            this.worker = undefined;
            pending.onProgress({
              stage: 'initializing',
              message: 'GPU 처리를 완료하지 못해 같은 모델을 CPU로 실행해요. 수 분 이상 걸릴 수 있어요.',
            });
            if (this.pending === pending) this.startWorker(true);
          } else this.fail(typeof message.message === 'string' ? message.message : '입체화에 실패했어요.');
          return;
        }
        if (
          message.type !== 'mesh' ||
          !(message.mesh?.positions instanceof Float32Array) ||
          !(message.mesh?.indices instanceof Uint32Array) ||
          !(message.mesh?.colors instanceof Float32Array) ||
          !validTimings(message.timings)
        ) {
          this.fail('입체화 결과가 불완전해요. 다시 시도해 주세요.');
          return;
        }
        worker.terminate();
        this.worker = undefined;
        this.pending = undefined;
        const carry = pending.carry;
        pending.resolve({
          mesh: message.mesh,
          timings: {
            ...message.timings,
            downloadMs: message.timings.downloadMs + (carry?.downloadMs ?? 0),
            initializationMs: message.timings.initializationMs + (carry?.initializationMs ?? 0),
            processingMs: message.timings.processingMs + (carry?.processingMs ?? 0),
            cacheSource: carry?.cacheSource === 'network' ? 'network' : message.timings.cacheSource,
            cacheNotice: message.timings.cacheNotice ?? carry?.cacheNotice,
          },
        });
      };
      worker.postMessage({
        type: 'run',
        id: job.id,
        blob: job.blob,
        ...(forceCpu ? { forceCpu: true } : {}),
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '입체화를 시작하지 못했어요.');
    }
  }
  private fail(message: string) {
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    pending?.reject(new Error(message));
  }
  dispose() {
    this.fail('입체화를 취소했어요.');
  }
}
