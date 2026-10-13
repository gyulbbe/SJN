import { readFluxAnswer } from '../ai-export/client';
import type { DirectionPhotoSpec } from './contract';

/**
 * One direction photo from the server (POST /api/materials/direction-photo): the guide, the real
 * product's photos on white and the facts. One request, no retry; the answer is a PNG of twice the
 * guide's size. A refusal carries its HTTP status (a spent limit or a refused login ends a run).
 */
export async function requestDirectionPhoto(input: {
  guide: Blob;
  refs: readonly Blob[];
  seed: number;
  spec: DirectionPhotoSpec;
  signal: AbortSignal;
  userId?: string | null;
}): Promise<Blob> {
  const form = new FormData();
  form.set('guide', input.guide, 'guide.png');
  input.refs.forEach((ref, index) => form.append('refs', ref, `photo-${index + 1}.png`));
  form.set('seed', String(input.seed));
  form.set('spec', JSON.stringify(input.spec));
  return readFluxAnswer(
    await fetch('/api/materials/direction-photo', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      signal: input.signal,
      headers: input.userId ? { 'X-SJN-User-Id': input.userId } : {},
    }),
  );
}

/** RGBA rows turned over left to right (the 왼쪽 photo of a product that is the same on both sides). */
export function mirrorRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4,
        to = (y * width + (width - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) out[to + c] = data[from + c];
    }
  return out;
}

async function drawn(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('이미지를 읽지 못했어요.');
    context.drawImage(bitmap, 0, 0);
    return { canvas, context, image: context.getImageData(0, 0, canvas.width, canvas.height) };
  } finally {
    bitmap.close();
  }
}
const png = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG를 만들지 못했어요.'))),
      'image/png',
    ),
  );

/** The picture turned over left to right, as a PNG (transparency kept). */
export async function mirrorPng(blob: Blob): Promise<Blob> {
  const { canvas, context, image } = await drawn(blob);
  context.putImageData(
    new ImageData(mirrorRgba(image.data, image.width, image.height), image.width, image.height),
    0,
    0,
  );
  return png(canvas);
}

/** One alpha byte a pixel, top-down. */
export async function readAlpha(blob: Blob): Promise<{ alpha: Uint8Array; width: number; height: number }> {
  const { image } = await drawn(blob);
  const alpha = new Uint8Array(image.width * image.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = image.data[i * 4 + 3];
  return { alpha, width: image.width, height: image.height };
}
