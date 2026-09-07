'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { getRepositories } from '@/lib/repositories';
import type { AssetRecord } from '@/lib/types';

export function useAsset(assetId?: string) {
  const [state, setState] = useState<{ asset?: AssetRecord; url?: string; loading: boolean; error?: string }>(
    { loading: !!assetId },
  );
  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    setState({ loading: !!assetId });
    if (assetId) {
      Promise.resolve(getRepositories())
        .then((repos) => repos.assets.get(assetId))
        .then((asset) => {
          if (!alive) return;
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
  }, [assetId]);
  return state;
}

export function AssetImage({
  assetId,
  alt,
  className,
  style,
}: {
  assetId?: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { url, loading, error } = useAsset(assetId);
  if (!url)
    return (
      <span
        className={className}
        style={{ display: 'grid', placeItems: 'center', color: '#88897f', background: '#f2f2ed', ...style }}
        role="img"
        aria-label={alt}
      >
        {loading ? '불러오는 중' : error ? '이미지 없음' : '사진 등록'}
      </span>
    );
  // Local object URLs retain original image fidelity without a remote image optimizer.
  return <img className={className} src={url} alt={alt} style={style} draggable={false} />;
}
