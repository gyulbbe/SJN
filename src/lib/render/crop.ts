import type { Quad } from '../types';
import { homography, transformPoint, fitOutput } from './math';

/** Rectify a photographed tile. Four source points are normalized, ordered around the perimeter. */
export async function rectifyImage(
  blob: Blob,
  quad: Quad,
  targetWidth: number,
  targetHeight: number,
): Promise<Blob> {
  const size = fitOutput(targetWidth, targetHeight, 2048);
  const map = homography(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    quad,
  );
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const source = document.createElement('canvas');
    source.width = bitmap.width;
    source.height = bitmap.height;
    const ctx = source.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('타일 이미지를 읽지 못했습니다.');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, source.width, source.height).data;
    const dest = document.createElement('canvas');
    dest.width = size.width;
    dest.height = size.height;
    const out = dest.getContext('2d');
    if (!out) throw new Error('타일 보정 이미지를 생성하지 못했습니다.');
    const result = out.createImageData(dest.width, dest.height);
    for (let y = 0; y < dest.height; y++)
      for (let x = 0; x < dest.width; x++) {
        const p = transformPoint(map, { x: (x + 0.5) / dest.width, y: (y + 0.5) / dest.height });
        const sx = Math.max(0, Math.min(source.width - 1, p.x * source.width - 0.5)),
          sy = Math.max(0, Math.min(source.height - 1, p.y * source.height - 0.5));
        const x0 = Math.floor(sx),
          y0 = Math.floor(sy),
          x1 = Math.min(source.width - 1, x0 + 1),
          y1 = Math.min(source.height - 1, y0 + 1),
          fx = sx - x0,
          fy = sy - y0;
        for (let c = 0; c < 4; c++)
          result.data[(y * dest.width + x) * 4 + c] =
            data[(y0 * source.width + x0) * 4 + c] * (1 - fx) * (1 - fy) +
            data[(y0 * source.width + x1) * 4 + c] * fx * (1 - fy) +
            data[(y1 * source.width + x0) * 4 + c] * (1 - fx) * fy +
            data[(y1 * source.width + x1) * 4 + c] * fx * fy;
      }
    out.putImageData(result, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      dest.toBlob((v) => (v ? resolve(v) : reject(new Error('타일 저장에 실패했습니다.'))), 'image/png'),
    );
  } finally {
    bitmap.close();
  }
}
