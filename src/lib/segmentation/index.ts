import type { BasinComponentCapture } from '../reconstruction/basin-observations';
import type { ReconstructionCandidate } from '../reconstruction/types';
import { DEEPLAB_MODEL_BYTES, type ModelLoadEvent } from '../ai-progress';
export type BasinPassCapture = {
  context: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  sourceRegion: ReconstructionCandidate['bounds'];
  flipped: boolean;
  components: BasinComponentCapture[];
};
/** The photograph and masks stay in this browser. Only bundled static assets are fetched. */
export interface RoomSegmentation {
  objects?: ReconstructionCandidate[];
  /** Explicit development capture only; never requested by ordinary editing or persisted in projects. */
  basinDiagnostics?: { version: 1; passes: BasinPassCapture[] };
  /** Explicit development capture of the first full-photo pass only; absent for ordinary callers. */
  semanticLabels?: Uint8Array;
  width: number;
  height: number;
  /** Row-major masks, 0 outside / 255 inside. Coordinates cover the whole oriented photo. */
  wall: Uint8Array;
  floor: Uint8Array;
  /** Conservative semantic/RGB wall guards; these are heuristics, not verified object identities. */
  wallRefinement?: {
    excludedPixels: number;
    fixturePixels: number;
    exterior: { side: 'left' | 'right'; x: number; strength: number }[];
  };
}

export type SegmentationReply =
  | { id: number; type: 'stage'; message: string }
  /** Model/runtime loading only; absent once this worker has them in memory. */
  | { id: number; type: 'model-progress'; phase: 'runtime' | 'download' | 'ready'; fraction?: number }
  | { id: number; type: 'result'; result: RoomSegmentation }
  | { id: number; type: 'error'; message: string };

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<
  number,
  {
    resolve: (result: RoomSegmentation) => void;
    reject: (reason: Error) => void;
    onStage?: (message: string) => void;
    onModelProgress?: (event: ModelLoadEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function modelLoadEvent(message: Extract<SegmentationReply, { type: 'model-progress' }>): ModelLoadEvent {
  if (message.phase === 'runtime') return { phase: 'runtime', message: '브라우저 분석 엔진 준비 중' };
  if (message.phase === 'ready') return { phase: 'ready', message: '공간 분석 모델 준비 완료' };
  const fraction = Math.max(0, Math.min(1, message.fraction ?? 0));
  return {
    phase: 'download',
    message: '앱에 포함된 공간 분석 모델 읽는 중',
    loaded: Math.round(fraction * DEEPLAB_MODEL_BYTES),
    total: DEEPLAB_MODEL_BYTES,
  };
}

function resetWorker(reason: string) {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
  pending.clear();
}

const dedicatedWorkers = new Set<Worker>();
/** Signal-aware jobs own their worker so cancelling a lab/dialog never interrupts another consumer. */
function segmentDedicated(
  blob: Blob,
  onStage: ((message: string) => void) | undefined,
  options: {
    signal: AbortSignal;
    quality?: 'reconstruction';
    timeoutMs?: number;
    captureBasins?: boolean;
    captureSemanticLabels?: boolean;
    onModelProgress?: (event: ModelLoadEvent) => void;
  },
): Promise<RoomSegmentation> {
  return new Promise((resolve, reject) => {
    let owned: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error, result?: RoomSegmentation) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (owned) {
        owned.onmessage = null;
        owned.onerror = null;
        owned.onmessageerror = null;
        owned.terminate();
        dedicatedWorkers.delete(owned);
      }
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('사진 분석 결과를 읽지 못했어요.'));
    };
    const abort = () => finish(new DOMException('사진 분석을 취소했어요.', 'AbortError'));
    if (options.signal.aborted) {
      abort();
      return;
    }
    const id = ++sequence;
    try {
      onStage?.('브라우저 분석 엔진 준비 중');
      owned = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      dedicatedWorkers.add(owned);
      options.signal.addEventListener('abort', abort, { once: true });
      owned.onmessage = (event: MessageEvent<SegmentationReply>) => {
        const message = event.data;
        if (settled || options.signal.aborted || message.id !== id) return;
        if (message.type === 'model-progress') {
          options.onModelProgress?.(modelLoadEvent(message));
          return;
        }
        if (message.type === 'stage') {
          try {
            onStage?.(message.message);
          } catch (error) {
            finish(error instanceof Error ? error : new Error('사진 분석 상태를 표시하지 못했어요.'));
          }
        } else if (message.type === 'error') finish(new Error(message.message));
        else finish(undefined, message.result);
      };
      owned.onerror = () => finish(new Error('사진 분석 엔진을 불러오지 못했어요. 다시 시도해 주세요.'));
      owned.onmessageerror = () => finish(new Error('사진 분석 결과를 읽지 못했어요. 다시 시도해 주세요.'));
      timer = setTimeout(
        () =>
          finish(
            new Error(
              '사진 분석 제한 시간을 넘었어요. 작은 사진으로 다시 시도하거나 브라우저 상태를 확인해 주세요.',
            ),
          ),
        Math.max(1000, Math.min(15 * 60_000, options.timeoutMs ?? 15 * 60_000)),
      );
      if (options.signal.aborted) {
        abort();
        return;
      }
      owned.postMessage({
        id,
        blob,
        quality: options.quality,
        captureBasins: options.captureBasins,
        captureSemanticLabels: options.captureSemanticLabels,
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error('사진 분석 엔진을 시작하지 못했어요.'));
    }
  });
}

