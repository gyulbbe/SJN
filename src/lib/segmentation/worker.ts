import {
  extractReconstructionCandidates,
  mergeReconstructionPasses,
  mapCandidatePass,
  refineCandidateFrames,
} from '../reconstruction/candidates';
import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import type { RoomSegmentation, SegmentationReply } from './index';
import { refineWallMask } from './wall-refinement';

const MODEL_URL = '/models/deeplab-ade20k/model.json';
// Google DeepLab ADE20K includes background=0; this differs from SegFormer's label offset.
// https://github.com/tensorflow/tfjs-models/blob/master/deeplab/src/config.ts
const FLOOR_CLASS = 4;
let model: GraphModel | undefined;
let runtimeReady = false;
let queue = Promise.resolve();

function stage(id: number, message: string) {
  self.postMessage({ id, type: 'stage', message } satisfies SegmentationReply);
}

async function getModel(id: number) {
  if (!runtimeReady) {
    stage(id, '브라우저 분석 엔진 준비 중');
    setWasmPaths(`${self.location.origin}/models/tfjs-wasm/`);
    // Single-thread WASM also runs without cross-origin isolation / SharedArrayBuffer.
    setThreadsCount(1);
    if (!(await tf.setBackend('wasm'))) throw new Error('브라우저 분석 엔진을 시작하지 못했어요.');
    await tf.ready();
    runtimeReady = true;
  }
  if (!model) {
    stage(id, '앱에 포함된 공간 분석 모델 읽는 중');
    model = await loadGraphModel(`${self.location.origin}${MODEL_URL}`, {
      // Defense in depth: even an accidentally altered manifest cannot upload or fetch remotely.
      fetchFunc: async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          self.location.origin,
        );
        if (url.origin !== self.location.origin || !url.pathname.startsWith('/models/deeplab-ade20k/'))
          throw new Error('앱에 포함되지 않은 분석 모델 요청을 차단했어요.');
        if (init?.method && init.method !== 'GET') throw new Error('분석 모델은 읽기 요청만 허용해요.');
        const response = await fetch(url, { ...init, method: 'GET', credentials: 'omit' });
        if (!response.ok) throw new Error('앱에 포함된 공간 분석 모델을 읽지 못했어요. 다시 시도해 주세요.');
        return response;
      },
    });
  }
  return model;
}

