import {
  isRetiredDirection,
  suitingDirection,
  viewDirection,
  type ProductDirection,
} from './product-direction';
import type { RoomFace } from './room-types';
import type { MaterialInput, MaterialVersion } from './types';

type MaterialImages = Pick<
  MaterialVersion,
  'category' | 'views' | 'textureAssetIds' | 'coverAssetId' | 'imageAssetIds'
>;
const FRONT_NAMES = new Set(['정면', 'front', 'frontal']);

/**
 * Only exact names designate a front photo; e.g. "정면 30도" remains a separate angle. Without one it
 * is the first photo that is not a retired 위·아래 one (those are never a direction photo), or none.
 */
export function getPreferredProductViewIndex(material: Pick<MaterialVersion, 'views'>): number {
  const front = material.views.findIndex((view) =>
    FRONT_NAMES.has(view.direction.trim().normalize('NFKC').toLowerCase()),
  );
  if (front >= 0) return front;
  return material.views.findIndex((view) => !isRetiredDirection(view.direction));
}

/**
 * The photo to place a product with on `face`: the one whose angle name suits the face (왼쪽 벽
 * → 오른쪽, 오른쪽 벽 → 왼쪽, 정면 벽 → 정면, see suitingDirection), else the usual one (정면 first,
 * then the first photo) with `missing` saying which name was wanted. The floor takes any, so it
 * keeps the usual one. Only the first placement and a face change use this; a saved fixture's
 * viewIndex is never rewritten from it.
 */
export function getPlacementViewIndex(
  material: Pick<MaterialVersion, 'views'>,
  face: RoomFace,
): { index: number; missing?: ProductDirection } {
  const wanted = suitingDirection(face);
  if (wanted) {
    const index = material.views.findIndex((view) => viewDirection(view.direction) === wanted);
    if (index >= 0) return { index };
  }
  return { index: getPreferredProductViewIndex(material), ...(wanted ? { missing: wanted } : {}) };
}

/**
 * The picture that stands for a material in the lists, the catalog and the usage panel. A tile shows
 * its first texture. A product shows its 대표 이미지 (`coverAssetId`, optional) when there is one,
 * else its 정면 photo, else its first direction photo; a retired 위·아래 photo is never used. Never
 * use this to rewrite an existing fixture's saved viewIndex.
 */
export function getMaterialImageAssetId(material?: MaterialImages | null): string | undefined {
  if (!material) return undefined;
  if (material.category === 'tile') {
    if (material.textureAssetIds.length) return material.textureAssetIds[0];
  } else {
    if (material.coverAssetId) return material.coverAssetId;
    const index = getPreferredProductViewIndex(material);
    if (index >= 0) return material.views[index]?.assetId;
  }
  return material.coverAssetId || material.imageAssetIds?.[0];
}

/**
 * What a new version keeps of the older fields. The old photo gallery (`imageAssetIds`) is not
 * kept once there is a placement image. The 대표 이미지 (`coverAssetId`) stays for a product and is
 * dropped for a tile, and a retired 위·아래 photo is left out of a saved version (it was never shown
 * as a direction photo; a stored version that has one keeps it until its material is saved again).
 * Legacy-only images stay until a real placement image exists.
 */
export function stripLegacyMaterialImages<T extends MaterialInput>(input: T): T {
  const views = input.views.filter((view) => !isRetiredDirection(view.direction));
  const hasPlacementImage = input.category === 'tile' ? input.textureAssetIds.length > 0 : views.length > 0;
  const copy = { ...input, views };
  if (input.category === 'tile') delete copy.coverAssetId;
  if (hasPlacementImage) delete copy.imageAssetIds;
  return copy;
}
