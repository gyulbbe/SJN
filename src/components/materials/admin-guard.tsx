'use client';
import Link from 'next/link';
import { useAccess } from '../app-provider';
import { useSharedCatalogAdmin } from './shared-access';
export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const access = useAccess(),
    admin = useSharedCatalogAdmin();
  if (access.ready && !!access.userId && admin) return <>{children}</>;
  return (
    <main className="auth-page">
      <div className="panel auth-card">
        <h1>관리자 전용</h1>
        <p>관리자 계정으로 로그인해야 사용할 수 있어요.</p>
        <Link className="btn" href="/materials">
          자재 둘러보기
        </Link>
        <Link className="btn primary" href="/login">
          로그인
        </Link>
      </div>
    </main>
  );
}