async function run(id: number, blob: Blob, context?: string): Promise<RoomSegmentation> {
  const report = (message: string) => stage(id, context ? `${context} · ${message}` : message);
  report('사진 크기와 방향 확인 중');
  const bitmap = await createImageBitmap(blob);
  let input: tf.Tensor4D | undefined;
  let outputs: tf.Tensor[] = [];
  try {
    if (bitmap.width * bitmap.height > 40_000_000 || !bitmap.width || !bitmap.height)
      throw new Error('분석 사진은 4,000만 화소 이하로 올려 주세요.');
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('이 브라우저에서 사진을 읽을 수 없어요.');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    bitmap.close();
    const graph = await getModel(id);
    const rgb = new Int32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = pixels[i * 4];
      rgb[i * 3 + 1] = pixels[i * 4 + 1];
      rgb[i * 3 + 2] = pixels[i * 4 + 2];
    }
    input = tf.tensor4d(rgb, [1, height, width, 3], 'int32');
    report('이 브라우저에서 벽과 바닥 분석 중');
    // Keep the official labels unchanged, and inspect the compact 129×129 logits for object guards.
    // Returning the full 513×513×151 logits would retain about 159 MB; this tensor is about 10 MB.
    const prediction = graph.execute(input, [
      'SemanticPredictions',
      'logits/semantic/BiasAdd',
      'Slice/size',
      'strided_slice_6',
    ]);
    // Intermediate Const outputs can be borrowed model weights. Disposing them breaks the next run.
    const modelTensorIds = new Set(
      Object.values(graph.weights)
        .flat()
        .map((tensor) => tensor.id),
    );
    outputs = (Array.isArray(prediction) ? prediction : [prediction]).filter(
      (tensor) => !modelTensorIds.has(tensor.id),
    );
    if (!Array.isArray(prediction) || prediction.length !== 4) {
      throw new Error('공간 분석 모델의 출력 형식이 예상과 달라요.');
    }
    const [labels, scores, crop, padded] = await Promise.all(prediction.map((output) => output.data()));
    const dimensions = prediction[0].shape;
    const mapHeight = dimensions[dimensions.length - 2];
    const mapWidth = dimensions[dimensions.length - 1];
    if (!mapWidth || !mapHeight || labels.length !== mapWidth * mapHeight)
      throw new Error('공간 분석 마스크 크기를 확인할 수 없어요.');
    report('벽과 바닥 경계 정리 중');
    const semanticLabels = new Uint8Array(width * height);
    const floor = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const sourceY = Math.min(mapHeight - 1, Math.floor(((y + 0.5) * mapHeight) / height));
      for (let x = 0; x < width; x++) {
        const sourceX = Math.min(mapWidth - 1, Math.floor(((x + 0.5) * mapWidth) / width));
        const label = labels[sourceY * mapWidth + sourceX];
        const position = y * width + x;
        semanticLabels[position] = label;
        floor[position] = label === FLOOR_CLASS ? 255 : 0;
      }
    }
    report('문과 작은 설비의 경계 보호 중');
    const [, logitsHeight, logitsWidth, channels] = prediction[1].shape;
    if (
      !logitsHeight ||
      !logitsWidth ||
      !channels ||
      !(scores instanceof Float32Array) ||
      crop.length !== 3 ||
      padded.length !== 2
    )
      throw new Error('벽 물체 분석 점수의 크기를 확인할 수 없어요.');
    const refined = refineWallMask({
      width,
      height,
      rgba: pixels,
      labels: semanticLabels,
      logits: {
        values: scores,
        width: logitsWidth,
        height: logitsHeight,
        channels,
        cropWidth: crop[2],
        cropHeight: crop[1],
        paddedWidth: padded[1],
        paddedHeight: padded[0],
      },
    });
    report('기존 기구와 설치 위치 후보 정리 중');
    const objects = extractReconstructionCandidates({
      width,
      height,
      labels: semanticLabels,
      rgba: pixels,
      logits: {
        values: scores,
        width: logitsWidth,
        height: logitsHeight,
        channels,
        cropWidth: crop[2],
        cropHeight: crop[1],
        paddedWidth: padded[1],
        paddedHeight: padded[0],
      },
    });
    return { width, height, wall: refined.wall, floor, wallRefinement: refined.stats, objects };
  } finally {
    bitmap.close();
    input?.dispose();
    tf.dispose(outputs);
  }
}

