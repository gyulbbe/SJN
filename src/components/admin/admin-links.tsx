'use client';
import Link from 'next/link';
import { useSharedCatalogAdmin } from '@/components/materials/shared-access';

export default function AdminLinks({ className }: { className?: string }) {
  const admin = useSharedCatalogAdmin();
  if (!admin) return null;
  return (
    <>
      <Link className={className} href="/admin/users">
        회원 관리
      </Link>
      <Link className={className} href="/admin/projects">
        전체 프로젝트
      </Link>
    </>
  );
}
