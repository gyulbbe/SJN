import { getRepositories } from '../repositories';
import type { AssetRepository } from '../repositories/contracts';
import type { ImageAssetRecord } from '../types';

/** Only unedited upload previews are replaced by their full-resolution original. */
export async function resolveBackgroundRemovalInput(
  assetId: string,
  assets: Pick<AssetRepository, 'get'> = getRepositories().assets,
): Promise<{ asset: ImageAssetRecord; sourceLabel: string }> {
  const selected = await assets.get(assetId);
  if (selected.kind === 'product-mesh') throw new Error('배경 제거에는 제품 사진이 필요해요.');
  if (selected.kind === 'original') return { asset: selected, sourceLabel: '업로드 원본' };
  if (selected.derivation === 'ai-product3d')
    return { asset: selected, sourceLabel: '360° 편집으로 만든 제품 사진' };
  if (selected.derivation === 'ai-multiview')
    return { asset: selected, sourceLabel: 'AI로 생성한 방향 사진' };
  if (selected.derivation === 'ai-alpha')
    return { asset: selected, sourceLabel: 'AI 배경 제거를 적용한 사진' };
  if (selected.derivation === 'manual-alpha')
    return { asset: selected, sourceLabel: '수동 배경 지우기를 적용한 사진' };
  if (selected.derivation === 'rectified') return { asset: selected, sourceLabel: '보정한 사진' };
  if (selected.sourceAssetId) {
    let original: ImageAssetRecord | undefined;
    try {
      const linked = await assets.get(selected.sourceAssetId);
      if (linked.kind !== 'product-mesh') original = linked;
    } catch {
      if (selected.derivation === 'upload-preview')
        throw new Error('업로드 원본을 찾을 수 없어요. 제품 방향 사진을 다시 올려 주세요.');
    }
    if (
      original?.kind === 'original' &&
      (selected.derivation === 'upload-preview' ||
        (!selected.derivation && selected.name === `${original.name} · 편집용`))
    )
      return { asset: original, sourceLabel: '업로드 원본' };
    if (selected.derivation === 'upload-preview')
      throw new Error('업로드 원본 연결을 확인할 수 없어요. 제품 방향 사진을 다시 올려 주세요.');
  } else if (selected.derivation === 'upload-preview') {
    throw new Error('업로드 원본 연결이 없어요. 제품 방향 사진을 다시 올려 주세요.');
  }
  // Older edited assets have no derivation marker. Keep their existing alpha and pixels.
  return { asset: selected, sourceLabel: '선택한 사진' };
}
