import { getRepositories } from '../repositories';
import type { AssetRepository } from '../repositories/contracts';
import { resolveBackgroundRemovalInput } from '../background-removal/source';
import type { Product3dReference } from './state-types';
import type { ProductInput } from './types';
export async function resolveProductInput(
  assetId: string,
  reference?: Product3dReference,
  blob?: Blob,
  assets: Pick<AssetRepository, 'get'> = getRepositories().assets,
): Promise<ProductInput> {
  let asset = await assets.get(reference?.inputAssetId ?? assetId);
  if (asset.kind === 'product-mesh') throw new Error('제품 원본 사진 연결이 올바르지 않아요.');
  if (blob) return { blob, name: asset.name, sourceAssetId: asset.id };
  const visited = new Set<string>();
  while (asset.derivation === 'ai-multiview' || asset.derivation === 'ai-product3d') {
    if (!asset.sourceAssetId || visited.has(asset.id))
      throw new Error('이전 생성 사진의 원본을 찾을 수 없어요. 제품 사진을 다시 올려 주세요.');
    visited.add(asset.id);
    const next = await assets.get(asset.sourceAssetId);
    if (next.kind === 'product-mesh') throw new Error('제품 원본 연결이 올바르지 않아요.');
    asset = next;
  }
  const resolved = await resolveBackgroundRemovalInput(asset.id, assets);
  return {
    blob: resolved.asset.blob,
    name: resolved.asset.name,
    sourceAssetId: resolved.asset.id,
    existingAssetId: resolved.asset.id,
  };
}
