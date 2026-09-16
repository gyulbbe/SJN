'use client';
import Image from 'next/image';
import { useEffect, useState, type ReactNode } from 'react';
import type { Repositories } from '@/lib/repositories/contracts';
import { DesignPreviewCancelled } from '@/lib/render/design-preview';
import { prepareSummaryRoomThumbnail } from '@/lib/render/summary-design-preview';
import { useCachedDesignThumbnail, type ThumbnailIdentity } from './use-design-preview';
export default function SummaryDesignThumbnail({
  fallback,
  alt,
  className,
  repositories,
  ...source
}: ThumbnailIdentity & {
  fallback: ReactNode;
  alt: string;
  className?: string;
  repositories?: Repositories;
}) {
  const identity = { ...source, designId: source.designId ?? (source.contextKey ? 'baseline' : undefined) };
  const url = useCachedDesignThumbnail(identity);
  const [failedKey, setFailedKey] = useState<string>();
  const key = JSON.stringify(identity);
  const { projectId, designId, revision, sharedRevision, contextKey } = identity;
  useEffect(() => {
    if (
      url ||
      !contextKey ||
      !repositories ||
      !designId ||
      revision === undefined ||
      sharedRevision === undefined
    )
      return;
    const controller = new AbortController();
    void prepareSummaryRoomThumbnail(
      repositories,
      { projectId, designId, revision, sharedRevision, contextKey },
      controller.signal,
    ).catch((error) => {
      if (!controller.signal.aborted && !(error instanceof DesignPreviewCancelled)) setFailedKey(key);
    });
    return () => controller.abort();
  }, [url, projectId, designId, revision, sharedRevision, contextKey, repositories, key]);
  if (url) return <Image src={url} unoptimized alt={alt} width={360} height={240} className={className} />;
  // A flat source photo cannot stand in for the geometry image while its cache is empty.
  return contextKey ? (
    <span role="status" className={className}>
      {failedKey === key ? '공간 미리보기를 불러오지 못했어요' : '공간 미리보기 준비 중'}
    </span>
  ) : (
    fallback
  );
}
