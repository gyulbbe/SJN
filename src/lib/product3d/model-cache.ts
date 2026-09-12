import { readModelResponse } from '../background-removal/model-cache';
import {
  PRODUCT3D_PART_LABELS,
  PRODUCT3D_FILES,
  PRODUCT3D_MODEL_CACHE,
  product3dModelUrl,
  type Product3dModelPart,
} from './model';
import type { Product3dProgress } from './types';

export async function loadProduct3dModel(part: Product3dModelPart, progress: (p: Product3dProgress) => void) {
  const url = product3dModelUrl(part);
  const expected = PRODUCT3D_FILES[part].bytes;
  let cache: Cache | undefined;
  const started = performance.now();
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(PRODUCT3D_MODEL_CACHE);
      const response = await cache.match(url);
      if (response) {
        const blob = response.ok ? await response.blob() : undefined;
        if (blob?.size === expected)
          return {
            bytes: new Uint8Array(await blob.arrayBuffer()),
            downloadMs: 0,
            cacheMs: performance.now() - started,
            cacheSource: 'cache' as const,
          };
        await cache.delete(url).catch(() => false);
      }
    }
  } catch {
    /* Cache unavailability must not silently prevent local inference. */
  }
  const cacheReadMs = performance.now() - started;
  const abort = new AbortController();
  let timeout = setTimeout(() => abort.abort(), 120_000);
  const begin = performance.now();
  let lastProgress = 0;
  let bytes: Uint8Array<ArrayBuffer>;
  progress({
    stage: 'download',
    message: `${PRODUCT3D_PART_LABELS[part]} 모델 다운로드 중`,
    loadedBytes: 0,
    totalBytes: expected,
  });
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    bytes = await readModelResponse(response, expected, (loaded) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => abort.abort(), 120_000);
      if (performance.now() - lastProgress > 100 || loaded === expected) {
        lastProgress = performance.now();
        progress({
          stage: 'download',
          message: `${PRODUCT3D_PART_LABELS[part]} 모델 다운로드 중`,
          loadedBytes: loaded,
          totalBytes: expected,
        });
      }
    });
  } catch (error) {
    if (abort.signal.aborted)
      throw new Error('모델 다운로드 응답이 2분 동안 없었어요. 인터넷 연결을 확인하고 다시 시도해 주세요.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const downloadMs = performance.now() - begin;
  const storeStart = performance.now();
  let cacheNotice: string | undefined;
  try {
    if (!cache) throw new Error('cache unavailable');
    await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch {
    cacheNotice =
      '모델을 브라우저에 보관하지 못했어요. 이번 생성은 계속하지만 다음 실행 때 다시 다운로드할 수 있어요.';
  }
  return {
    bytes,
    downloadMs,
    cacheMs: cacheReadMs + performance.now() - storeStart,
    cacheSource: 'network' as const,
    cacheNotice,
  };
}
