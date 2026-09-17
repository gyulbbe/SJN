import { analysisCacheAllowed } from './analysis-cache-policy';
import { openDB } from 'idb';
import type { RoomSegmentation } from '../segmentation';
import type { SceneUnderstanding } from './pipeline-contract';
import {
  geometryRequestMetadataSchema,
  validateBrowserGeometryAnalysis,
  BROWSER_GEOMETRY_REVISION,
  type LocalGeometryAnalysis,
} from './geometry-contract';
import {
  MogeBrowserClient,
  type MogeExecutionMode,
  type MogeProgress,
  type MogeBrowserResult,
} from './moge-browser/client';
import {
  MOGE_ARTIFACT,
  MOGE_PREPROCESS_VERSION,
  MOGE_NUM_TOKENS,
  MOGE_MAX_INPUT_SIDE,
  mogeInputSize,
} from './moge-browser/artifact';
import { MOGE_POSTPROCESS_VERSION } from './moge-browser/postprocess';
import { MOGE_PLANES_VERSION } from './moge-browser/planes';

type CachedGeometry = { analysis: LocalGeometryAnalysis; checksum: string };
const memory = new Map<string, CachedGeometry>();
const digest = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
async function db() {
  return openDB('sjn-browser-geometry-stages', 1, {
    upgrade(value) {
      value.createObjectStore('results');
    },
  });
}

export async function browserGeometryInput(
  photo: Blob,
  segmentation: RoomSegmentation,
  understanding: SceneUnderstanding,
) {
  const inputFingerprint = await digest(await photo.arrayBuffer());
  const bitmap = await createImageBitmap(photo);
  const image = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  const metadata = geometryRequestMetadataSchema.parse({
    version: 1,
    inputFingerprint,
    image,
    mask: { width: segmentation.width, height: segmentation.height },
    regions: [
      ...(segmentation.objects ?? []).map((item) => ({
        id: 'seg-' + item.id,
        kind: item.kind,
        bounds: item.bounds,
        source: 'segmentation',
      })),
      ...understanding.candidates.map((item) => ({
        id: 'inventory-' + item.id,
        kind: item.kind,
        bounds: item.bounds,
        source: 'inventory',
        reflection: item.reflection,
      })),
    ],
  });
  if (
    segmentation.floor.length !== metadata.mask.width * metadata.mask.height ||
    segmentation.wall.length !== segmentation.floor.length
  )
    throw new Error('벽·바닥 분할 마스크의 크기가 사진과 맞지 않아요.');
  return { metadata, floor: Uint8Array.from(segmentation.floor), wall: Uint8Array.from(segmentation.wall) };
}

export function geometryAnalysisFromBrowser(
  result: MogeBrowserResult,
  input: Awaited<ReturnType<typeof browserGeometryInput>>,
): LocalGeometryAnalysis {
  if (!result.planes) throw new Error('깊이 추론 이후 벽·바닥 추출 결과가 없어요.');
  const { metadata } = input;
  const size = mogeInputSize(metadata.image.width, metadata.image.height);
  const actual = result.metadata;
  if (
    actual.artifact.repository !== MOGE_ARTIFACT.repository ||
    actual.artifact.revision !== MOGE_ARTIFACT.revision ||
    actual.artifact.sha256 !== MOGE_ARTIFACT.sha256 ||
    actual.preprocessVersion !== MOGE_PREPROCESS_VERSION ||
    actual.precision !== 'fp32' ||
    actual.numTokens !== MOGE_NUM_TOKENS ||
    actual.sourceWidth !== metadata.image.width ||
    actual.sourceHeight !== metadata.image.height ||
    actual.inputWidth !== size.width ||
    actual.inputHeight !== size.height ||
    result.raw.width !== size.width ||
    result.raw.height !== size.height ||
    result.dense.width !== size.width ||
    result.dense.height !== size.height ||
    result.dense.diagnostics.revision !== MOGE_POSTPROCESS_VERSION ||
    result.planes.evidence.revision !== MOGE_PLANES_VERSION
  )
    throw new Error('실행한 MoGe 모델·사진·해상도·후처리 정보가 현재 요청과 달라요.');
  return validateBrowserGeometryAnalysis(
    {
      inputFingerprint: metadata.inputFingerprint,
      observation: {
        version: 1,
        inputFingerprint: metadata.inputFingerprint,
        image: metadata.image,
        analysisImage: size,
        model: { id: MOGE_ARTIFACT.repository, revision: MOGE_ARTIFACT.revision },
        coordinateSystem: 'opencv-camera',
        scale: 'model-estimated-metres',
        intrinsics: result.dense.intrinsics,
        floor: result.planes.floor,
        walls: result.planes.walls,
      },
      measurement: {
        requestMs: result.timings.totalMs,
        modelLoadMs: result.timings.initializationMs,
        inferenceMs: result.timings.inferenceMs,
        planeExtractionMs: result.timings.planeExtractionMs,
        preprocessingMs: result.timings.preprocessingMs,
        postprocessingMs: result.timings.postprocessingMs,
        downloadMs: result.timings.downloadMs,
        cacheMs: result.timings.cacheMs,
        cacheHit: false,
        modelCacheHit: result.cacheSource !== 'network',
        modelDownload: result.cacheSource,
        backend: result.backend,
        wasmThreads: result.metadata.wasmThreads,
        memoryScope: '브라우저 모델 실행 메모리 최고치: 측정 불가. 파일 크기는 메모리 사용량이 아님.',
        fallbackReason: result.fallbackReason,
        cacheWarning: result.cacheNotice,
      },
      evidence: {
        ...result.planes.evidence,
        revision: BROWSER_GEOMETRY_REVISION,
        planeAlgorithmRevision: MOGE_PLANES_VERSION,
        artifactSha256: MOGE_ARTIFACT.sha256,
        preprocessRevision: MOGE_PREPROCESS_VERSION,
        postprocessRevision: MOGE_POSTPROCESS_VERSION,
        precision: result.metadata.precision,
        numTokens: result.metadata.numTokens,
        inputWidth: result.metadata.inputWidth,
        inputHeight: result.metadata.inputHeight,
        runtimeVersion: result.metadata.runtimeVersion,
        backend: result.backend,
        crossOriginIsolated: result.metadata.crossOriginIsolated,
        cameraRecovery: result.dense.diagnostics,
      },
    },
    metadata.inputFingerprint,
  );
}

