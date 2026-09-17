'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useAccess } from '@/components/app-provider';
import Editor from '@/components/editor/editor';
import { RepositoryProvider, AdminProjectScopeProvider } from '@/components/repository-context';
import { createAdminProjectRepositories, loadAdminProject } from '@/lib/admin/project-repository';
import type { AdminProjectDetail } from '@/lib/admin/contracts';
export default function AdminProjectEditor({ id }: { id: string }) {
  const { userId } = useAccess();
  const repositories = useMemo(
    () => (userId ? createAdminProjectRepositories(id, userId) : null),
    [id, userId],
  );
  const [detail, setDetail] = useState<AdminProjectDetail>(),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setDetail(undefined);
    setError('');
    void loadAdminProject(id, userId)
      .then((value) => {
        if (alive) setDetail(value);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '프로젝트를 불러오지 못했어요.');
      });
    return () => {
      alive = false;
    };
  }, [id, userId, attempt]);
  const context = useMemo(
    () => (detail && userId ? { actorUserId: userId, owner: detail.owner } : undefined),
    [detail, userId],
  );
  if (error)
    return (
      <main className="auth-page">
        <div className="panel auth-card">
          <h1>프로젝트를 열지 못했어요</h1>
          <p role="alert">{error}</p>
          <button className="btn" onClick={() => setAttempt((v) => v + 1)}>
            다시 시도
          </button>
          <Link href="/admin/projects">전체 프로젝트로</Link>
        </div>
      </main>
    );
  if (!repositories || !context) return <p role="status">프로젝트와 소유자를 확인하고 있어요…</p>;
  return (
    <AdminProjectScopeProvider value={JSON.stringify(['admin', userId, id])}>
      <RepositoryProvider value={repositories}>
        <Editor key={`${userId}:${id}`} id={id} adminContext={context} />
      </RepositoryProvider>
    </AdminProjectScopeProvider>
  );
}
