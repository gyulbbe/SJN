'use client';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { useCachedDesignThumbnail, type ThumbnailIdentity } from './use-design-preview';
export default function SummaryDesignThumbnail({
  fallback,
  alt,
  className,
  ...identity
}: ThumbnailIdentity & {
  fallback: ReactNode;
  alt: string;
  className?: string;
}) {
  const url = useCachedDesignThumbnail(identity);
  return url ? (
    <Image unoptimized src={url} alt={alt} width={360} height={240} className={className} />
  ) : (
    fallback
  );
}
