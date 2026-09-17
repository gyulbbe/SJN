'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { useAccess } from '@/components/app-provider';

export default function LoginPage() {
  const access = useAccess();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Better Auth appends the provider's `error` to our errorCallbackURL.
    // Show our own message, never the provider's raw error_description.
    if (params.get('error') === 'account_suspended') {
      setError('이용이 정지된 계정이에요. 관리자에게 문의해 주세요.');
    } else if (params.get('error') === 'access_denied') {
      setError('Google 로그인을 취소했어요. 원할 때 다시 시작할 수 있어요.');
    } else if (params.has('authError') || params.has('error')) {
      setError('Google 로그인이 완료되지 않았어요. 다시 시도해 주세요.');
    }
  }, []);

  useEffect(() => {
    if (access.userId && access.ready && !access.expired) router.replace('/');
  }, [access.userId, access.ready, access.expired, router]);

  return (
    <main className="auth-page">
      <div className="panel auth-card">
        <h1>공간미리 시작하기</h1>
        <p>Google 계정 하나로 가입하고, 내 공간 프로젝트를 저장하세요.</p>
        <p className="muted">처음 로그인하면 회원가입이 함께 진행돼요.</p>
        {access.userId && !access.expired ? (
          <>
            <p role="status">로그인되어 있어요. 내 프로젝트로 이동하고 있어요…</p>
            <Link className="btn primary" href="/">
              내 프로젝트로
            </Link>
          </>
        ) : (
          <button
            className="btn primary"
            disabled={busy || !access.status?.ready || access.mode !== 'd1'}
            aria-busy={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await access.signIn();
              } catch (e) {
                setError(e instanceof Error ? e.message : '로그인에 실패했어요.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Google 연결 중…' : 'Google로 시작하기'}
          </button>
        )}
        {busy && <p role="status">Google 계정 선택 화면을 열고 있어요…</p>}
        {!access.status && <p role="status">로그인 연결을 확인하고 있어요…</p>}
        {(error || access.error) && <p role="alert">{error || access.error}</p>}
        {access.status && !access.status.ready && (
          <p role="alert">
            로그인 연결을 준비하지 못했어요. <button onClick={access.retry}>다시 확인</button>
          </p>
        )}
      </div>
    </main>
  );
}
