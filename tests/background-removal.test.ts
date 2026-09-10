import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundRemovalClient } from '../src/lib/background-removal/client';
import {
  BACKGROUND_MODEL_FILES,
  BACKGROUND_MODEL_REVISION,
  backgroundModelUrl,
} from '../src/lib/background-removal/model';
import { readModelResponse } from '../src/lib/background-removal/model-cache';
import {
  applyMaskToOriginalAlpha,
  float32ToHalf,
  halfToNumber,
  normalizeRgbNchw,
  sigmoidMask,
} from '../src/lib/background-removal/pixels';
import type {
  BackgroundRemovalReply,
  BackgroundRemovalRequest,
  BackgroundRemovalResult,
} from '../src/lib/background-removal/types';

describe('AI matte preprocessing and original-resolution alpha composition', () => {
  it('uses ImageNet RGB normalization and NCHW order', () => {
    const out = normalizeRgbNchw(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1);
    expect(out).toHaveLength(6);
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229);
    expect(out[1]).toBeCloseTo(-0.485 / 0.229);
    expect(out[2]).toBeCloseTo(-0.456 / 0.224);
    expect(out[3]).toBeCloseTo((1 - 0.456) / 0.224);
    expect(out[4]).toBeCloseTo(-0.406 / 0.225);
  });
  it('composites transparent analysis pixels over white without changing original pixels', () => {
    const original = new Uint8ClampedArray([2, 3, 4, 0]);
    const out = normalizeRgbNchw(original, 1, 1);
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229);
    expect([...original]).toEqual([2, 3, 4, 0]);
  });
  it('converts logits with sigmoid instead of thresholding or removing white RGB', () => {
    const mask = sigmoidMask(new Float32Array([-100, 0, 100]), 'float32');
    expect(mask[0]).toBeCloseTo(0);
    expect(mask[1]).toBe(0.5);
    expect(mask[2]).toBe(1);
    const whiteAndBlack = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    applyMaskToOriginalAlpha(whiteAndBlack, 2, 1, new Float32Array([1, 0]), 2, 1);
    expect([...whiteAndBlack]).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
  });
  it('upsamples with half-pixel bilinear coordinates at the original non-square resolution', () => {
    const original = new Uint8ClampedArray(4 * 2 * 4).fill(255);
    applyMaskToOriginalAlpha(original, 4, 2, new Float32Array([0, 1]), 2, 1);
    expect([...original].filter((_, i) => i % 4 === 3)).toEqual([0, 64, 191, 255, 0, 64, 191, 255]);
  });
  it('multiplies original alpha, including existing translucent edges and holes', () => {
    const original = new Uint8ClampedArray([123, 45, 67, 0, 123, 45, 67, 128, 123, 45, 67, 255]);
    applyMaskToOriginalAlpha(original, 3, 1, new Float32Array([0.5]), 1, 1);
    expect([...original]).toEqual([123, 45, 67, 0, 123, 45, 67, 64, 123, 45, 67, 128]);
  });
  it('rejects invalid image/mask dimensions instead of producing a partial result', () => {
    expect(() => normalizeRgbNchw(new Uint8ClampedArray(4), 2, 1)).toThrow();
    expect(() =>
      applyMaskToOriginalAlpha(new Uint8ClampedArray(4), 1, 1, new Float32Array(2), 1, 1),
    ).toThrow();
    expect(() =>
      applyMaskToOriginalAlpha(new Uint8ClampedArray(0), 0, 1, new Float32Array(1), 1, 1),
    ).toThrow();
  });
  it('rejects non-finite model output', () => {
    expect(() => sigmoidMask(new Float32Array([NaN]), 'float32')).toThrow('유효하지 않은');
    expect(() => sigmoidMask(new Uint16Array([0x7c00]), 'float16')).toThrow();
  });
  it('encodes IEEE float16 including subnormal values and round-to-nearest ties', () => {
    const input = new Float32Array([0, -0, 1, -2, 65504, 2 ** -24, 1 + 2 ** -11, 1 + 3 * 2 ** -11]);
    const encoded = float32ToHalf(input);
    expect([...encoded]).toEqual([0, 0x8000, 0x3c00, 0xc000, 0x7bff, 1, 0x3c00, 0x3c02]);
    expect(halfToNumber(encoded[5])).toBe(2 ** -24);
    expect(halfToNumber(0x7c00)).toBe(Infinity);
    expect(halfToNumber(0xfc00)).toBe(-Infinity);
    expect(halfToNumber(0x7e00)).toBeNaN();
  });
  it('decodes half logits to the same probability as float32', () => {
    const logits = new Float32Array([-4, -1, 0, 1, 4]);
    expect([...sigmoidMask(float32ToHalf(logits), 'float16')]).toEqual([...sigmoidMask(logits, 'float32')]);
  });
});

