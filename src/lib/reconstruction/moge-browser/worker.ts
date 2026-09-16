import type * as Ort from 'onnxruntime-web';
import {
  MOGE_ARTIFACT,
  MOGE_NUM_TOKENS,
  MOGE_PREPROCESS_VERSION,
  MOGE_RUNTIME_URL,
  MOGE_RUNTIME_VERSION,
  mogeInputSize,
} from './artifact';
import { loadMogeModel, MogeDownloadError, MogeIntegrityError } from './model-cache';
import { postprocessMoge } from './postprocess';
import { extractMogePlanes } from './planes';
import type {
  MogeBackend,
  MogeBrowserResult,
  MogeModelBytes,
  MogeProgress,
  MogeRawPrediction,
  MogeReply,
  MogeRequest,
  MogeTimings,
} from './protocol';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MogeRequest>) => void) | null;
  postMessage: (reply: MogeReply, transfer?: Transferable[]) => void;
};
let running = false;
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error));
const runtimeNetworkFailure = (error: unknown) =>
  /fetch|network|dynamically imported|importing a module|loading chunk|module script|ERR_(?:CONNECTION|INTERNET|NAME_NOT|BLOCKED)/i.test(
    detail(error),
  );

/** Presence of navigator.gpu is only an attempt decision. Success is reported after actual session.run(). */
async function selectBackend(
  mode: MogeRequest['mode'],
): Promise<{ backend: MogeBackend; fallbackReason?: string }> {
  if (mode === 'wasm') return { backend: 'wasm' };
  const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown | null> } }).gpu;
  let available = false;
  try {
    available = !!gpu && !!(await gpu.requestAdapter());
  } catch {
    /* The auto mode can use CPU. */
  }
  if (available) return { backend: 'webgpu' };
  if (mode === 'webgpu')
    throw new Error('이 브라우저에서는 WebGPU 장치를 사용할 수 없어요. 자동 또는 CPU 모드를 선택해 주세요.');
  return { backend: 'wasm', fallbackReason: '사용 가능한 WebGPU 장치가 없어 CPU(WebAssembly)로 분석했어요.' };
}

