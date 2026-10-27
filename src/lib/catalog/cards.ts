import { getMaterialImageAssetId } from '@/lib/material-images';
import { isRetiredDirection } from '@/lib/product-direction';
import type { Material, MaterialCategory, MaterialVersion } from '@/lib/types';

/**
 * What a member list card shows (editor drawer, administrator library). The whole version is read
 * only when a card is picked (`getVersions`).
 */
export type MaterialCard = {
  materialId: string;
  versionId: string;
  version: number;
  ownerId: string;
  /** The material's scope (library badge); `versionScope` is the version's own (editor card). */
  scope: Material['scope'];
  versionScope: MaterialVersion['scope'];
  active: boolean;
  updatedAt: string;
  name: string;
  brand: string;
  code: string;
  category: MaterialCategory;
  usage: MaterialVersion['usage'];
  widthMm: number;
  heightMm: number;
  depthMm: number;
  color: string;
  finish: string;
  imageAssetId?: string;
  textureCount: number;
  /** Direction photos shown (a retired 위·아래 photo is left out). */
  viewCount: number;
};

export function materialCard(material: Material, version: MaterialVersion): MaterialCard {
  const imageAssetId = getMaterialImageAssetId(version);
  return {
    materialId: material.id,
    versionId: version.id,
    version: version.version,
    ownerId: material.ownerId,
    scope: material.scope,
    versionScope: version.scope,
    active: material.active,
    updatedAt: material.updatedAt,
    name: version.name,
    brand: version.brand,
    code: version.code,
    category: version.category,
    usage: version.usage,
    widthMm: version.widthMm,
    heightMm: version.heightMm,
    depthMm: version.depthMm,
    color: version.color,
    finish: version.finish,
    ...(imageAssetId ? { imageAssetId } : {}),
    textureCount: version.textureAssetIds.length,
    viewCount: version.views.filter((view) => !isRetiredDirection(view.direction)).length,
  };
}

/** The material record a card stands for (what the old full list returned beside each version). */
export const cardMaterial = (card: MaterialCard): Material => ({
  id: card.materialId,
  ownerId: card.ownerId,
  currentVersionId: card.versionId,
  active: card.active,
  scope: card.scope,
  updatedAt: card.updatedAt,
});
