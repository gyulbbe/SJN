import { BACKGROUND_MODEL_CACHE, BACKGROUND_MODEL_FILES, backgroundModelUrl } from './model';
import type { BackgroundRemovalProgress } from './types';

type Progress = (progress: BackgroundRemovalProgress) => void;

/** Inspect the actual cached body without allocating a second model-sized JS ArrayBuffer. */
async function getCachedModelBlob(cache: Cache, precision: 'fp16' | 'fp32'): Promise<Blob | undefined> {
  const url = backgroundModelUrl(precision);
  try {
    const response = await cache.match(url);
    if (!response) return undefined;
    const blob = response.ok ? await response.blob() : undefined;
    if (blob?.size === BACKGROUND_MODEL_FILES[precision].bytes) return blob;
    // An incomplete model must never select a backend or be handed to ONNX Runtime.
    // Delete only this exact immutable model entry; deletion failure is non-fatal.
    await cache.delete(url).catch(() => false);
  } catch {
    // Cache access/body-reading failures are equivalent to a cache miss for this model.
  }
  return undefined;
}

export async function getCachedBackgroundModels(): Promise<{ fp16: boolean; fp32: boolean }> {
  if (typeof caches === 'undefined') return { fp16: false, fp32: false };
  try {
    const cache = await caches.open(BACKGROUND_MODEL_CACHE);
    const [fp16, fp32] = await Promise.all([
      getCachedModelBlob(cache, 'fp16'),
      getCachedModelBlob(cache, 'fp32'),
    ]);
    return { fp16: !!fp16, fp32: !!fp32 };
  } catch {
    return { fp16: false, fp32: false };
  }
}

/** Call only after successful CPU inference. Never remove FP32, other revisions or other caches. */
export async function removeBackgroundGpuModel(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(BACKGROUND_MODEL_CACHE);
    return await cache.delete(backgroundModelUrl('fp16'));
  } catch {
    return false;
  }
}

export async function readModelResponse(
  response: Response,
  expectedBytes: number,
  progress: (loaded: number) => void,
) {
  if (!response.ok)
    throw new Error(`모델 다운로드 실패 (HTTP ${response.status}). 네트워크 상태를 확인해 주세요.`);
  const bytes = new Uint8Array(expectedBytes);
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== expectedBytes)
      throw new Error('모델 파일을 완전히 받지 못했어요. 다시 시도해 주세요.');
    bytes.set(new Uint8Array(buffer));
    progress(expectedBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > expectedBytes)
        throw new Error('모델 파일 크기가 고정된 버전 정보와 달라요. 다시 시도해 주세요.');
      bytes.set(value, loaded);
      loaded += value.length;
      progress(loaded);
    }
    if (loaded !== expectedBytes) throw new Error('모델 파일을 완전히 받지 못했어요. 다시 시도해 주세요.');
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function loadBackgroundModel(precision: 'fp16' | 'fp32', progress: Progress) {
  const url = backgroundModelUrl(precision);
  const expectedBytes = BACKGROUND_MODEL_FILES[precision].bytes;
  const cacheStart = performance.now();
  let cache: Cache | undefined;
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(BACKGROUND_MODEL_CACHE);
      const cached = await getCachedModelBlob(cache, precision);
      if (cached) {
        const buffer = await cached.arrayBuffer();
        progress({ stage: 'initializing', message: '저장된 AI 모델을 캐시에서 불러왔어요.' });
        return {
          bytes: new Uint8Array(buffer),
          downloadMs: 0,
          cacheReadMs: performance.now() - cacheStart,
          cacheSource: 'cache' as const,
        };
      }
    }
  } catch {
    /* Private mode/quota denial must not prevent an uncached local inference. */
  }
  const cacheReadMs = performance.now() - cacheStart;
  progress({
    stage: 'download',
    message: `${precision.toUpperCase()} AI 모델 다운로드 중`,
    loadedBytes: 0,
    totalBytes: expectedBytes,
  });
  const started = performance.now();
  const abort = new AbortController();
  let timeout = setTimeout(() => abort.abort(), 90_000);
  let lastProgress = 0;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      // Keep model retention under our CacheStorage policy, not a second HTTP cache.
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    bytes = await readModelResponse(response, expectedBytes, (loaded) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => abort.abort(), 90_000);
      const now = performance.now();
      if (now - lastProgress >= 80 || loaded === expectedBytes) {
        lastProgress = now;
        progress({
          stage: 'download',
          message: `${precision.toUpperCase()} AI 모델 다운로드 중`,
          loadedBytes: loaded,
          totalBytes: expectedBytes,
        });
      }
    });
  } catch (error) {
    if (abort.signal.aborted)
      throw new Error('모델 다운로드 응답이 90초 동안 없었어요. 네트워크 연결을 확인하고 재시도해 주세요.');
    if (error instanceof TypeError)
      throw new Error(
        '모델 다운로드에 연결하지 못했어요. 인터넷 연결 또는 huggingface.co 접속 차단 여부를 확인해 주세요.',
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const downloadMs = performance.now() - started;
  const storeStart = performance.now();
  try {
    await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch {
    progress({
      stage: 'initializing',
      message: '모델 캐시 저장 공간이 부족해요. 이번 테스트는 계속 진행해요.',
    });
  }
  return {
    bytes,
    downloadMs,
    cacheReadMs: cacheReadMs + performance.now() - storeStart,
    cacheSource: 'network' as const,
  };
}
