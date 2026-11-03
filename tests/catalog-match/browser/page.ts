/**
 * The catalog-match trial's page library (bundled into `window.CM` by harness.ts): ONNX Runtime Web
 * embeddings (DINOv2, CLIP, SigLIP2), tile images drawn the same way for every method, photo face
 * crops through the app's own rectifyImage and photo-light estimate, and the model-free features.
 */
import type * as Ort from 'onnxruntime-web';
import { normalizeRgbNchw, sigmoidMask } from '../../../src/lib/background-removal/pixels';
import { rectifyImage } from '../../../src/lib/render/crop';
import { estimateReviewLighting, lightingMultiplier } from '../../../src/lib/reconstruction/photo-lighting';
import type { PhotoLighting } from '../../../src/lib/types';
import { colourFeatures, repeatLayout, textureFeatures, type Quad } from '../tile-features';

export * from '../tile-features';

declare global {
  interface Window {
    ort: typeof Ort;
  }
}

// ---------- files and output ----------
export const fileUrl = (path: string) => `${location.origin}/file?path=${encodeURIComponent(path)}`;
export async function loadBitmap(path: string): Promise<ImageBitmap> {
  const response = await fetch(fileUrl(path));
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return createImageBitmap(await response.blob(), { imageOrientation: 'from-image' });
}
/** Saves bytes or text under the results folder (relative path). */
export async function save(path: string, body: Blob | ArrayBuffer | string) {
  const response = await fetch(`${location.origin}/out?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body,
  });
  if (!response.ok) throw new Error(`save ${path}: ${response.status}`);
}
export const canvasBlob = (canvas: HTMLCanvasElement, type = 'image/png', quality?: number) =>
  new Promise<Blob>((done) => canvas.toBlob((blob) => done(blob!), type, quality));
export function canvasOf(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
export function pixels(canvas: HTMLCanvasElement) {
  return canvas
    .getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, canvas.width, canvas.height);
}

// ---------- ONNX Runtime ----------
/** `threads` > 1 only takes on a cross-origin isolated page (the offline precompute); the app's page is not. */
export async function loadOrt(threads = 1): Promise<void> {
  if ((window as { ort?: unknown }).ort) return;
  await new Promise<void>((done, fail) => {
    const script = document.createElement('script');
    script.src = `${location.origin}/ort/ort.webgpu.min.js`;
    script.onload = () => done();
    script.onerror = () => fail(new Error('ort script'));
    document.head.append(script);
  });
  window.ort.env.wasm.wasmPaths = `${location.origin}/ort/`;
  window.ort.env.wasm.numThreads = crossOriginIsolated ? threads : 1;
  window.ort.env.logLevel = 'error';
}
export async function gpuAdapter() {
  const gpu = (
    navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }
  ).gpu;
  const adapter = await gpu?.requestAdapter();
  return adapter
    ? {
        vendor: adapter.info?.vendor,
        architecture: adapter.info?.architecture,
        description: adapter.info?.description,
      }
    : null;
}

export type ModelSpec = {
  key: string;
  path: string;
  /** shortest-crop: resize the short side to `resize`, centre-crop `size`; squash: resize to size². */
  mode: 'shortest-crop' | 'squash';
  resize: number;
  size: number;
  mean: [number, number, number];
  std: [number, number, number];
};
export const MODEL_SPECS: Record<string, Omit<ModelSpec, 'path'>> = {
  'dinov2-small': {
    key: 'dinov2-small',
    mode: 'shortest-crop',
    resize: 256,
    size: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  // The same preprocessing as small (their preprocessor_config.json, 2026-11-03).
  'dinov2-base': {
    key: 'dinov2-base',
    mode: 'shortest-crop',
    resize: 256,
    size: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  // The same preprocessing as small (their preprocessor_config.json, 2026-11-03).
  'dinov2-large': {
    key: 'dinov2-large',
    mode: 'shortest-crop',
    resize: 256,
    size: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  'clip-b32': {
    key: 'clip-b32',
    mode: 'shortest-crop',
    resize: 224,
    size: 224,
    mean: [0.48145466, 0.4578275, 0.40821073],
    std: [0.26862954, 0.26130258, 0.27577711],
  },
  'siglip2-b16': {
    key: 'siglip2-b16',
    mode: 'squash',
    resize: 224,
    size: 224,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
  },
};

function toHalf(value: number) {
  const f = new Float32Array(1),
    i = new Uint32Array(f.buffer);
  f[0] = value;
  const x = i[0];
  const sign = (x >> 16) & 0x8000;
  const exponent = ((x >> 23) & 0xff) - 112;
  let mantissa = x & 0x7fffff;
  if (exponent <= 0) return sign;
  if (exponent > 30) return sign | 0x7c00;
  mantissa >>= 13;
  return sign | (exponent << 10) | mantissa;
}
function fromHalf(h: number) {
  const sign = h & 0x8000 ? -1 : 1,
    exponent = (h >> 10) & 0x1f,
    mantissa = h & 0x3ff;
  if (!exponent) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}
const asFloat32 = (data: unknown): Float32Array => {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) return Float32Array.from(data, fromHalf);
  return Float32Array.from(data as ArrayLike<number>);
};

/** Draws an image into the model's input square and returns the normalised CHW tensor data. */
export function modelInput(spec: ModelSpec, source: CanvasImageSource & { width: number; height: number }) {
  const canvas = canvasOf(spec.size, spec.size);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingQuality = 'high';
  const w = source.width,
    h = source.height;
  if (spec.mode === 'squash') context.drawImage(source, 0, 0, spec.size, spec.size);
  else {
    const scale = spec.resize / Math.min(w, h);
    const side = spec.size / scale;
    context.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, spec.size, spec.size);
  }
  const { data } = context.getImageData(0, 0, spec.size, spec.size);
  const plane = spec.size * spec.size;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++)
    for (let c = 0; c < 3; c++) out[c * plane + i] = (data[i * 4 + c] / 255 - spec.mean[c]) / spec.std[c];
  return out;
}

export type Embedder = {
  info: {
    key: string;
    path: string;
    ep: string;
    inputs: readonly string[];
    outputs: readonly string[];
    loadMs: number;
  };
  /** Named embeddings of one image (each L2-normalised). */
  embed(source: CanvasImageSource & { width: number; height: number }): Promise<Record<string, Float32Array>>;
};
const normalise = (v: Float32Array) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
export async function openEmbedder(spec: ModelSpec, ep: 'webgpu' | 'wasm', threads = 1): Promise<Embedder> {
  await loadOrt(threads);
  const started = performance.now();
  const response = await fetch(fileUrl(spec.path));
  const bytes = new Uint8Array(await response.arrayBuffer());
  const session = await window.ort.InferenceSession.create(bytes, {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
  });
  const loadMs = performance.now() - started;
  const metadata = (session as unknown as { inputMetadata?: { name: string; type?: string }[] })
    .inputMetadata;
  const half = metadata?.some((m) => m.type === 'float16');
  const inputName = session.inputNames[0];
  return {
    info: {
      key: spec.key,
      path: spec.path,
      ep,
      inputs: session.inputNames,
      outputs: session.outputNames,
      loadMs,
    },
    async embed(source) {
      const input = modelInput(spec, source);
      const tensor = half
        ? new window.ort.Tensor('float16', Uint16Array.from(input, toHalf), [1, 3, spec.size, spec.size])
        : new window.ort.Tensor('float32', input, [1, 3, spec.size, spec.size]);
      const outputs = await session.run({ [inputName]: tensor });
      const result: Record<string, Float32Array> = {};
      const pooled = outputs.image_embeds ?? outputs.pooler_output;
      const hidden = outputs.last_hidden_state;
      if (pooled) result.pooled = normalise(asFloat32(pooled.data));
      if (hidden) {
        const [, tokens, width] = hidden.dims as number[];
        const data = asFloat32(hidden.data);
        if (!pooled) result.pooled = normalise(data.slice(0, width));
        // Patch mean (DINOv2's register-free small model: token 0 is CLS).
        const mean = new Float32Array(width);
        for (let t = 1; t < tokens; t++) for (let k = 0; k < width; k++) mean[k] += data[t * width + k];
        result.patchmean = normalise(mean);
      }
      for (const value of Object.values(outputs)) (value as { dispose?: () => void }).dispose?.();
      return result;
    },
  };
}

// ---------- tile images ----------
/**
 * Trims a plain border (white or flat margin around a tile photo): rows/columns from each edge whose
 * colour stays within a few levels of the corner colour, at most 15% a side.
 */
export function trimMargins(bitmap: ImageBitmap | HTMLCanvasElement): HTMLCanvasElement {
  const probe = canvasOf(bitmap.width, bitmap.height);
  const context = probe.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, probe.width, probe.height);
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corner = [data[0], data[1], data[2]];
  const flat = (indices: number[]) => {
    let bad = 0;
    for (const i of indices)
      if (
        Math.abs(data[i] - corner[0]) +
          Math.abs(data[i + 1] - corner[1]) +
          Math.abs(data[i + 2] - corner[2]) >
        24
      )
        bad++;
    return bad / indices.length < 0.02;
  };
  const row = (y: number) => Array.from({ length: width }, (_, x) => at(x, y));
  const column = (x: number) => Array.from({ length: height }, (_, y) => at(x, y));
  let top = 0,
    bottom = height - 1,
    left = 0,
    right = width - 1;
  while (top < height * 0.15 && flat(row(top))) top++;
  while (bottom > height * 0.85 && flat(row(bottom))) bottom--;
  while (left < width * 0.15 && flat(column(left))) left++;
  while (right > width * 0.85 && flat(column(right))) right--;
  const out = canvasOf(right - left + 1, bottom - top + 1);
  out.getContext('2d')!.drawImage(probe, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
/** At most `long` px on the long side. */
export function shrink(source: HTMLCanvasElement | ImageBitmap, long: number): HTMLCanvasElement {
  const scale = Math.min(1, long / Math.max(source.width, source.height));
  const out = canvasOf(source.width * scale, source.height * scale);
  const context = out.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, out.width, out.height);
  return out;
}
/** The tile repeated over a `windowMm` square with its joints (the "same size" drawing). */
export function repeatTile(
  tile: HTMLCanvasElement,
  size: { widthMm: number; heightMm: number; groutMm: number; groutColor: string },
  windowMm: number,
  px: number,
): HTMLCanvasElement {
  const out = canvasOf(px, px);
  const context = out.getContext('2d')!;
  context.fillStyle = size.groutColor;
  context.fillRect(0, 0, px, px);
  context.imageSmoothingQuality = 'high';
  for (const cell of repeatLayout(size, windowMm, px).cells)
    context.drawImage(tile, cell.x, cell.y, cell.w, cell.h);
  return out;
}
/** A crop cut to the same physical window (centre), when the crop is bigger; else the crop itself. */
export function windowCrop(
  crop: HTMLCanvasElement,
  cropMm: { widthMm: number; heightMm: number },
  windowMm: number,
) {
  const fx = Math.min(1, windowMm / cropMm.widthMm),
    fy = Math.min(1, windowMm / cropMm.heightMm);
  const w = crop.width * fx,
    h = crop.height * fy;
  const out = canvasOf(w, h);
  out.getContext('2d')!.drawImage(crop, (crop.width - w) / 2, (crop.height - h) / 2, w, h, 0, 0, w, h);
  return out;
}

/** Model-free features of an image (a canvas), at most 256 px. */
export function classicFeatures(canvas: HTMLCanvasElement) {
  const small = shrink(canvas, 256);
  const image = pixels(small);
  return { colour: colourFeatures(image), texture: textureFeatures(image) };
}

// ---------- photo crops ----------
export async function photoBlob(path: string) {
  const response = await fetch(fileUrl(path));
  return response.blob();
}
/**
 * The colours the app's analysis would have seen (synthetic rooms only, which have no analysis): the
 * mean of each face quad and the middle of each product box, as they look in the photo.
 */
export async function observeColours<
  T extends { quad: Quad; tile: { color: string } },
  U extends { bounds: { left: number; top: number; right: number; bottom: number }; color: string },
>(blob: Blob, review: { planes: T[]; candidates: U[] }): Promise<{ planes: T[]; candidates: U[] }> {
  const bitmap = await createImageBitmap(blob);
  const canvas = canvasOf(
    Math.min(640, bitmap.width),
    (Math.min(640, bitmap.width) * bitmap.height) / bitmap.width,
  );
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const hex = (sum: number[], n: number) =>
    '#' +
    sum
      .map((v) =>
        Math.round(v / Math.max(1, n))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  const meanWhere = (test: (x: number, y: number) => boolean) => {
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < height; y += 2)
      for (let x = 0; x < width; x += 2)
        if (test(x / width, y / height)) {
          const i = (y * width + x) * 4;
          sum[0] += data[i];
          sum[1] += data[i + 1];
          sum[2] += data[i + 2];
          n++;
        }
    return hex(sum, n);
  };
  const insideQuad = (q: Quad, x: number, y: number) => {
    let hit = false;
    for (let i = 0, j = 3; i < 4; j = i++)
      if (q[i].y > y !== q[j].y > y && x < ((q[j].x - q[i].x) * (y - q[i].y)) / (q[j].y - q[i].y) + q[i].x)
        hit = !hit;
    return hit;
  };
  return {
    planes: review.planes.map((p) => ({
      ...p,
      tile: { ...p.tile, color: meanWhere((x, y) => insideQuad(p.quad, x, y)) },
    })),
    candidates: review.candidates.map((c) => {
      const b = c.bounds,
        w = b.right - b.left,
        h = b.bottom - b.top;
      return {
        ...c,
        color: meanWhere(
          (x, y) =>
            x > b.left + w * 0.3 && x < b.right - w * 0.3 && y > b.top + h * 0.3 && y < b.bottom - h * 0.3,
        ),
      };
    }),
  };
}
/** The photo's light from its review (the app's estimate), or undefined. */
export async function photoLight(
  blob: Blob,
  review: Parameters<typeof estimateReviewLighting>[1],
): Promise<PhotoLighting | undefined> {
  return estimateReviewLighting(blob, review);
}
/** Rectifies a face (sub)quad with the app's rectifyImage; optionally takes the photo's light out. */
export async function faceCrop(
  blob: Blob,
  quad: Quad,
  width: number,
  height: number,
  light?: PhotoLighting,
): Promise<HTMLCanvasElement> {
  const rectified = await createImageBitmap(await rectifyImage(blob, quad, width, height));
  const canvas = canvasOf(rectified.width, rectified.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(rectified, 0, 0);
  rectified.close();
  if (light) {
    const m = lightingMultiplier(light);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const toLinear = (c: number) => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const toSrgb = (v: number) => {
      const c = Math.max(0, Math.min(1, v));
      return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    };
    const lut = Float32Array.from({ length: 256 }, (_, i) => toLinear(i));
    for (let i = 0; i < image.data.length; i += 4)
      for (let c = 0; c < 3; c++) image.data[i + c] = toSrgb(lut[image.data[i + c]] / m[c]);
    context.putImageData(image, 0, 0);
  }
  return canvas;
}

// ---------- products ----------
/** A product photo on white, cut to its opaque pixels (catalog photos are cut-outs). */
export function onWhite(bitmap: ImageBitmap | HTMLCanvasElement, trim = true): HTMLCanvasElement {
  const probe = canvasOf(bitmap.width, bitmap.height);
  const context = probe.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, probe.width, probe.height);
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  if (trim)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (data[(y * width + x) * 4 + 3] > 16) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
  if (right < 0) [left, top, right, bottom] = [0, 0, width - 1, height - 1];
  const w = right - left + 1,
    h = bottom - top + 1;
  // A square with a margin, so every model sees the whole product.
  const side = Math.round(Math.max(w, h) * 1.08);
  const out = canvasOf(side, side);
  const o = out.getContext('2d')!;
  o.fillStyle = '#ffffff';
  o.fillRect(0, 0, side, side);
  o.drawImage(probe, left, top, w, h, (side - w) / 2, (side - h) / 2, w, h);
  return out;
}
/** A photo region (0–1 box) with a margin. */
export function boxCrop(
  bitmap: ImageBitmap,
  box: { left: number; top: number; right: number; bottom: number },
  pad = 0.06,
) {
  const w = box.right - box.left,
    h = box.bottom - box.top;
  const left = Math.max(0, (box.left - w * pad) * bitmap.width),
    top = Math.max(0, (box.top - h * pad) * bitmap.height);
  const right = Math.min(bitmap.width, (box.right + w * pad) * bitmap.width),
    bottom = Math.min(bitmap.height, (box.bottom + h * pad) * bitmap.height);
  const out = canvasOf(right - left, bottom - top);
  out.getContext('2d')!.drawImage(bitmap, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
let birefnet: Ort.InferenceSession | undefined;
/** The app's background-removal model (BiRefNet lite, the cached fp16 file) on a crop: the cut-out on white. */
export async function cutOut(crop: HTMLCanvasElement, modelPath: string): Promise<HTMLCanvasElement> {
  await loadOrt();
  if (!birefnet) {
    const bytes = new Uint8Array(await (await fetch(fileUrl(modelPath))).arrayBuffer());
    birefnet = await window.ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
  }
  const size = 512;
  const input = canvasOf(size, size);
  const context = input.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(crop, 0, 0, size, size);
  const normal = normalizeRgbNchw(context.getImageData(0, 0, size, size).data, size, size);
  // The cached fp16 file takes float32 in (its casts are inside).
  const outputs = await birefnet.run({
    input_image: new window.ort.Tensor('float32', normal, [1, 3, size, size]),
  });
  const logits = outputs.logits ?? outputs[birefnet.outputNames[0]];
  const mask = sigmoidMask(logits.data as Uint16Array, logits.type === 'float16' ? 'float16' : 'float32');
  const masked = canvasOf(size, size);
  const m = masked.getContext('2d', { willReadFrequently: true })!;
  m.drawImage(crop, 0, 0, size, size);
  const image = m.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) image.data[i * 4 + 3] = Math.round(255 * mask[i]);
  m.putImageData(image, 0, 0);
  const back = canvasOf(crop.width, crop.height);
  back.getContext('2d')!.drawImage(masked, 0, 0, crop.width, crop.height);
  return onWhite(back);
}

// ---------- boards shown to the AI ----------
const BOARD_W = 1280,
  BOARD_H = 720;
/** A numbered label big enough to read after Clef's ~1 MP resize (the board is already under 1 MP). */
export const LABEL_PX = 34;
function label(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  context.font = `bold ${LABEL_PX}px sans-serif`;
  const w = context.measureText(text).width + 14;
  context.fillStyle = '#ffffff';
  context.fillRect(x, y, w, LABEL_PX + 10);
  context.strokeStyle = '#000000';
  context.lineWidth = 2;
  context.strokeRect(x, y, w, LABEL_PX + 10);
  context.fillStyle = '#000000';
  context.fillText(text, x + 7, y + LABEL_PX + 1);
}
function fit(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const s = Math.min(w / image.width, h / image.height);
  context.drawImage(
    image,
    x + (w - image.width * s) / 2,
    y + (h - image.height * s) / 2,
    image.width * s,
    image.height * s,
  );
}
/**
 * The photo's piece on the left ("PHOTO"), up to 12 numbered candidates on the right (4 × 3). Tiles are
 * drawn repeated over the same 900 mm square; products as their front photo on white.
 */
export function board(
  left: HTMLCanvasElement,
  candidates: HTMLCanvasElement[],
  offset = 0,
): HTMLCanvasElement {
  const canvas = canvasOf(BOARD_W, BOARD_H);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#d9d9d9';
  context.fillRect(0, 0, BOARD_W, BOARD_H);
  context.imageSmoothingQuality = 'high';
  fit(context, left, 10, 70, 500, 640);
  label(context, 'PHOTO', 10, 10);
  const cell = 176,
    gap = 8,
    x0 = 540,
    y0 = 8;
  candidates.slice(0, 12).forEach((candidate, i) => {
    const x = x0 + (i % 4) * (cell + gap),
      y = y0 + Math.floor(i / 4) * (cell + 60);
    context.fillStyle = '#ffffff';
    context.fillRect(x, y + 52, cell, cell);
    fit(context, candidate, x, y + 52, cell, cell);
    label(context, String(offset + i + 1), x, y);
  });
  return canvas;
}
/** The photo (at most 1024 px) with numbered boxes. */
export function markedPhoto(
  bitmap: ImageBitmap,
  boxes: { left: number; top: number; right: number; bottom: number }[],
) {
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = canvasOf(bitmap.width * scale, bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  boxes.forEach((b, i) => {
    context.strokeStyle = '#ff0000';
    context.lineWidth = Math.max(3, canvas.width / 200);
    context.strokeRect(
      b.left * canvas.width,
      b.top * canvas.height,
      (b.right - b.left) * canvas.width,
      (b.bottom - b.top) * canvas.height,
    );
    label(
      context,
      String(i + 1),
      Math.min(canvas.width - 40, b.left * canvas.width + 4),
      Math.min(canvas.height - 50, b.top * canvas.height + 4),
    );
  });
  return canvas;
}
/** Round 9: the photo (at most 1024 px) with each face's piece outlined in red and numbered. */
export function outlinedPhoto(bitmap: ImageBitmap, quads: Quad[]) {
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = canvasOf(bitmap.width * scale, bitmap.height * scale);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  quads.forEach((quad, i) => {
    context.strokeStyle = '#ff0000';
    context.lineWidth = Math.max(3, canvas.width / 200);
    context.beginPath();
    quad.forEach((p, k) =>
      (k ? context.lineTo : context.moveTo).call(context, p.x * canvas.width, p.y * canvas.height),
    );
    context.closePath();
    context.stroke();
    const cx = quad.reduce((s, p) => s + p.x, 0) / 4,
      cy = quad.reduce((s, p) => s + p.y, 0) / 4;
    label(
      context,
      String(i + 1),
      Math.min(canvas.width - 40, Math.max(0, cx * canvas.width - 20)),
      Math.min(canvas.height - 50, Math.max(0, cy * canvas.height - 22)),
    );
  });
  return canvas;
}
/** Round 9: the pieces side by side on grey, each under its number (2 × 2 for four). */
export function piecesBoard(pieces: HTMLCanvasElement[]): HTMLCanvasElement {
  const canvas = canvasOf(BOARD_W, BOARD_H);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#d9d9d9';
  context.fillRect(0, 0, BOARD_W, BOARD_H);
  context.imageSmoothingQuality = 'high';
  const columns = pieces.length > 2 ? 2 : pieces.length,
    rows = Math.ceil(pieces.length / columns);
  const w = BOARD_W / columns,
    h = BOARD_H / rows;
  pieces.forEach((piece, i) => {
    const x = (i % columns) * w,
      y = Math.floor(i / columns) * h;
    fit(context, piece, x + 70, y + 8, w - 80, h - 16);
    label(context, String(i + 1), x + 8, y + 8);
  });
  return canvas;
}
export const dataUrlOf = (canvas: HTMLCanvasElement, quality = 0.88) =>
  canvas.toDataURL('image/jpeg', quality);
