'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { AdminProjectSummary } from '@/lib/admin/contracts';
import AdminShell from './admin-shell';
import { useAdminPage } from './data';
import styles from './admin.module.css';
import { accountLabel } from '@/lib/auth/credential-account';
export default function AdminProjects({ initialOwnerId = '' }: { initialOwnerId?: string }) {
  const [query, setQuery] = useState(''),
    [ownerId, setOwnerId] = useState(initialOwnerId),
    [revision, setRevision] = useState(0),
    [notice, setNotice] = useState('');
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (ownerId.trim()) params.set('ownerId', ownerId.trim());
  const { data, busy, error, more } = useAdminPage<AdminProjectSummary>(
    '/api/admin/projects',
    params.toString(),
    revision,
  );
  return (
    <AdminShell title="전체 프로젝트">
      <p>소유자를 확인한 뒤 프로젝트를 조회·수정할 수 있어요. 삭제·복제·소유자 이전은 지원하지 않아요.</p>
      <div className={styles.filters}>
        <label>
          프로젝트 검색
          <input
            className="input"
            placeholder="프로젝트 이름·ID, 소유자 이름·이메일"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          소유자 ID
          <input
            className="input"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            placeholder="회원 ID로 필터"
          />
        </label>
        <button className="btn" onClick={() => setRevision((v) => v + 1)}>
          새로고침
        </button>
        {ownerId && (
          <button className="btn" onClick={() => setOwnerId('')}>
            소유자 필터 해제
          </button>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>프로젝트</th>
              <th>소유자</th>
              <th>수정일</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((project) => (
              <tr key={project.id}>
                <td>
                  {project.name}
                  <small>{project.id}</small>
                </td>
                <td>
                  {project.ownerName}
                  <small>{accountLabel(project.ownerEmail)}</small>
                  <small>{project.ownerId}</small>
                </td>
                <td>{new Date(project.updatedAt).toLocaleString('ko-KR')}</td>
                <td>
                  <div className={styles.actions}>
                    <Link className="btn small" href={`/admin/projects/${encodeURIComponent(project.id)}`}>
                      조회·수정
                    </Link>
                    <button
                      className="btn small"
                      aria-label={`${project.name} ID 복사`}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(project.id);
                          setNotice('프로젝트 ID를 복사했어요.');
                        } catch {
                          setNotice('복사하지 못했어요. 표시된 프로젝트 ID를 직접 선택해 복사해 주세요.');
                        }
                      }}
                    >
                      ID 복사
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {busy && <p role="status">프로젝트를 불러오고 있어요…</p>}
      {!busy && !error && !data.items.length && <p>검색한 프로젝트가 없어요.</p>}
      {data.nextCursor && (
        <button className="btn" disabled={busy} onClick={more}>
          다음 25개 더 보기
        </button>
      )}
    </AdminShell>
  );
}
