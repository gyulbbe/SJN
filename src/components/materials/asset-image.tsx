'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useRepositories } from '@/components/repository-context';
import { isImageAsset, type ImageAssetRecord } from '@/lib/types';
import { useVisible } from './use-material-pages';

export function useAsset(assetId?: string) {
  const repositories = useRepositories();
  const [state, setState] = useState<{
    asset?: ImageAssetRecord;
    url?: string;
    loading: boolean;
    error?: string;
  }>({ loading: !!assetId });
  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    setState({ loading: !!assetId });
    if (assetId) {
      Promise.resolve(repositories)
        .then((repos) => repos.assets.get(assetId))
        .then((asset) => {
          if (!alive) return;
          if (!isImageAsset(asset)) throw new Error('입체 데이터는 사진 미리보기로 열 수 없어요.');
          objectUrl = URL.createObjectURL(asset.blob);
          setState({ asset, url: objectUrl, loading: false });
        })
        .catch((error) => {
          if (alive)
            setState({
              loading: false,
              error: error instanceof Error ? error.message : '이미지를 열지 못했어요.',
            });
        });
    }
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, repositories]);
  return state;
}

export function AssetImage({
  assetId,
  alt,
  className,
  style,
  lazy = false,
}: {
  assetId?: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  /** Read the image only once it is on screen (list cards); it stays loaded after that. */
  lazy?: boolean;
}) {
  const placeholder = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(!lazy);
  useVisible(placeholder, () => setSeen(true), { enabled: !seen });
  const { url, loading, error } = useAsset(seen ? assetId : undefined);
  if (!url)
    return (
      <span
        ref={placeholder}
        className={className}
        style={{ display: 'grid', placeItems: 'center', color: '#88897f', background: '#f2f2ed', ...style }}
        role="img"
        aria-label={alt}
      >
        {loading || (!seen && assetId) ? '불러오는 중' : error ? '이미지 없음' : '사진 등록'}
      </span>
    );
  // Local object URLs retain original image fidelity without a remote image optimizer.
  return <img className={className} src={url} alt={alt} style={style} draggable={false} />;
}