/** Reconstruction-only evidence checks; photo-editing masks retain the original single pass. */
async function enhanceObjects(id: number, blob: Blob, primary: RoomSegmentation): Promise<RoomSegmentation> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(primary.width, primary.height),
      ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('기구 재분석 이미지를 만들 수 없어요.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    stage(id, '좌우 시점으로 기구 재확인 중');
    const flipped = new OffscreenCanvas(primary.width, primary.height),
      flipContext = flipped.getContext('2d')!;
    flipContext.translate(flipped.width, 0);
    flipContext.scale(-1, 1);
    flipContext.drawImage(canvas, 0, 0);
    const second = await run(id, await flipped.convertToBlob({ type: 'image/png' }), '좌우 방향 재확인');
    let objects = mergeReconstructionPasses(
      primary.objects ?? [],
      mapCandidatePass(second.objects ?? [], { left: 0, top: 0, right: 1, bottom: 1 }, true),
    );
    objects = refineCandidateFrames(objects, rgba, primary.width, primary.height);
    // A crop has less room context. It can confirm or flag a candidate, never blindly replace it.
    const uncertain = objects
      .filter((c) => c.requiresReview || (c.evidence.meanMargin >= 0.8 && c.evidence.meanMargin < 4))
      .slice(0, 6);
    for (const candidate of uncertain) {
      stage(id, '혼동된 기구 확대 분석 중');
      const b = candidate.bounds,
        w = Math.max(0.18, (b.right - b.left) * 1.9),
        h = Math.max(0.22, (b.bottom - b.top) * 1.65);
      const cx = (b.left + b.right) / 2,
        cy = (b.top + b.bottom) / 2;
      const region = {
        left: Math.max(0, cx - w / 2),
        right: Math.min(1, cx + w / 2),
        top: Math.max(0, cy - h / 2),
        bottom: Math.min(1, cy + h / 2),
      };
      const cropW = (region.right - region.left) * bitmap.width,
        cropH = (region.bottom - region.top) * bitmap.height,
        factor = 512 / Math.max(cropW, cropH);
      const crop = new OffscreenCanvas(
        Math.max(1, Math.round(cropW * factor)),
        Math.max(1, Math.round(cropH * factor)),
      );
      crop
        .getContext('2d')!
        .drawImage(
          bitmap,
          region.left * bitmap.width,
          region.top * bitmap.height,
          cropW,
          cropH,
          0,
          0,
          crop.width,
          crop.height,
        );
      const local = await run(id, await crop.convertToBlob({ type: 'image/png' }), '혼동된 기구 확대 확인');
      const mapped = mapCandidatePass(local.objects ?? [], region);
      const overlap = (a: typeof b, c: typeof b) =>
        Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) *
        Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
      const area = (r: typeof b) => (r.right - r.left) * (r.bottom - r.top);
      const same = mapped.find(
        (c) =>
          c.kind === candidate.kind &&
          !c.requiresReview &&
          c.evidence.meanMargin >= 1.5 &&
          overlap(c.bounds, b) / Math.min(area(c.bounds), area(b)) > 0.55 &&
          area(c.bounds) > area(b) * 0.45,
      );
      if (same) {
        if (!candidate.requiresReview && candidate.kind === 'mirror' && area(same.bounds) > area(b) * 0.8) {
          const better = mergeReconstructionPasses([candidate], [same])[0];
          Object.assign(candidate, better, { id: candidate.id });
        }
        candidate.warning = candidate.requiresReview
          ? candidate.warning
          : '전체·좌우 반전·확대 분석에서 같은 기구 후보를 확인했어요. 규격과 위치는 확인해 주세요.';
      } else if (
        candidate.requiresReview ||
        (candidate.evidence.meanMargin < 2 &&
          !(
            (primary.objects ?? []).some(
              (c) =>
                c.kind === candidate.kind && overlap(c.bounds, b) / Math.min(area(c.bounds), area(b)) > 0.4,
            ) &&
            mapCandidatePass(second.objects ?? [], { left: 0, top: 0, right: 1, bottom: 1 }, true).some(
              (c) =>
                c.kind === candidate.kind && overlap(c.bounds, b) / Math.min(area(c.bounds), area(b)) > 0.4,
            )
          ))
      ) {
        candidate.requiresReview = true;
        candidate.warning =
          '전체 사진과 확대 분석의 물체 분류가 일치하지 않아요. 종류를 확인한 후 배치해 주세요.';
      }
    }
    return { ...primary, objects };
  } finally {
    bitmap.close();
  }
}

self.onmessage = (event: MessageEvent<{ id: number; blob: Blob; quality?: 'reconstruction' }>) => {
  const { id, blob, quality } = event.data;
  queue = queue.then(async () => {
    try {
      let result = await run(id, blob);
      if (quality === 'reconstruction') result = await enhanceObjects(id, blob, result);
      self.postMessage({ id, type: 'result', result } satisfies SegmentationReply, {
        transfer: [result.wall.buffer, result.floor.buffer],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '사진 분석에 실패했어요. 다시 시도해 주세요.';
      self.postMessage({ id, type: 'error', message } satisfies SegmentationReply);
    }
  });
};