export async function analyzeGeometryInBrowser(
  photo: Blob,
  segmentation: RoomSegmentation,
  understanding: SceneUnderstanding,
  signal: AbortSignal,
  options: {
    mode?: MogeExecutionMode;
    onProgress?: (progress: MogeProgress) => void;
    onResult?: (result: MogeBrowserResult) => void;
  } = {},
): Promise<LocalGeometryAnalysis> {
  signal.throwIfAborted();
  const input = await browserGeometryInput(photo, segmentation, understanding);
  const key = await digest(
    new TextEncoder().encode(
      JSON.stringify({
        metadata: input.metadata,
        artifact: MOGE_ARTIFACT,
        preprocess: MOGE_PREPROCESS_VERSION,
        postprocess: MOGE_POSTPROCESS_VERSION,
        planes: MOGE_PLANES_VERSION,
        revision: BROWSER_GEOMETRY_REVISION,
        mode: options.mode ?? 'auto',
        tokens: MOGE_NUM_TOKENS,
        edge: MOGE_MAX_INPUT_SIDE,
        floor: await digest(input.floor.buffer),
        wall: await digest(input.wall.buffer),
      }),
    ).buffer,
  );
  signal.throwIfAborted();
  const cacheAllowed = analysisCacheAllowed(signal);
  let cached: unknown = cacheAllowed ? memory.get(key) : undefined;
  if (cacheAllowed && !cached) {
    try {
      const storage = await db();
      try {
        cached = await storage.get('results', key);
      } finally {
        storage.close();
      }
    } catch {
      /* In-memory retry is still available. */
    }
  }
  if (cached) {
    try {
      const record = cached as CachedGeometry;
      if (
        !record.analysis ||
        record.checksum !==
          (await digest(new TextEncoder().encode(JSON.stringify({ key, analysis: record.analysis })).buffer))
      )
        throw new Error('형상 캐시의 무결성 검증에 실패했어요.');
      const valid = validateBrowserGeometryAnalysis(record.analysis, input.metadata.inputFingerprint);
      signal.throwIfAborted();
      options.onProgress?.({
        stage: 'cache',
        message: '완료된 같은 사진의 브라우저 형상 분석을 재사용하고 있어요.',
      });
      valid.measurement = {
        ...valid.measurement,
        cacheHit: true,
        requestMs: 0,
        modelLoadMs: 0,
        inferenceMs: 0,
        planeExtractionMs: 0,
        downloadMs: 0,
        cacheMs: 0,
        preprocessingMs: 0,
        postprocessingMs: 0,
      };
      return valid;
    } catch (error) {
      if (signal.aborted) throw error; /* Corrupted/incompatible cache is never treated as a result. */
    }
  }
  const client = new MogeBrowserClient();
  try {
    const result = await client.run(photo, {
      mode: options.mode,
      geometry: input,
      signal,
      onProgress: options.onProgress,
    });
    signal.throwIfAborted();
    const analysis = geometryAnalysisFromBrowser(result, input);
    options.onResult?.(result);
    if (!cacheAllowed) return analysis;
    const record = {
      analysis: structuredClone(analysis),
      checksum: await digest(new TextEncoder().encode(JSON.stringify({ key, analysis })).buffer),
    };
    memory.set(key, record);
    while (memory.size > 16) memory.delete(memory.keys().next().value!);
    try {
      const storage = await db();
      try {
        const tx = storage.transaction('results', 'readwrite');
        await tx.store.put(record, key);
        let excess = (await tx.store.count()) - 16;
        for (let cursor = await tx.store.openCursor(); cursor && excess > 0; cursor = await cursor.continue())
          if (cursor.key !== key) {
            await cursor.delete();
            excess--;
          }
        await tx.done;
      } finally {
        storage.close();
      }
    } catch {
      analysis.measurement.cacheWarning =
        '형상 결과를 저장하지 못했어요. 이 탭에서는 완료 단계를 재사용할 수 있어요.';
    }
    signal.throwIfAborted();
    return analysis;
  } finally {
    client.dispose();
  }
}
