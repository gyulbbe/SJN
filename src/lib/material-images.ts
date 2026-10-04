import { readProductDirection, suitingDirection, type ProductDirection } from './product-direction';
import type { RoomFace } from './room-types';
import type { MaterialInput, MaterialVersion } from './types';

type MaterialImages = Pick<
  MaterialVersion,
  'category' | 'views' | 'textureAssetIds' | 'coverAssetId' | 'imageAssetIds'
>;
const FRONT_NAMES = new Set(['정면', 'front', 'frontal']);

/** Only exact names designate a front photo; e.g. "정면 30도" remains a separate angle. */
export function getPreferredProductViewIndex(material: Pick<MaterialVersion, 'views'>): number {
  const front = material.views.findIndex((view) =>
    FRONT_NAMES.has(view.direction.trim().normalize('NFKC').toLowerCase()),
  );
  return front >= 0 ? front : material.views.length ? 0 : -1;
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
    const index = material.views.findIndex((view) => readProductDirection(view.direction).name === wanted);
    if (index >= 0) return { index };
  }
  return { index: getPreferredProductViewIndex(material), ...(wanted ? { missing: wanted } : {}) };
}

/** Catalog/usage preview policy. Never use this to rewrite an existing fixture's saved viewIndex. */
export function getMaterialImageAssetId(material?: MaterialImages | null): string | undefined {
  if (!material) return undefined;
  if (material.category === 'tile') {
    if (material.textureAssetIds.length) return material.textureAssetIds[0];
  } else if (material.views.length) {
    return material.views[getPreferredProductViewIndex(material)]?.assetId;
  }
  return material.coverAssetId || material.imageAssetIds?.[0];
}

/** New versions need no separate cover/gallery. Keep legacy-only images until a real placement image exists. */
export function stripLegacyMaterialImages<T extends MaterialInput>(input: T): T {
  const hasPlacementImage =
    input.category === 'tile' ? input.textureAssetIds.length > 0 : input.views.length > 0;
  if (!hasPlacementImage) return { ...input };
  const copy = { ...input };
  delete copy.coverAssetId;
  delete copy.imageAssetIds;
  return copy;
}
