'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { AdminUser, UserRole, UserStatus } from '@/lib/admin/contracts';
import { useAccess } from '@/components/app-provider';
import { accountLabel } from '@/lib/auth/credential-account';
import AdminShell from './admin-shell';
import { adminRequest, AdminRequestError, useAdminPage } from './data';
import styles from './admin.module.css';

type Change = {
  user: AdminUser;
  kind: 'role' | 'status';
  value: UserRole | UserStatus;
  reason: string;
  key: string;
};
export default function AdminUsers() {
  const { userId } = useAccess();
  const [query, setQuery] = useState(''),
    [role, setRole] = useState(''),
    [status, setStatus] = useState(''),
    [revision, setRevision] = useState(0);
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (role) params.set('role', role);
  if (status) params.set('status', status);
  const { data, busy, error, more } = useAdminPage<AdminUser>(
    '/api/admin/users',
    params.toString(),
    revision,
  );
  const [change, setChange] = useState<Change>(),
    [saving, setSaving] = useState(false),
    [failure, setFailure] = useState(''),
    [notice, setNotice] = useState('');
  function open(user: AdminUser, kind: Change['kind']) {
    setChange({
      user,
      kind,
      value:
        kind === 'role'
          ? user.isAdmin
            ? 'member'
            : 'admin'
          : user.status === 'active'
            ? 'suspended'
            : 'active',
      reason: '',
      key: crypto.randomUUID(),
    });
    setFailure('');
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!change || !userId || saving) return;
    setSaving(true);
    setFailure('');
    try {
      await adminRequest('/api/admin/users', userId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': change.key },
        body: JSON.stringify({
          operation: change.kind === 'role' ? 'setRole' : 'setStatus',
          userId: change.user.id,
          expectedRevision: change.user.revision,
          ...(change.kind === 'role'
            ? { role: change.value }
            : { status: change.value, reason: change.reason.trim() }),
        }),
      });
      setNotice(`${change.user.name} 회원의 ${change.kind === 'role' ? '권한을' : '이용 상태를'} 변경했어요.`);
      setChange(undefined);
      setRevision((v) => v + 1);
      window.dispatchEvent(new Event('sjn-admin-role-changed'));
    } catch (e) {
      const message = e instanceof Error ? e.message : '변경하지 못했어요.';
      if (e instanceof AdminRequestError && e.status === 409) {
        setChange(undefined);
        setNotice(message + ' 목록을 새로 불러왔어요. 변경 내용을 다시 확인해 주세요.');
        setRevision((v) => v + 1);
      } else setFailure(message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <AdminShell title="회원 관리">
      <p>회원 권한과 이용 상태를 관리해요. 변경 전 대상 계정을 확인해 주세요.</p>
      <div className={styles.filters}>
        <label>
          회원 검색
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름, 이메일, 회원 ID"
          />
        </label>
        <label>
          권한
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">전체</option>
            <option value="admin">관리자</option>
            <option value="member">일반 회원</option>
          </select>
        </label>
        <label>
          이용 상태
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">전체</option>
            <option value="active">이용 중</option>
            <option value="suspended">정지</option>
          </select>
        </label>
        <button className="btn" onClick={() => setRevision((v) => v + 1)}>
          새로고침
        </button>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>회원</th>
              <th>권한·상태</th>
              <th>가입일</th>
              <th>프로젝트</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((user) => (
              <tr key={user.id}>
                <td>
                  {user.name}
                  <small>{accountLabel(user.email)}</small>
                  <small>{user.id}</small>
                  {user.id === userId && <small>내 계정</small>}
                </td>
                <td>
                  {user.isAdmin ? '관리자' : '일반 회원'} · {user.status === 'active' ? '이용 중' : '정지'}
                </td>
                <td>{new Date(user.createdAt).toLocaleDateString('ko-KR')}</td>
                <td>
                  <Link href={`/admin/projects?ownerId=${encodeURIComponent(user.id)}`}>
                    {user.projectCount}개 프로젝트
                  </Link>
                </td>
                <td>
                  <div className={styles.actions}>
                    <button
                      className="btn small"
                      aria-label={`${user.name} 권한 변경`}
                      onClick={() => open(user, 'role')}
                    >
                      권한 변경
                    </button>
                    <button
                      className="btn small"
                      aria-label={`${user.name} 이용 상태 변경`}
                      onClick={() => open(user, 'status')}
                    >
                      상태 변경
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {busy && <p role="status">회원을 불러오고 있어요…</p>}
      {!busy && !error && !data.items.length && <p>검색한 회원이 없어요.</p>}
      {data.nextCursor && (
        <button className="btn" disabled={busy} onClick={more}>
          다음 25명 더 보기
        </button>
      )}
      {change && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="회원 변경 확인">
          <form className={`modal-card ${styles.dialog}`} onSubmit={submit}>
            <h2>회원 {change.kind === 'role' ? '권한' : '상태'} 변경</h2>
            <p>
              <strong>{change.user.name}</strong>
              <br />
              {accountLabel(change.user.email)}
              <br />
              {change.user.id}
            </p>
            <label>
              {change.kind === 'role' ? '변경할 권한' : '변경할 상태'}
              <select
                className="input"
                disabled={saving}
                value={change.value}
                onChange={(e) =>
                  setChange({ ...change, value: e.target.value as Change['value'], key: crypto.randomUUID() })
                }
              >
                {change.kind === 'role' ? (
                  <>
                    <option value="member">일반 회원</option>
                    <option value="admin">관리자</option>
                  </>
                ) : (
                  <>
                    <option value="active">이용 중</option>
                    <option value="suspended">정지</option>
                  </>
                )}
              </select>
            </label>
            {change.kind === 'status' && change.value === 'suspended' && (
              <label>
                정지 사유
                <textarea
                  className="input"
                  required
                  maxLength={500}
                  value={change.reason}
                  disabled={saving}
                  onChange={(e) => setChange({ ...change, reason: e.target.value, key: crypto.randomUUID() })}
                />
              </label>
            )}
            <p>
              관리자는 다른 회원의 프로젝트를 조회·수정할 수 있어요. 자기 계정 정지와 마지막 관리자 제거는
              허용되지 않아요.
            </p>
            {failure && <p role="alert">{failure}</p>}
            <div className={styles.actions}>
              <button className="btn" type="button" disabled={saving} onClick={() => setChange(undefined)}>
                취소
              </button>
              <button
                className="btn primary"
                disabled={
                  saving ||
                  (change.kind === 'status' && change.value === 'suspended' && !change.reason.trim())
                }
              >
                {saving ? '변경 중…' : '확인 후 변경'}
              </button>
            </div>
          </form>
        </div>
      )}
    </AdminShell>
  );
}
