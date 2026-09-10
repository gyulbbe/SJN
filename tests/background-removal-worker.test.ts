import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundRemovalReply, BackgroundRemovalRequest } from '../src/lib/background-removal/types';

const mocks = vi.hoisted(() => ({
  cached: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../src/lib/background-removal/model-cache', () => ({
  getCachedBackgroundModels: mocks.cached,
  loadBackgroundModel: mocks.load,
  removeBackgroundGpuModel: mocks.remove,
}));
vi.mock('onnxruntime-web/webgpu', () => ({
  env: { wasm: {} },
  InferenceSession: { create: mocks.create },
  Tensor: class {
    dispose() {}
  },
}));

type Backend = 'webgpu' | 'wasm';
const events: string[] = [];
let replies: BackgroundRemovalReply[] = [];
let failGpuInit = false;
let failGpuRun = false;
let failCpuRun = false;
let failPng = false;
const gpuAdapter = vi.fn();
const releases = { webgpu: vi.fn(), wasm: vi.fn() };

class TestCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      drawImage() {},
      getImageData(_x: number, _y: number, width: number, height: number) {
        return { data: new Uint8ClampedArray(width * height * 4).fill(255) };
      },
      putImageData() {},
    };
  }
  async convertToBlob() {
    events.push('png');
    if (failPng) throw new Error('PNG encoding failed');
    return new Blob(['test PNG'], { type: 'image/png' });
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  releases.webgpu.mockResolvedValue(undefined);
  releases.wasm.mockResolvedValue(undefined);
  replies = [];
  events.length = 0;
  failGpuInit = failGpuRun = failCpuRun = failPng = false;
  mocks.cached.mockResolvedValue({ fp16: false, fp32: false });
  mocks.load.mockImplementation(async (precision: string) => {
    events.push(`load:${precision}`);
    return { bytes: new Uint8Array([1]), downloadMs: 0, cacheReadMs: 0, cacheSource: 'cache' };
  });
  mocks.remove.mockImplementation(async () => {
    events.push('delete:fp16');
    return true;
  });
  mocks.create.mockImplementation(async (_bytes: Uint8Array, options: { executionProviders: Backend[] }) => {
    const backend = options.executionProviders[0];
    events.push(`create:${backend}`);
    if (backend === 'webgpu' && failGpuInit) throw new Error('GPU session failed');
    return {
      inputMetadata: [{ name: 'input_image', isTensor: true, type: 'float32', shape: [1, 3, 512, 512] }],
      outputNames: ['logits'],
      release: releases[backend],
      run: async () => {
        events.push(`infer:${backend}`);
        if ((backend === 'webgpu' && failGpuRun) || (backend === 'wasm' && failCpuRun))
          throw new Error(`${backend} inference failed`);
        return {
          logits: {
            type: 'float32',
            dims: [1, 1, 512, 512],
            size: 512 * 512,
            data: new Float32Array(512 * 512),
            dispose() {},
          },
        };
      },
    };
  });
  gpuAdapter.mockResolvedValue({
    features: { has: () => true },
    limits: { maxStorageBuffersPerShaderStage: 8 },
  });
  vi.stubGlobal('navigator', { gpu: { requestAdapter: gpuAdapter } });
  vi.stubGlobal('OffscreenCanvas', TestCanvas);
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 2, height: 2, close() {} }));
  vi.stubGlobal('postMessage', (reply: BackgroundRemovalReply) => replies.push(reply));
  vi.stubGlobal('onmessage', undefined);
});
afterEach(() => vi.unstubAllGlobals());

async function runWorker(options: { forceCpu?: boolean; fallbackReason?: string } = {}) {
  await import('../src/lib/background-removal/worker');
  const scope = globalThis as unknown as {
    onmessage: (event: { data: BackgroundRemovalRequest }) => Promise<void>;
  };
  await scope.onmessage({ data: { type: 'run', id: 1, blob: new Blob(['photo']), ...options } });
  return replies.findLast(
    (reply) => reply.type === 'result' || reply.type === 'error' || reply.type === 'retry-cpu',
  );
}

