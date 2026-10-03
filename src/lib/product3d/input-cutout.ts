import { defringeAlpha, foregroundBounds } from './pixels';
import type { ProductPhoto } from './photo-color';

/** The model's input is a picture of this many pixels on each side. */
export const INPUT_SIZE = 512;
/** The product fills this share of the picture's longer side (the model was trained on such framing). */
const FRAME = 0.85;

type Canvas = OffscreenCanvas | HTMLCanvasElement;
type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function canvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}
const context = (target: Canvas): Context => {
  const ctx = target.getContext('2d', { willReadFrequently: true }) as Context | null;
  if (!ctx) throw new Error('이 브라우저에서 이미지 준비 기능을 사용할 수 없어요.');
  return ctx;
};

/**
 * The product cut out of the input photo and placed in the model's 512 picture (transparent
 * around it): its bounds scaled to fill 0.85 of the longer side and centred, the cut-out's edge
 * cleaned so no grey halo is in the colours. The worker that builds the 3D model and the code that
 * puts the photo's colours on the result call this one, so the photo lies exactly where the model saw it.
 */
export function drawCutout(bitmap: ImageBitmap): Canvas {
  if (bitmap.width * bitmap.height > 40_000_000)
    throw new Error('제품 사진은 4,000만 화소 이하로 줄여 주세요.');
  const factor = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const scan = canvas(
    Math.max(1, Math.round(bitmap.width * factor)),
    Math.max(1, Math.round(bitmap.height * factor)),
  );
  const ctx = context(scan);
  ctx.drawImage(bitmap, 0, 0, scan.width, scan.height);
  const bounds = foregroundBounds(
    ctx.getImageData(0, 0, scan.width, scan.height).data,
    scan.width,
    scan.height,
  );
  const extent = Math.max(bounds.width, bounds.height) / FRAME;
  const width = (bounds.width / extent) * INPUT_SIZE;
  const height = (bounds.height / extent) * INPUT_SIZE;
  // Clean the cut-out edge on its own layer first so no grey halo is baked into the colours.
  const product = canvas(INPUT_SIZE, INPUT_SIZE);
  const item = context(product);
  item.imageSmoothingEnabled = true;
  item.imageSmoothingQuality = 'high';
  item.drawImage(
    bitmap,
    bounds.x / factor,
    bounds.y / factor,
    bounds.width / factor,
    bounds.height / factor,
    (INPUT_SIZE - width) / 2,
    (INPUT_SIZE - height) / 2,
    width,
    height,
  );
  const pixels = item.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  pixels.data.set(defringeAlpha(pixels.data, INPUT_SIZE, INPUT_SIZE, 1));
  item.putImageData(pixels, 0, 0);
  return product;
}

/** The input photo as the model saw it, without the grey backdrop: RGBA, straight alpha. */
export async function decodeProductPhoto(blob: Blob): Promise<ProductPhoto> {
  const bitmap = await createImageBitmap(blob);
  try {
    const data = context(drawCutout(bitmap)).getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    return { size: INPUT_SIZE, data };
  } finally {
    bitmap.close();
  }
}
