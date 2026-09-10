import type * as Ort from 'onnxruntime-web';
import { BACKGROUND_MODEL_SIZE, BACKGROUND_RUNTIME_URL } from './model';
import { getCachedBackgroundModels, loadBackgroundModel, removeBackgroundGpuModel } from './model-cache';
import { applyMaskToOriginalAlpha, float32ToHalf, normalizeRgbNchw, sigmoidMask } from './pixels';
import type {
  BackgroundRemovalAttemptTimings,
  BackgroundRemovalProgress,
  BackgroundRemovalReply,
  BackgroundRemovalRequest,
  BackgroundRemovalResult,
} from './types';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BackgroundRemovalRequest>) => void) | null;
  postMessage: (reply: BackgroundRemovalReply) => void;
};
type Backend = 'webgpu' | 'wasm';
type Precision = 'fp16' | 'fp32';
type Ready = {
  session: Ort.InferenceSession;
  backend: Backend;
  precision: Precision;
  fallbackReason?: string;
};
type Timings = BackgroundRemovalAttemptTimings;
let runtime: typeof Ort | undefined;
let ready: Ready | undefined;
let running = false;

// Only GPU session/compute errors qualify for a CPU retry, not network failures.
class GpuInitializationError extends Error {}
class CpuRetryNeeded extends Error {
  constructor(
    message: string,
    readonly timings: Timings,
  ) {
    super(message);
  }
}

function isRuntimeDownloadError(error: unknown) {
  const detail = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /fetch|network|dynamically imported module|importing a module script|loading chunk|ERR_(?:CONNECTION|INTERNET|NAME_NOT|BLOCKED)/i.test(
    detail,
  );
}

function reason(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/memory|alloc|out of bounds|oom/i.test(detail))
    return '기기 메모리가 부족하거나 AI 모델의 메모리 한도를 초과했어요. 다른 탭을 닫거나 메모리가 더 큰 기기에서 다시 시도해 주세요.';
  if (/simd|webassembly.*support/i.test(detail))
    return '이 브라우저는 필요한 WebAssembly SIMD 기능을 지원하지 않아요. 최신 Chrome 또는 Edge에서 실행해 주세요.';
  if (/fetch|import|wasm.*load|module script/i.test(detail))
    return 'AI 실행 파일을 다운로드하지 못했어요. 인터넷 연결과 cdn.jsdelivr.net 접속 차단 여부를 확인해 주세요.';
  return detail.slice(0, 350) || '알 수 없는 AI 실행 오류가 발생했어요.';
}

async function chooseBackend(): Promise<{ backend: Backend; precision: Precision; fallbackReason?: string }> {
  const cached = await getCachedBackgroundModels();
  // A cached CPU model also wins when both variants remain from an earlier failed attempt.
  // Do not download FP16 again just because this browser now exposes a GPU.
  if (cached.fp32)
    return {
      backend: 'wasm',
      precision: 'fp32',
      fallbackReason: '저장된 CPU 모델을 우선 사용했어요.',
    };
  const gpu = (
    navigator as unknown as {
      gpu?: {
        requestAdapter: () => Promise<{
          features: { has: (name: string) => boolean };
          limits: { maxStorageBuffersPerShaderStage: number };
        } | null>;
      };
    }
  ).gpu;
  if (!gpu)
    return {
      backend: 'wasm',
      precision: 'fp32',
      fallbackReason: '이 환경에서 WebGPU를 사용할 수 없어 CPU(WebAssembly)로 처리했어요.',
    };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter)
      return {
        backend: 'wasm',
        precision: 'fp32',
        fallbackReason: '사용할 수 있는 WebGPU 장치가 없어 CPU(WebAssembly)로 처리했어요.',
      };
    if (adapter.limits.maxStorageBuffersPerShaderStage < 8)
      return {
        backend: 'wasm',
        precision: 'fp32',
        fallbackReason: 'WebGPU 장치의 연산 한도가 부족해 CPU(WebAssembly)로 처리했어요.',
      };
    return { backend: 'webgpu', precision: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
  } catch {
    return {
      backend: 'wasm',
      precision: 'fp32',
      fallbackReason: 'WebGPU 장치를 열 수 없어 CPU(WebAssembly)로 처리했어요.',
    };
  }
}

