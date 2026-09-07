import type { ReconstructionCandidate } from '../reconstruction/types';
/** The photograph and masks stay in this browser. Only bundled static assets are fetched. */
export interface RoomSegmentation {
  objects?: ReconstructionCandidate[];
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
    timer: ReturnType<typeof setTimeout>;
  }
>();

function resetWorker(reason: string) {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
  pending.clear();
}

export function segmentRoom(
  blob: Blob,
  onStage?: (message: string) => void,
  options?: { quality?: 'reconstruction' },
): Promise<RoomSegmentation> {
  if (typeof Worker === 'undefined')
    return Promise.reject(
      new Error('이 브라우저는 사진 자동 분석을 지원하지 않아요. 최신 Chrome 또는 Edge에서 열어 주세요.'),
    );
  if (!blob.size || blob.size > 25 * 1024 * 1024)
    return Promise.reject(new Error('분석 사진은 25 MB 이하의 이미지여야 해요.'));
  if (pending.size >= 3) return Promise.reject(new Error('이전 사진 분석을 마친 뒤 다시 시도해 주세요.'));
  if (!worker) {
    onStage?.('브라우저 분석 엔진 준비 중');
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SegmentationReply>) => {
      const message = event.data;
      const request = pending.get(message.id);
      if (!request) return;
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
    pending.set(id, { resolve, reject, onStage, timer });
    worker!.postMessage({ id, blob, quality: options?.quality });
  });
}
