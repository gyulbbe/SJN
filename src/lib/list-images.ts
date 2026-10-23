import { canvasBlob } from './images';
import { StorageConflictError } from './repositories/references';
import type { AssetRepository, MaterialRepository } from './repositories/contracts';
import type { ImageAssetRecord } from './types';
import { LIST_IMAGE_EDGE } from './d1/list-images';

/**
 * List images: the small copy of a material card's image (docs/list-thumbnails-results-20261023.md).
 * The server keeps one per source image (`src/lib/d1/list-images.ts`) and sends it when a card asks
 * for the source with `size=list`.
 */

/** The image scaled down to LIST_IMAGE_EDGE on its long side (never up), as WebP. */
export async function makeListImage(source: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, LIST_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)),
      height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이 브라우저에서 이미지 편집을 지원하지 않아요.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    // A browser that cannot write WebP gives PNG, which the server also takes.
    return { blob: await canvasBlob(canvas, 'image/webp', 0.82), width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * Makes and uploads the list image of `sourceId` (from `source`, or the image read again). 'exists'
 * when the source already has one (the server keeps one per source).
 */
export async function saveListImage(
  assets: AssetRepository,
  sourceId: string,
  source?: Blob,
): Promise<'made' | 'exists'> {
  const made = await makeListImage(source ?? (await assets.get(sourceId)).blob);
  const asset: ImageAssetRecord = {
    id: crypto.randomUUID(),
    ownerId: 'local',
    name: '목록 이미지.' + (made.blob.type === 'image/webp' ? 'webp' : 'png'),
    mime: made.blob.type,
    size: made.blob.size,
    width: made.width,
    height: made.height,
    kind: 'thumbnail',
    sourceAssetId: sourceId,
    derivation: 'list',
    createdAt: new Date().toISOString(),
    blob: made.blob,
  };
  try {
    await assets.put(asset);
    return 'made';
  } catch (error) {
    if (error instanceof StorageConflictError) return 'exists';
    throw error;
  }
}

/** The record a repository returns for a list image read (cards only use its bytes). */
export function listImageRecord(id: string, blob: Blob): ImageAssetRecord {
  return {
    id,
    ownerId: '',
    name: '목록 이미지',
    mime: blob.type,
    size: blob.size,
    width: 0,
    height: 0,
    kind: 'thumbnail',
    createdAt: '',
    blob,
  };
}

/**
 * After a material is saved: give its card image a list image unless it has one. Never fails the
 * save (the administrator's backfill makes any that are missing).
 */
export async function ensureListImage(
  repositories: { assets: AssetRepository; materials: MaterialRepository },
  imageId: string | undefined,
): Promise<'made' | 'exists' | 'skipped'> {
  if (!imageId || !repositories.materials.listImages) return 'skipped';
  const answer = await repositories.materials.listImages({ ids: [imageId] });
  if ('listed' in answer && answer.listed.includes(imageId)) return 'exists';
  return saveListImage(repositories.assets, imageId);
}