async function initialize(
  backend: Backend,
  precision: Precision,
  timings: Timings,
  progress: (p: BackgroundRemovalProgress) => void,
): Promise<Ready> {
  if (!runtime) {
    progress({ stage: 'loading-runtime', message: '브라우저 AI 실행 엔진을 불러오는 중' });
    const start = performance.now();
    runtime = await import('onnxruntime-web/webgpu');
    runtime.env.wasm.wasmPaths = BACKGROUND_RUNTIME_URL;
    // In our own worker; one WASM thread works without cross-origin isolation or SharedArrayBuffer.
    runtime.env.wasm.numThreads = 1;
    runtime.env.wasm.proxy = false;
    timings.initializationMs += performance.now() - start;
  }
  const model = await loadBackgroundModel(precision, progress);
  timings.downloadMs += model.downloadMs;
  timings.initializationMs += model.cacheReadMs;
  timings.cacheSource = model.cacheSource;
  progress({
    stage: 'initializing',
    message: `${backend === 'webgpu' ? 'WebGPU' : 'CPU(WebAssembly)'} 모델 준비 중 · 처음에는 시간이 걸릴 수 있어요`,
  });
  const started = performance.now();
  try {
    const session = await runtime.InferenceSession.create(model.bytes, {
      executionProviders: [backend],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    });
    const input = session.inputMetadata.find((item) => item.name === 'input_image');
    if (
      !input?.isTensor ||
      !['float32', 'float16'].includes(input.type) ||
      input.shape.length !== 4 ||
      input.shape[1] !== 3 ||
      input.shape[2] !== BACKGROUND_MODEL_SIZE ||
      input.shape[3] !== BACKGROUND_MODEL_SIZE
    ) {
      await session.release();
      throw new Error('다운로드한 모델의 입력 형식이 지원하는 512×512 모델과 달라요.');
    }
    return { session, backend, precision };
  } catch (error) {
    // Session creation also loads CDN WASM/modules; a network failure is not a GPU failure.
    if (backend === 'webgpu' && !isRuntimeDownloadError(error))
      throw new GpuInitializationError(reason(error));
    throw error;
  } finally {
    timings.initializationMs += performance.now() - started;
  }
}

async function infer(normalized: Float32Array, active: Ready, timings: Timings) {
  const ort = runtime!;
  const inputMeta = active.session.inputMetadata.find((item) => item.name === 'input_image');
  const half = inputMeta?.isTensor && inputMeta.type === 'float16';
  const input = half
    ? new ort.Tensor('float16', float32ToHalf(normalized), [
        1,
        3,
        BACKGROUND_MODEL_SIZE,
        BACKGROUND_MODEL_SIZE,
      ])
    : new ort.Tensor('float32', normalized, [1, 3, BACKGROUND_MODEL_SIZE, BACKGROUND_MODEL_SIZE]);
  let outputs: Ort.InferenceSession.ReturnType | undefined;
  const start = performance.now();
  try {
    outputs = await active.session.run({ input_image: input });
    const output = outputs.logits ?? outputs[active.session.outputNames[0]];
    if (
      !output ||
      !['float16', 'float32'].includes(output.type) ||
      output.dims.slice(-2).some((size) => size !== BACKGROUND_MODEL_SIZE) ||
      output.size !== BACKGROUND_MODEL_SIZE ** 2
    )
      throw new Error('AI 모델의 출력 마스크 형식이 올바르지 않아요.');
    const data = output.data;
    if (!ArrayBuffer.isView(data)) throw new Error('AI 마스크를 CPU 메모리에서 읽지 못했어요.');
    // New browsers expose Float16Array; reinterpret its bits for consistent FP16 decoding.
    return output.type === 'float16'
      ? sigmoidMask(new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2), 'float16')
      : sigmoidMask(new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4), 'float32');
  } finally {
    timings.inferenceMs += performance.now() - start;
    input.dispose();
    if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
  }
}