describe('immutable model download', () => {
  it('pins both model variants to a commit and exact verified byte lengths', () => {
    expect(backgroundModelUrl('fp16')).toContain(`/${BACKGROUND_MODEL_REVISION}/onnx/model_fp16.onnx`);
    expect(backgroundModelUrl('fp32')).toContain('/onnx/model.onnx');
    expect(BACKGROUND_MODEL_FILES.fp16.bytes).toBe(98_484_532);
    expect(BACKGROUND_MODEL_FILES.fp32.bytes).toBe(191_877_254);
  });
  it('reports actual streamed bytes and returns an exact model buffer', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    const progress = vi.fn();
    expect([...(await readModelResponse(new Response(body), 3, progress))]).toEqual([1, 2, 3]);
    expect(progress.mock.calls).toEqual([[2], [3]]);
  });
  it('rejects HTTP failure, truncated downloads and unexpected extra data', async () => {
    await expect(readModelResponse(new Response(null, { status: 403 }), 3, () => undefined)).rejects.toThrow(
      'HTTP 403',
    );
    await expect(readModelResponse(new Response(new Uint8Array([1, 2])), 3, () => undefined)).rejects.toThrow(
      '완전히',
    );
    await expect(
      readModelResponse(new Response(new Uint8Array([1, 2, 3, 4])), 3, () => undefined),
    ).rejects.toThrow('크기');
  });
});

class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage?: (event: MessageEvent<BackgroundRemovalReply>) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  requests: BackgroundRemovalRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.created.push(this);
  }
  postMessage(request: BackgroundRemovalRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  reply(reply: BackgroundRemovalReply) {
    this.onmessage?.({ data: reply } as MessageEvent<BackgroundRemovalReply>);
  }
}
const result = (): BackgroundRemovalResult => ({
  blob: new Blob(['png']),
  width: 1200,
  height: 800,
  analysisWidth: 512,
  analysisHeight: 512,
  backend: 'wasm',
  precision: 'fp32',
  downloadMs: 100,
  initializationMs: 20,
  processingMs: 50,
  inferenceMs: 45,
  cacheSource: 'network',
});
afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.created = [];
});

describe('lazy background-removal worker lifecycle', () => {
  it('loads no worker until requested and blocks duplicate execution', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new BackgroundRemovalClient();
    expect(FakeWorker.created).toHaveLength(0);
    const pending = client.run(new Blob(['photo']), vi.fn());
    const reject = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.created).toHaveLength(1);
    await expect(client.run(new Blob(['photo']), vi.fn())).rejects.toThrow('진행 중');
    client.dispose();
    await reject;
    expect(FakeWorker.created[0].terminated).toBe(true);
  });
  it('passes actual result unchanged and reuses the session worker on next run', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new BackgroundRemovalClient();
    const progress = vi.fn();
    const promise = client.run(new Blob(['photo']), progress);
    const worker = FakeWorker.created[0];
    worker.reply({ type: 'progress', id: 1, progress: { stage: 'processing', message: 'actual inference' } });
    const output = result();
    worker.reply({ type: 'result', id: 1, result: output });
    expect(await promise).toBe(output);
    expect(progress).toHaveBeenCalledWith({ stage: 'processing', message: 'actual inference' });
    const second = client.run(new Blob(['another photo']), vi.fn());
    worker.reply({ type: 'result', id: 1, result: output }); // stale completion must not resolve the new job
    expect(FakeWorker.created).toHaveLength(1);
    worker.reply({ type: 'result', id: 2, result: output });
    expect(await second).toBe(output);
    client.dispose();
  });
  it('discards poisoned worker state after inference failure so retry can initialize again', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new BackgroundRemovalClient();
    const first = client.run(new Blob(['photo']), vi.fn());
    FakeWorker.created[0].reply({ type: 'error', id: 1, message: 'model failure' });
    await expect(first).rejects.toThrow('model failure');
    expect(FakeWorker.created[0].terminated).toBe(true);
    const second = client.run(new Blob(['photo']), vi.fn());
    const reject = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.created).toHaveLength(2);
    client.dispose();
    await reject;
  });
  it('handles worker script errors and unsupported browsers with clear failure', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new BackgroundRemovalClient();
    const first = client.run(new Blob(['photo']), vi.fn());
    FakeWorker.created[0].onerror?.();
    await expect(first).rejects.toThrow('실행 엔진');
    vi.stubGlobal('Worker', undefined);
    await expect(client.run(new Blob(['photo']), vi.fn())).rejects.toThrow('Web Worker');
  });
  it('rejects an empty image before creating or fetching a model', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    await expect(new BackgroundRemovalClient().run(new Blob(), vi.fn())).rejects.toThrow('25MB');
    expect(FakeWorker.created).toHaveLength(0);
  });
});