export function segmentRoom(
  blob: Blob,
  onStage?: (message: string) => void,
  options?: {
    quality?: 'reconstruction';
    signal?: AbortSignal;
    timeoutMs?: number;
    captureBasins?: boolean;
    captureSemanticLabels?: boolean;
    /** Structured runtime/model loading progress (DeepLab is bundled, about 2.4 MB). */
    onModelProgress?: (event: ModelLoadEvent) => void;
  },
): Promise<RoomSegmentation> {
  if (options?.signal?.aborted)
    return Promise.reject(new DOMException('사진 분석을 취소했어요.', 'AbortError'));
  if (typeof Worker === 'undefined')
    return Promise.reject(
      new Error('이 브라우저는 사진 자동 분석을 지원하지 않아요. 최신 Chrome 또는 Edge에서 열어 주세요.'),
    );
  if (!blob.size || blob.size > 25 * 1024 * 1024)
    return Promise.reject(new Error('분석 사진은 25 MB 이하의 이미지여야 해요.'));
  if (pending.size + dedicatedWorkers.size >= 3)
    return Promise.reject(new Error('이전 사진 분석을 마친 뒤 다시 시도해 주세요.'));
  if (options?.signal) return segmentDedicated(blob, onStage, { ...options, signal: options.signal });
  if (!worker) {
    onStage?.('브라우저 분석 엔진 준비 중');
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SegmentationReply>) => {
      const message = event.data;
      const request = pending.get(message.id);
      if (!request) return;
      if (message.type === 'model-progress') {
        request.onModelProgress?.(modelLoadEvent(message));
        return;
      }
      if (message.type === 'stage') {
        request.onStage?.(message.message);
        return;
      }
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.type === 'error') request.reject(new Error(message.message));
      else request.resolve(message.result);
    };
    worker.onerror = () =>
      resetWorker('사진 분석 엔진을 불러오지 못했어요. 페이지를 새로 열고 다시 시도해 주세요.');
    worker.onmessageerror = () => resetWorker('사진 분석 결과를 읽지 못했어요. 다시 시도해 주세요.');
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resetWorker('사진 분석 시간이 초과되었어요. 작은 사진으로 다시 시도해 주세요.'),
      120_000,
    );
    pending.set(id, { resolve, reject, onStage, onModelProgress: options?.onModelProgress, timer });
    worker!.postMessage({
      id,
      blob,
      quality: options?.quality,
      captureBasins: options?.captureBasins,
      captureSemanticLabels: options?.captureSemanticLabels,
    });
  });
}