async function run(
  blob: Blob,
  progress: (p: BackgroundRemovalProgress) => void,
  forceCpu = false,
  fallbackReason?: string,
): Promise<BackgroundRemovalResult> {
  progress({ stage: 'checking', message: '브라우저 지원과 제품 사진을 확인하는 중' });
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function')
    throw new Error(
      '이 브라우저는 워커의 이미지 처리를 지원하지 않아요. 최신 Chrome 또는 Edge에서 실행해 주세요.',
    );
  if (typeof WebAssembly === 'undefined') throw new Error('이 브라우저에서 WebAssembly를 사용할 수 없어요.');
  if (!blob.size || blob.size > 25 * 1024 * 1024) throw new Error('제품 사진은 25MB 이하여야 해요.');
  const timings: Timings = {
    downloadMs: 0,
    initializationMs: 0,
    inferenceMs: 0,
    processingMs: 0,
    cacheSource: 'memory',
  };
  const decodeStart = performance.now();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('제품 사진을 읽지 못했어요. JPG, PNG 또는 WebP 사진을 다시 선택해 주세요.');
  }
  timings.processingMs += performance.now() - decodeStart;
  try {
    const { width, height } = bitmap;
    if (width < 1 || height < 1 || width * height > 40_000_000)
      throw new Error('제품 사진은 4천만 화소(40MP) 이하여야 해요.');
    if (!ready) {
      const checkingStart = performance.now();
      const capability = forceCpu
        ? { backend: 'wasm' as const, precision: 'fp32' as const, fallbackReason }
        : await chooseBackend();
      timings.initializationMs += performance.now() - checkingStart;
      try {
        ready = {
          ...(await initialize(capability.backend, capability.precision, timings, progress)),
          fallbackReason: capability.fallbackReason,
        };
      } catch (error) {
        if (!(error instanceof GpuInitializationError)) throw error;
        throw new CpuRetryNeeded(
          `WebGPU 준비에 실패해 새 CPU 작업으로 전환했어요. ${reason(error)}`,
          timings,
        );
      }
    }
    progress({
      stage: 'processing',
      message: `${ready.backend === 'webgpu' ? 'WebGPU' : 'CPU(WebAssembly)'}로 512×512 AI 분석 중`,
    });
    const preparationStart = performance.now();
    const analysis = new OffscreenCanvas(BACKGROUND_MODEL_SIZE, BACKGROUND_MODEL_SIZE);
    const analysisContext = analysis.getContext('2d', { willReadFrequently: true });
    if (!analysisContext) throw new Error('분석 이미지를 준비할 캔버스를 만들지 못했어요.');
    analysisContext.imageSmoothingEnabled = true;
    analysisContext.imageSmoothingQuality = 'high';
    analysisContext.drawImage(bitmap, 0, 0, BACKGROUND_MODEL_SIZE, BACKGROUND_MODEL_SIZE);
    const normalized = normalizeRgbNchw(
      analysisContext.getImageData(0, 0, BACKGROUND_MODEL_SIZE, BACKGROUND_MODEL_SIZE).data,
      BACKGROUND_MODEL_SIZE,
      BACKGROUND_MODEL_SIZE,
    );
    analysis.width = 1;
    analysis.height = 1;
    timings.processingMs += performance.now() - preparationStart;
    let mask: Float32Array;
    const inferenceStart = performance.now();
    try {
      mask = await infer(normalized, ready, timings);
      timings.processingMs += performance.now() - inferenceStart;
    } catch (error) {
      timings.processingMs += performance.now() - inferenceStart;
      if (ready.backend !== 'webgpu' || isRuntimeDownloadError(error)) throw error;
      throw new CpuRetryNeeded(
        `WebGPU 이미지 처리에 실패해 새 CPU 작업으로 전환했어요. ${reason(error)}`,
        timings,
      );
    }
    progress({ stage: 'encoding', message: `원본 크기 ${width}×${height}의 투명 PNG를 만드는 중` });
    const encodingStart = performance.now();
    const output = new OffscreenCanvas(width, height);
    const ctx = output.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('결과 이미지를 저장할 캔버스를 만들지 못했어요.');
    ctx.drawImage(bitmap, 0, 0);
    const original = ctx.getImageData(0, 0, width, height);
    applyMaskToOriginalAlpha(
      original.data,
      width,
      height,
      mask,
      BACKGROUND_MODEL_SIZE,
      BACKGROUND_MODEL_SIZE,
    );
    ctx.putImageData(original, 0, 0);
    const png = await output.convertToBlob({ type: 'image/png' });
    output.width = 1;
    output.height = 1;
    timings.processingMs += performance.now() - encodingStart;
    let cacheNotice: string | undefined;
    if (ready.backend === 'wasm') {
      // Keep the GPU model if CPU inference or PNG encoding fails. Never delete FP32:
      // it is shared by CPU and FP32-capable GPU execution.
      const cleanupStart = performance.now();
      if (await removeBackgroundGpuModel()) cacheNotice = 'CPU 처리가 완료되어 GPU 모델 캐시를 삭제했어요.';
      timings.initializationMs += performance.now() - cleanupStart;
    }
    return {
      blob: png,
      width,
      height,
      analysisWidth: BACKGROUND_MODEL_SIZE,
      analysisHeight: BACKGROUND_MODEL_SIZE,
      backend: ready.backend,
      precision: ready.precision,
      fallbackReason: ready.fallbackReason,
      cacheNotice,
      ...timings,
    };
  } finally {
    bitmap.close();
  }
}

scope.onmessage = async (event) => {
  const request = event.data;
  if (request.type !== 'run') return;
  if (running) {
    scope.postMessage({ type: 'error', id: request.id, message: '이미 배경 제거가 진행 중이에요.' });
    return;
  }
  running = true;
  try {
    const result = await run(
      request.blob,
      (progress) => scope.postMessage({ type: 'progress', id: request.id, progress }),
      request.forceCpu,
      request.fallbackReason,
    );
    scope.postMessage({ type: 'result', id: request.id, result });
  } catch (error) {
    if (ready) {
      // The client terminates this failed worker. Do not await a poisoned runtime here.
      try {
        void ready.session.release().catch(() => undefined);
      } catch {
        /* Best-effort release. */
      }
    }
    ready = undefined;
    if (error instanceof CpuRetryNeeded)
      scope.postMessage({
        type: 'retry-cpu',
        id: request.id,
        message: error.message,
        timings: error.timings,
      });
    else scope.postMessage({ type: 'error', id: request.id, message: reason(error) });
  } finally {
    running = false;
  }
};
