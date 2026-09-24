import { MOGE_ARTIFACT, MOGE_MODEL_CACHE } from './artifact';
import type { MogeModelBytes, MogeProgress } from './protocol';

export class MogeDownloadError extends Error {
  readonly code = 'download';
}
export class MogeIntegrityError extends Error {
  readonly code = 'integrity';
}

export async function verifyMogeModel(bytes: Uint8Array<ArrayBuffer>) {
  if (bytes.byteLength !== MOGE_ARTIFACT.bytes)
    throw new MogeIntegrityError('MoGe 모델 파일의 크기가 공식 파일과 달라요.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== MOGE_ARTIFACT.sha256)
    throw new MogeIntegrityError('MoGe 모델 파일의 무결성 검증에 실패했어요.');
}

/** Verified bytes are also retained for a fresh-worker GPU→CPU retry when persistent storage is denied. */
export async function loadMogeModel(
  url: string,
  progress: (progress: MogeProgress) => void,
  signal?: AbortSignal,
): Promise<MogeModelBytes> {
  signal?.throwIfAborted();
  const cacheStart = performance.now();
  let cache: Cache | undefined;
  let cacheNotice: string | undefined;
  progress({ stage: 'cache', message: '저장된 MoGe 모델을 확인하는 중' });
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(MOGE_MODEL_CACHE);
      const hit = await cache.match(url);
      if (hit) {
        try {
          const blob = await hit.blob();
          if (blob.size !== MOGE_ARTIFACT.bytes) throw new MogeIntegrityError('잘못된 캐시 크기');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          progress({
            stage: 'verifying',
            message: '저장된 MoGe 모델의 무결성을 확인하는 중',
            cacheSource: 'cache',
          });
          await verifyMogeModel(bytes);
          signal?.throwIfAborted();
          return { bytes, downloadMs: 0, cacheMs: performance.now() - cacheStart, cacheSource: 'cache' };
        } catch (error) {
          signal?.throwIfAborted();
          await cache.delete(url).catch(() => false);
          cacheNotice =
            error instanceof MogeIntegrityError
              ? '손상된 모델 캐시를 삭제하고 다시 받았어요.'
              : '모델 캐시를 읽지 못해 다시 받았어요.';
        }
      }
    } else cacheNotice = '이 브라우저에서는 모델을 영구 저장할 수 없어요.';
  } catch {
    cacheNotice = '브라우저가 모델 저장소 접근을 허용하지 않아 이번 작업에서만 사용해요.';
  }
  signal?.throwIfAborted();
  const cacheMs = performance.now() - cacheStart;
  const downloadStart = performance.now();
  let bytes: Uint8Array<ArrayBuffer>;
  progress({
    stage: 'downloading',
    message: 'MoGe 형상 모델을 다운로드하는 중',
    loaded: 0,
    total: MOGE_ARTIFACT.bytes,
    cacheSource: 'network',
  });
  try {
    const response = await fetch(url, {
      signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      // Hugging Face answers a *.workers.dev Referer with a 404 that has no CORS header, which the
      // browser reports as "Failed to fetch". The other model downloads already send none.
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok || response.type === 'opaque')
      throw new MogeDownloadError(`MoGe 모델 다운로드에 실패했어요 (HTTP ${response.status}).`);
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) !== MOGE_ARTIFACT.bytes)
      throw new MogeIntegrityError('다운로드 서버가 잘못된 MoGe 파일 크기를 반환했어요.');
    if (!response.body) throw new MogeDownloadError('브라우저에서 MoGe 다운로드 스트림을 읽지 못했어요.');
    bytes = new Uint8Array(MOGE_ARTIFACT.bytes);
    const reader = response.body.getReader();
    let offset = 0;
    let lastProgress = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > bytes.byteLength)
          throw new MogeIntegrityError('MoGe 모델 다운로드 크기가 허용 범위를 넘었어요.');
        bytes.set(value, offset);
        offset += value.byteLength;
        if (performance.now() - lastProgress > 120 || offset === bytes.length) {
          progress({
            stage: 'downloading',
            message: 'MoGe 형상 모델을 다운로드하는 중',
            loaded: offset,
            total: bytes.length,
            cacheSource: 'network',
          });
          lastProgress = performance.now();
        }
      }
      if (offset !== bytes.length)
        throw new MogeIntegrityError('MoGe 모델 다운로드가 완료되기 전에 연결이 종료되었어요.');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof MogeIntegrityError || error instanceof MogeDownloadError) throw error;
    throw new MogeDownloadError(
      `MoGe 모델을 다운로드하지 못했어요. 인터넷 연결과 모델 제공 서버 접근을 확인해 주세요. ${error instanceof Error ? error.message : ''}`,
    );
  }
  const downloadMs = performance.now() - downloadStart;
  progress({
    stage: 'verifying',
    message: '다운로드한 MoGe 모델의 무결성을 확인하는 중',
    cacheSource: 'network',
  });
  const storeStart = performance.now();
  await verifyMogeModel(bytes);
  signal?.throwIfAborted();
  if (cache) {
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < bytes.length)
        throw new Error('insufficient quota');
      await cache.put(
        url,
        new Response(bytes, {
          headers: { 'Content-Type': 'application/octet-stream', 'X-SJN-SHA256': MOGE_ARTIFACT.sha256 },
        }),
      );
    } catch {
      cacheNotice = '저장 공간이 부족하거나 캐시 저장이 차단되어 모델을 이번 작업에서만 사용해요.';
    }
  }
  signal?.throwIfAborted();
  return {
    bytes,
    downloadMs,
    cacheMs: cacheMs + performance.now() - storeStart,
    cacheSource: 'network',
    cacheNotice,
  };
}
