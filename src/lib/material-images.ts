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