async function prepareImage(blob: Blob) {
  if (!blob.size || blob.size > 25 * 1024 * 1024) throw new Error('분석 사진은 25MB 이하여야 해요.');
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined')
    throw new Error(
      '이 브라우저는 작업자 이미지 처리를 지원하지 않아요. 최신 Chrome 또는 Edge를 사용해 주세요.',
    );
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const { width, height } = mogeInputSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('형상 분석 이미지를 준비하지 못했어요.');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const area = width * height;
    const pixels = new Float32Array(area * 3);
    // The graph does its own resize and ImageNet mean/std normalization. Only RGB / 255 here.
    for (let i = 0; i < area; i++) {
      pixels[i] = rgba[i * 4] / 255;
      pixels[area + i] = rgba[i * 4 + 1] / 255;
      pixels[2 * area + i] = rgba[i * 4 + 2] / 255;
    }
    canvas.width = canvas.height = 1;
    return { pixels, width, height, sourceWidth: bitmap.width, sourceHeight: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function validateSession(session: Ort.InferenceSession) {
  const image = session.inputMetadata.find((x) => x.name === 'image');
  const tokens = session.inputMetadata.find((x) => x.name === 'num_tokens');
  if (
    !image?.isTensor ||
    image.type !== 'float32' ||
    image.shape.length !== 4 ||
    image.shape[1] !== 3 ||
    !tokens?.isTensor ||
    tokens.type !== 'int64' ||
    tokens.shape.length !== 0
  )
    throw new Error('MoGe 모델의 입력 계약이 고정된 FP32 그래프와 달라요.');
  if (!['points', 'normal', 'mask', 'scale'].every((name) => session.outputNames.includes(name)))
    throw new Error('MoGe 모델의 출력 계약이 지원하는 그래프와 달라요.');
}

async function infer(
  runtime: typeof Ort,
  session: Ort.InferenceSession,
  image: Awaited<ReturnType<typeof prepareImage>>,
): Promise<MogeRawPrediction> {
  const input = new runtime.Tensor('float32', image.pixels, [1, 3, image.height, image.width]);
  const tokens = new runtime.Tensor('int64', BigInt64Array.of(BigInt(MOGE_NUM_TOKENS)), []);
  let outputs: Ort.InferenceSession.ReturnType | undefined;
  try {
    outputs = await session.run({ image: input, num_tokens: tokens });
    const read = (name: string, dims: number[]) => {
      const tensor = outputs![name];
      if (
        !tensor ||
        tensor.type !== 'float32' ||
        tensor.dims.length !== dims.length ||
        tensor.dims.some((x, i) => x !== dims[i]) ||
        !(tensor.data instanceof Float32Array)
      )
        throw new Error(`MoGe ${name} 출력 형태가 올바르지 않아요.`);
      return tensor.data.slice();
    };
    const shape = [1, image.height, image.width, 3];
    const metricScale = read('scale', [1])[0];
    if (!Number.isFinite(metricScale) || metricScale <= 0)
      throw new Error('MoGe 거리 스케일이 올바르지 않아요.');
    return {
      width: image.width,
      height: image.height,
      points: read('points', shape),
      normal: read('normal', shape),
      mask: read('mask', shape.slice(0, 3)),
      metricScale,
    };
  } finally {
    input.dispose();
    tokens.dispose();
    if (outputs) for (const value of Object.values(outputs)) value.dispose();
  }
}

function transferableBuffers(value: unknown, result = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) result.add(value.buffer);
  else if (value && typeof value === 'object')
    for (const child of Object.values(value)) transferableBuffers(child, result);
  return [...result];
}

scope.onmessage = async ({ data: request }) => {
  if (request.type !== 'run' || running) return;
  running = true;
  const progress = (p: MogeProgress) => scope.postMessage({ type: 'progress', id: request.id, progress: p });
  const started = performance.now();
  const timings: MogeTimings = request.carryTimings
    ? { ...request.carryTimings }
    : {
        downloadMs: 0,
        cacheMs: 0,
        initializationMs: 0,
        preprocessingMs: 0,
        inferenceMs: 0,
        postprocessingMs: 0,
        planeExtractionMs: 0,
        totalMs: 0,
      };
  const previousTotalMs = timings.totalMs;
  let model: MogeModelBytes | undefined;
  let session: Ort.InferenceSession | undefined;
  let backend: MogeBackend | undefined;
  let stage: 'input' | 'download' | 'runtime' | 'gpu' | 'geometry' = 'input';
  try {
    progress({ stage: 'checking', message: '브라우저 형상 분석을 준비하는 중' });
    const preparationStart = performance.now();
    const image = await prepareImage(request.blob);
    if (
      request.geometry &&
      (request.geometry.metadata.image.width !== image.sourceWidth ||
        request.geometry.metadata.image.height !== image.sourceHeight)
    )
      throw new Error('사진과 분할 마스크의 회전 방향 또는 크기가 일치하지 않아요.');
    timings.preprocessingMs += performance.now() - preparationStart;
    const capability = await selectBackend(request.mode);
    backend = capability.backend;
    stage = 'download';
    model = request.model ?? (await loadMogeModel(request.modelUrl, progress));
    if (!request.model) {
      timings.downloadMs += model.downloadMs;
      timings.cacheMs += model.cacheMs;
    }
    stage = 'runtime';
    progress({ stage: 'loading-runtime', message: 'MoGe 브라우저 실행 엔진을 불러오는 중' });
    const runtimeStart = performance.now();
    const runtime = await import('onnxruntime-web/webgpu');
    runtime.env.wasm.wasmPaths = MOGE_RUNTIME_URL;
    const isolated = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
    const threads = isolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
    runtime.env.wasm.numThreads = threads;
    runtime.env.wasm.proxy = false;
    timings.initializationMs += performance.now() - runtimeStart;
    stage = 'gpu';
    progress({
      stage: 'initializing',
      message: `${backend === 'webgpu' ? 'WebGPU' : 'CPU(WebAssembly)'}로 MoGe 모델을 준비하는 중`,
    });
    const initStart = performance.now();
    try {
      session = await runtime.InferenceSession.create(model.bytes, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
      });
      validateSession(session);
    } finally {
      timings.initializationMs += performance.now() - initStart;
    }
    progress({
      stage: 'inference',
      message: `${backend === 'webgpu' ? 'WebGPU' : 'CPU(WebAssembly)'}로 ${image.width}×${image.height} 형상을 계산하는 중`,
    });
    const inferStart = performance.now();
    let raw: MogeRawPrediction;
    try {
      raw = await infer(runtime, session, image);
    } finally {
      timings.inferenceMs += performance.now() - inferStart;
    }
    // No inference session remains alive while the plane fitter or a subsequent DeepLab model runs.
    await session.release();
    session = undefined;
    stage = 'geometry';
    progress({ stage: 'postprocessing', message: '깊이·카메라·미터 단위 모델 추정값을 복원하는 중' });
    const postStart = performance.now();
    const dense = postprocessMoge(raw);
    timings.postprocessingMs += performance.now() - postStart;
    const planeStart = performance.now();
    let planes: MogeBrowserResult['planes'];
    if (request.geometry) {
      progress({ stage: 'planes', message: '분할 결과와 깊이를 결합해 바닥과 벽을 찾는 중' });
      const { metadata, floor, wall } = request.geometry;
      planes = extractMogePlanes(dense, {
        width: metadata.mask.width,
        height: metadata.mask.height,
        floor,
        wall,
        regions: metadata.regions,
      });
    }
    timings.planeExtractionMs += performance.now() - planeStart;
    timings.totalMs = previousTotalMs + performance.now() - started;
    const result: MogeBrowserResult = {
      raw,
      dense,
      planes,
      backend,
      requestedMode: request.mode,
      fallbackReason: request.fallbackReason ?? capability.fallbackReason,
      cacheSource: model.cacheSource,
      cacheNotice: model.cacheNotice,
      timings,
      metadata: {
        artifact: MOGE_ARTIFACT,
        runtimeVersion: MOGE_RUNTIME_VERSION,
        preprocessVersion: MOGE_PREPROCESS_VERSION,
        sourceWidth: image.sourceWidth,
        sourceHeight: image.sourceHeight,
        inputWidth: image.width,
        inputHeight: image.height,
        numTokens: MOGE_NUM_TOKENS,
        precision: 'fp32',
        wasmThreads: threads,
        crossOriginIsolated: isolated,
        memoryBytes: null,
      },
    };
    scope.postMessage({ type: 'result', id: request.id, result }, transferableBuffers(result));
  } catch (error) {
    // Best effort: a poisoned GPU runtime must not delay termination and the new CPU worker.
    if (session) {
      try {
        void session.release().catch(() => undefined);
      } catch {
        /* Worker termination releases it. */
      }
    }
    timings.totalMs = previousTotalMs + performance.now() - started;
    if (
      stage === 'gpu' &&
      backend === 'webgpu' &&
      request.mode === 'auto' &&
      model &&
      !runtimeNetworkFailure(error)
    ) {
      scope.postMessage(
        {
          type: 'retry-cpu',
          id: request.id,
          message: `WebGPU 실행에 실패해 CPU로 다시 분석해요. ${detail(error).slice(0, 250)}`,
          model,
          timings,
        },
        [model.bytes.buffer],
      );
    } else {
      scope.postMessage({
        type: 'error',
        id: request.id,
        code:
          error instanceof MogeDownloadError
            ? 'download'
            : error instanceof MogeIntegrityError
              ? 'integrity'
              : stage === 'input'
                ? 'input'
                : stage === 'geometry'
                  ? 'geometry'
                  : 'runtime',
        message: detail(error).slice(0, 600),
      });
    }
  } finally {
    running = false;
  }
};
