import { z } from 'zod';
import { categoryLabels, type MaterialCategory, type MaterialVersion } from '../types';

const id = z.string().uuid();
const point = z
  .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
  .strict();
export const publicPlacementImageSchema = z
  .object({
    id,
    url: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    size: z
      .number()
      .int()
      .positive()
      .max(25 * 1024 * 1024),
    kind: z.enum(['texture', 'product', 'preview']),
  })
  .strict()
  .refine((image) => image.url === '/api/catalog/images?id=' + encodeURIComponent(image.id), {
    message: '공용 이미지 경로를 확인해 주세요.',
  });
export type PublicPlacementImage = z.infer<typeof publicPlacementImageSchema>;

/** Only the current catalog version's placement data; no ownership or source/mesh references. */
export const publicPlacementSchema = z
  .object({
    materialId: id,
    versionId: id,
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    brand: z.string().max(200),
    code: z.string().max(200),
    category: z.enum(Object.keys(categoryLabels) as [MaterialCategory, ...MaterialCategory[]]),
    description: z.string().max(10000),
    color: z.string().max(2100),
    finish: z.string().max(2100),
    composition: z.string().max(2100).optional(),
    subcategoryName: z.string().max(100).optional(),
    widthMm: z.number().finite().positive().max(100000),
    heightMm: z.number().finite().positive().max(100000),
    depthMm: z.number().finite().nonnegative().max(100000),
    usage: z.enum(['wall', 'floor', 'both']),
    installation: z.enum(['floor', 'wall', 'embedded', 'suspended']),
    textureAssetIds: z.array(id).max(100),
    views: z
      .array(z.object({ assetId: id, direction: z.string().max(200), anchor: point }).strict())
      .max(100),
    coverAssetId: id.optional(),
    imageAssetIds: z.array(id).max(100).optional(),
    defaultGroutWidth: z.number().finite().min(0).max(100),
    defaultGroutColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    defaultPattern: z.enum(['grid', 'brick']),
    images: z.array(publicPlacementImageSchema).min(1).max(200),
  })
  .strict()
  .superRefine((dto, context) => {
    const imageIds = new Set(dto.images.map((image) => image.id));
    const references = new Set([
      ...dto.textureAssetIds,
      ...dto.views.map((view) => view.assetId),
      ...(dto.coverAssetId ? [dto.coverAssetId] : []),
      ...(dto.imageAssetIds ?? []),
    ]);
    if (
      imageIds.size !== dto.images.length ||
      imageIds.size !== references.size ||
      [...references].some((imageId) => !imageIds.has(imageId))
    ) {
      context.addIssue({ code: 'custom', message: '공용 자재의 표시 이미지 연결을 확인해 주세요.' });
    }
  });
export type PublicPlacement = z.infer<typeof publicPlacementSchema>;

/** Adapt the public projection for renderers, never for registering a material. */
export function placementToMaterialVersion(dto: PublicPlacement): MaterialVersion {
  return {
    id: dto.versionId,
    materialId: dto.materialId,
    version: dto.version,
    name: dto.name,
    brand: dto.brand,
    code: dto.code,
    category: dto.category,
    scope: 'shared',
    description: dto.description,
    color: dto.color,
    finish: dto.finish,
    composition: dto.composition,
    subcategoryName: dto.subcategoryName,
    widthMm: dto.widthMm,
    heightMm: dto.heightMm,
    depthMm: dto.depthMm,
    usage: dto.usage,
    installation: dto.installation,
    textureAssetIds: [...dto.textureAssetIds],
    views: dto.views.map((view) => ({
      assetId: view.assetId,
      direction: view.direction,
      anchor: { x: view.anchor.x, y: view.anchor.y },
    })),
    ...(dto.coverAssetId ? { coverAssetId: dto.coverAssetId } : {}),
    ...(dto.imageAssetIds?.length ? { imageAssetIds: [...dto.imageAssetIds] } : {}),
    defaultGroutWidth: dto.defaultGroutWidth,
    defaultGroutColor: dto.defaultGroutColor,
    defaultPattern: dto.defaultPattern,
    createdAt: '',
  };
}
