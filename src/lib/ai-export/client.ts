import { z } from 'zod';
import type { Pixels } from './color';
import { fluxInputLayout } from './contract';
import type { FluxProduct } from './product-prompt';
import { FLUX_FIXTURE_KINDS, type FluxScene } from './scene-contract';
import {
  FLUX_CHECK_MAX_EDGE,
  FLUX_CHECK_SEEN,
  FLUX_CHECK_WALLS,
  FLUX_EXTRA_KINDS,
  FLUX_EXTRA_PLACES,
  type FluxCheckResult,
  type FluxCheckScene,
  type FluxCheckWall,
} from './check-contract';

function pngBlob(canvas: HTMLCanvasElement, message: string) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error(message))), 'image/png'),
  );
}
/** RGBA pixels of an image blob (sRGB, as drawn on a 2D canvas). */
export async function readPixels(blob: Blob): Promise<Pixels> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('이미지를 읽지 못했어요.');
    context.drawImage(bitmap, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  } finally {
    bitmap.close();
  }
}
export async function pixelsToPng(image: Pixels): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('보정한 이미지를 만들지 못했어요.');
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return pngBlob(canvas, '보정한 PNG 저장에 실패했어요.');
}
export async function prepareFluxImage(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    const layout = fluxInputLayout(bitmap.width, bitmap.height);
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('AI 변환용 이미지를 만들지 못했어요.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, layout.width, layout.height);
    context.drawImage(bitmap, layout.x, layout.y, layout.contentWidth, layout.contentHeight);
    return await pngBlob(canvas, 'PNG 변환에 실패했어요.');
  } finally {
    bitmap.close();
  }
}
/** The model's picture from a FLUX route's answer, decoded and re-encoded as a real PNG. */
async function readFluxAnswer(response: Response): Promise<Blob> {
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    // The status travels with the error: a spent limit or a refused login ends a whole run (refine-run).
    throw Object.assign(
      new Error(failure?.error || 'AI 이미지 변환에 실패했어요. 자동 재시도하지 않았어요.'),
      {
        status: response.status,
      },
    );
  }
  const result = await response.blob();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(result.type) || !result.size)
    throw new Error('AI 이미지 응답이 올바르지 않아요.');
  // Decode before displaying and export a real PNG even when the provider returns JPEG.
  const bitmap = await createImageBitmap(result);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('결과 이미지를 읽지 못했어요.');
    ctx.drawImage(bitmap, 0, 0);
    return await pngBlob(canvas, '결과 PNG 저장에 실패했어요.');
  } finally {
    bitmap.close();
  }
}
/**
 * The real product's photo as the model's second image: on white, whole (never cropped or stretched),
 * within the model's input size. The saved photo is a cut-out, so the transparent part becomes white.
 */
export async function prepareReferenceImage(photo: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(photo);
  try {
    const layout = fluxInputLayout(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('제품 사진을 준비하지 못했어요.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, layout.width, layout.height);
    context.drawImage(bitmap, layout.x, layout.y, layout.contentWidth, layout.contentHeight);
    return await pngBlob(canvas, '제품 사진 PNG 변환에 실패했어요.');
  } finally {
    bitmap.close();
  }
}
export async function requestFluxImage(
  image: Blob,
  seed: number,
  signal: AbortSignal,
  userId?: string | null,
  scene?: FluxScene,
) {
  const form = new FormData();
  form.set('image', image, 'after.png');
  form.set('seed', String(seed));
  if (scene) form.set('scene', JSON.stringify(scene));
  return readFluxAnswer(
    await fetch('/api/export/photoreal', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      signal,
      headers: userId ? { 'X-SJN-User-Id': userId } : {},
    }),
  );
}
/**
 * One product's close-up (and, when there is one, the real product's photo on white) redrawn by the
 * model as a studio photograph. One request, no retry; the answer is a PNG of twice the crop's size.
 */
export async function requestFluxProduct(
  image: Blob,
  reference: Blob | undefined,
  seed: number,
  product: FluxProduct,
  signal: AbortSignal,
  userId?: string | null,
) {
  const form = new FormData();
  form.set('image', image, 'product.png');
  form.set('seed', String(seed));
  form.set('product', JSON.stringify(product));
  if (reference) form.set('reference', reference, 'photo.png');
  return readFluxAnswer(
    await fetch('/api/export/photoreal/product', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      signal,
      headers: userId ? { 'X-SJN-User-Id': userId } : {},
    }),
  );
}

/**
 * The fixtures to look for in a result (kind, box and the face it is on) and the walls in view, for
 * the tile question. None when nothing was placed: the check is not called then, as before.
 */
export function fluxCheckScene(
  scene: FluxScene | undefined,
  walls: readonly FluxCheckWall[] = [],
  /** The composite export sent the room empty: only added objects are asked about. */
  room?: NonNullable<FluxCheckScene['room']>,
): FluxCheckScene | undefined {
  if (!scene?.fixtures.length) return;
  return {
    version: 1,
    fixtures: room ? [] : scene.fixtures.map(({ kind, box, face }) => ({ kind, box, face })),
    ...(walls.length ? { walls: [...walls] } : {}),
    ...(room ? { room } : {}),
  };
}
const checkResponse = z.object({
  fixtures: z.array(
    z.object({
      index: z.number().int().positive(),
      kind: z.enum(FLUX_FIXTURE_KINDS),
      present: z.enum(['yes', 'no', 'unsure']),
      seenAs: z.enum(FLUX_CHECK_SEEN),
    }),
  ),
  // An older server answers without these; the result is then simply not checked for them.
  extras: z.array(z.object({ kind: z.enum(FLUX_EXTRA_KINDS), place: z.enum(FLUX_EXTRA_PLACES) })).optional(),
  walls: z
    .array(z.object({ face: z.enum(FLUX_CHECK_WALLS), uniformTiles: z.enum(['yes', 'no', 'unsure']) }))
    .optional(),
});
/**
 * Asks once whether each placed fixture still appears in a FLUX result (Gemma on the server). The
 * result is sent as a JPEG: the check reads objects, not fine texture. No automatic retry.
 */
export async function requestFluxCheck(
  result: Blob,
  scene: FluxCheckScene,
  signal: AbortSignal,
  userId?: string | null,
): Promise<FluxCheckResult> {
  const bitmap = await createImageBitmap(result);
  let image: Blob;
  try {
    const scale = Math.min(1, FLUX_CHECK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('설비 확인용 이미지를 만들지 못했어요.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    image = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('설비 확인용 이미지를 만들지 못했어요.'))),
        'image/jpeg',
        0.9,
      ),
    );
  } finally {
    bitmap.close();
  }
  const form = new FormData();
  form.set('image', image, 'result.jpg');
  form.set('scene', JSON.stringify(scene));
  const response = await fetch('/api/export/photoreal/check', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    signal,
    headers: userId ? { 'X-SJN-User-Id': userId } : {},
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.error || '설비 확인에 실패했어요. 자동 재시도하지 않았어요.');
  }
  const body = checkResponse.safeParse(await response.json().catch(() => null));
  if (!body.success || body.data.fixtures.length !== scene.fixtures.length)
    throw new Error('설비 확인 응답이 올바르지 않아요.');
  const { fixtures, extras, walls } = body.data;
  // Wall answers count only when they are exactly the walls asked about.
  const asked = scene.walls ?? [];
  const wallsMatch =
    !!walls && walls.length === asked.length && asked.every((face) => walls.some((w) => w.face === face));
  return { fixtures, ...(extras ? { extras } : {}), ...(wallsMatch && asked.length ? { walls } : {}) };
}
