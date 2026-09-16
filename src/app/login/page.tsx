'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useAccess } from '@/components/app-provider';
export default function LoginPage() {
  const access = useAccess(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('authError'))
      setError('Google 로그인이 완료되지 않았어요. 다시 시도해 주세요.');
  }, []);
  return (
    <main className="auth-page">
      <div className="panel auth-card">
        <h1>공간미리 시작하기</h1>
        <p>Google 계정 하나로 가입하고, 내 공간 프로젝트를 저장하세요.</p>
        <p className="muted">처음 로그인하면 회원가입이 함께 진행돼요.</p>
        {access.userId ? (
          <Link className="btn primary" href="/">
            내 프로젝트로
          </Link>
        ) : (
          <button
            className="btn primary"
            disabled={busy || !access.status?.ready || access.mode !== 'd1'}
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
        {(error || access.error) && <p role="alert">{error || access.error}</p>}
        {access.status && !access.status.ready && (
          <p role="alert">
            로그인 연결을 준비하지 못했어요. <button onClick={access.retry}>다시 확인</button>
          </p>
        )}
        <p>
          <Link href="/materials">로그인 없이 자재 둘러보기</Link>
        </p>
      </div>
    </main>
  );
}