// These are deterministic control-flow tests with a mocked runtime, not quality or speed benchmarks.
describe('background-removal cached backend and success-only cleanup', () => {
  it.each([false, true])(
    'uses cached FP32 directly even on a working GPU (FP16 cached: %s)',
    async (fp16) => {
      mocks.cached.mockResolvedValue({ fp16, fp32: true });
      const result = await runWorker();
      expect(result).toMatchObject({ type: 'result', result: { backend: 'wasm', precision: 'fp32' } });
      expect(gpuAdapter).not.toHaveBeenCalled();
      expect(mocks.load.mock.calls.map(([precision]) => precision)).toEqual(['fp32']);
      expect(events.indexOf('delete:fp16')).toBeGreaterThan(events.indexOf('png'));
    },
  );
  it('keeps and uses the existing FP16 model with a compatible GPU', async () => {
    mocks.cached.mockResolvedValue({ fp16: true, fp32: false });
    expect(await runWorker()).toMatchObject({
      type: 'result',
      result: { backend: 'webgpu', precision: 'fp16' },
    });
    expect(mocks.load.mock.calls.map(([precision]) => precision)).toEqual(['fp16']);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('uses CPU when no GPU adapter is available, without trying FP16', async () => {
    gpuAdapter.mockResolvedValue(null);
    expect(await runWorker()).toMatchObject({ type: 'result', result: { backend: 'wasm' } });
    expect(mocks.load.mock.calls.map(([precision]) => precision)).toEqual(['fp32']);
  });
  it('hands GPU initialization failure to a fresh CPU worker, then cleans only after PNG success', async () => {
    failGpuInit = true;
    expect(await runWorker()).toMatchObject({ type: 'retry-cpu' });
    expect(events).toEqual(['load:fp16', 'create:webgpu']);
    expect(mocks.remove).not.toHaveBeenCalled();
    // A new module instance emulates the replacement Worker; its runtime is not the failed one.
    vi.resetModules();
    expect(await runWorker({ forceCpu: true, fallbackReason: 'GPU failed' })).toMatchObject({
      type: 'result',
      result: { backend: 'wasm', fallbackReason: 'GPU failed' },
    });
    expect(events).toEqual([
      'load:fp16',
      'create:webgpu',
      'load:fp32',
      'create:wasm',
      'infer:wasm',
      'png',
      'delete:fp16',
    ]);
  });
  it('releases a failed GPU session and requests a fresh CPU worker without deleting FP16 early', async () => {
    failGpuRun = true;
    expect(await runWorker()).toMatchObject({ type: 'retry-cpu' });
    expect(releases.webgpu).toHaveBeenCalledOnce();
    expect(events).toEqual(['load:fp16', 'create:webgpu', 'infer:webgpu']);
    expect(mocks.remove).not.toHaveBeenCalled();
    vi.resetModules();
    expect(await runWorker({ forceCpu: true })).toMatchObject({
      type: 'result',
      result: { backend: 'wasm' },
    });
    expect(events.at(-1)).toBe('delete:fp16');
  });
  it('does not discard the GPU cache when the replacement CPU worker fails', async () => {
    failGpuRun = failCpuRun = true;
    expect(await runWorker()).toMatchObject({ type: 'retry-cpu' });
    vi.resetModules();
    expect(await runWorker({ forceCpu: true })).toMatchObject({ type: 'error' });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(events).not.toContain('png');
  });
  it('does not discard the GPU cache when PNG encoding fails after CPU inference', async () => {
    mocks.cached.mockResolvedValue({ fp16: true, fp32: true });
    failPng = true;
    expect(await runWorker()).toMatchObject({ type: 'error', message: 'PNG encoding failed' });
    expect(events).toContain('infer:wasm');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('does not treat a model network failure as a reason to download a second model', async () => {
    mocks.load.mockRejectedValue(new Error('model download failed'));
    expect(await runWorker()).toMatchObject({ type: 'error', message: 'model download failed' });
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each([
    'no available backend found. ERR: [webgpu] TypeError: Failed to fetch',
    'Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/runtime.mjs',
    'both async and sync fetching of the wasm failed',
  ])('does not download FP32 for a runtime CDN error during GPU initialization: %s', async (message) => {
    mocks.create.mockRejectedValue(new Error(message));
    expect(await runWorker()).toMatchObject({ type: 'error' });
    expect(mocks.load.mock.calls.map(([precision]) => precision)).toEqual(['fp16']);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('still delivers the successful PNG if cache deletion is unavailable', async () => {
    mocks.cached.mockResolvedValue({ fp16: true, fp32: true });
    mocks.remove.mockResolvedValue(false);
    expect(await runWorker()).toMatchObject({
      type: 'result',
      result: { backend: 'wasm', cacheNotice: undefined },
    });
  });
});
