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
  const [resumeGuest, setResumeGuest] = useState(false);
  const [destinationReady, setDestinationReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let dead = false;
    void import('@/lib/guest/session').then(({ readGuestDraft }) => {
      if (dead) return;
      try {
        setResumeGuest(params.get('resume') === 'guest' || !!readGuestDraft());
      } catch (reason) {
        // An unreadable draft must not silently become a fresh login without recovery.
        setResumeGuest(true);
        setError(reason instanceof Error ? reason.message : '체험 작업을 확인하지 못했어요.');
      }
      setDestinationReady(true);
    });
    // Better Auth appends the provider's `error` to our errorCallbackURL.
    // Show our own message, never the provider's raw error_description.
    if (params.get('error') === 'account_suspended') {
      setError('이용이 정지된 계정이에요. 관리자에게 문의해 주세요.');
    } else if (params.get('error') === 'access_denied') {
      setError('Google 로그인을 취소했어요. 원할 때 다시 시작할 수 있어요.');
    } else if (params.has('authError') || params.has('error')) {
      setError('Google 로그인이 완료되지 않았어요. 다시 시도해 주세요.');
    }
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    if (destinationReady && access.userId && access.ready && access.writable && !access.expired)
      router.replace(resumeGuest ? '/try?resume=1' : '/');
  }, [access.userId, access.ready, access.writable, access.expired, destinationReady, resumeGuest, router]);

  return (
    <main className="auth-page">
      <div className="panel auth-card">
        <Link href={resumeGuest ? '/try' : '/'}>
          {resumeGuest ? '← 체험 작업으로 돌아가기' : '← 메인으로'}
        </Link>
        <h1>공간미리 시작하기</h1>
        <p>Google 계정 하나로 가입하고, 내 공간 프로젝트를 저장하세요.</p>
        <p className="muted">처음 로그인하면 회원가입이 함께 진행돼요.</p>
        {resumeGuest && <p>체험 작업은 유지돼요. 로그인하면 내 프로젝트로 저장해 이어갈 수 있어요.</p>}
        {access.userId && access.ready && access.writable && !access.expired ? (
          <>
            <p role="status">로그인되어 있어요. 내 프로젝트로 이동하고 있어요…</p>
            <Link className="btn primary" href={resumeGuest ? '/try?resume=1' : '/'}>
              {resumeGuest ? '체험 작업 이어서 저장' : '내 프로젝트로'}
            </Link>
          </>
        ) : (
          <button
            className="btn primary"
            disabled={busy || !destinationReady || !access.status?.ready || access.mode !== 'd1'}
            aria-busy={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await access.signIn({ resumeGuest });
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
