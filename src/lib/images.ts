import type { AssetRecord } from './types';
import type { AssetRepository } from './repositories/contracts';

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const PREVIEW_EDGE = 2048;

export type ImageHeader = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; width: number; height: number };

/** Read dimensions before decoding, so an oversized compressed image is rejected early. */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  let header: ImageHeader | undefined;
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    text(1, 3) === 'PNG' &&
    bytes[4] === 13 &&
    bytes[5] === 10 &&
    bytes[6] === 26 &&
    bytes[7] === 10 &&
    text(12, 4) === 'IHDR'
  ) {
    header = { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 255) break;
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        header = {
          mime: 'image/jpeg',
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const chunk = text(12, 4);
    if (chunk === 'VP8X') {
      header = {
        mime: 'image/webp',
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    } else if (chunk === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      header = {
        mime: 'image/webp',
        width: view.getUint16(26, true) & 16383,
        height: view.getUint16(28, true) & 16383,
      };
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      header = {
        mime: 'image/webp',
        width: 1 + bytes[21] + ((bytes[22] & 63) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10),
      };
    }
  }
  if (!header || header.width < 1 || header.height < 1)
    throw new Error('올바른 JPG, PNG, WebP 이미지인지 확인해 주세요.');
  if (header.width * header.height > MAX_IMAGE_PIXELS)
    throw new Error('이미지는 4,000만 화소 이하로 줄여 주세요.');
  return header;
}

export function previewDimensions(width: number, height: number, maxEdge = PREVIEW_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function canvasBlob(canvas: HTMLCanvasElement, mime = 'image/png', quality = 0.94): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('이미지 변환에 실패했어요. 다시 시도해 주세요.'))),
      mime,
      quality,
    ),
  );
}

export async function makeAsset(
  blob: Blob,
  name: string,
  kind: AssetRecord['kind'],
  sourceAssetId?: string,
): Promise<AssetRecord> {
  const bitmap = await createImageBitmap(blob);
  const asset: AssetRecord = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name,
    mime: blob.type || 'image/png',
    size: blob.size,
    width: bitmap.width,
    height: bitmap.height,
    kind,
    sourceAssetId,
    createdAt: new Date().toISOString(),
    blob,
  };
  bitmap.close();
  return asset;
}

export async function importImage(
  file: File,
  kind: AssetRecord['kind'],
  assets: AssetRepository,
): Promise<{ original: AssetRecord; preview: AssetRecord }> {
  if (file.size === 0) throw new Error('빈 파일은 등록할 수 없어요.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('이미지 한 장은 25MB 이하로 올려 주세요.');
  const header = readImageHeader(new Uint8Array(await file.arrayBuffer()));
  if (file.type && file.type !== header.mime && file.type !== 'application/octet-stream')
    throw new Error('파일 내용과 확장자 형식이 달라요. JPG, PNG 또는 WebP로 다시 저장해 주세요.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('이 이미지를 열 수 없어요. 파일이 손상되지 않았는지 확인해 주세요.');
  }
  try {
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS)
      throw new Error('이미지는 4,000만 화소 이하로 줄여 주세요.');
    const original: AssetRecord = {
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: file.name,
      mime: header.mime,
      size: file.size,
      width: bitmap.width,
      height: bitmap.height,
      kind: 'original',
      createdAt: new Date().toISOString(),
      blob: new Blob([file], { type: header.mime }),
    };
    const size = previewDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이 브라우저에서 이미지 편집을 지원하지 않아요.');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvasBlob(canvas, header.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png');
    const preview: AssetRecord = {
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: `${file.name} · 편집용`,
      mime: blob.type,
      size: blob.size,
      width: size.width,
      height: size.height,
      kind: kind === 'original' ? 'preview' : kind,
      sourceAssetId: original.id,
      createdAt: new Date().toISOString(),
      blob,
    };
    await assets.put(original);
    await assets.put(preview);
    return { original, preview };
  } finally {
    bitmap.close();
  }
}
