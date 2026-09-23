'use client';
import Link from 'next/link';
import CredentialAuthForm from '@/components/auth/credential-auth-form';
import { useRouter } from 'next/navigation';
import { useCallback, useState, useEffect } from 'react';
import { useAccess } from '@/components/app-provider';

export default function LoginPage() {
  const access = useAccess();
  const router = useRouter();
  const [error, setError] = useState('');
  const [resumeGuest, setResumeGuest] = useState(false);
  const [destinationReady, setDestinationReady] = useState(false);
  // A new attempt replaces the message from a previous Google return.
  const clearErrorOnStart = useCallback((busy: boolean) => {
    if (busy) setError('');
  }, []);

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
      <div className="panel auth-card auth-compact">
        <Link className="auth-back" href={resumeGuest ? '/try' : '/'}>
          {resumeGuest ? '← 체험 작업으로 돌아가기' : '← 메인으로'}
        </Link>
        <h1>로그인 / 회원가입</h1>
        {access.userId && access.ready && access.writable && !access.expired ? (
          <>
            <p role="status">로그인되어 있어요. 내 프로젝트로 이동하고 있어요…</p>
            <Link className="btn primary" href={resumeGuest ? '/try?resume=1' : '/'}>
              {resumeGuest ? '체험 작업 이어서 저장' : '내 프로젝트로'}
            </Link>
          </>
        ) : (
          <CredentialAuthForm
            resumeGuest={resumeGuest}
            disabled={!destinationReady || !access.status?.ready || access.mode !== 'd1'}
            onBusyChange={clearErrorOnStart}
          />
        )}
        {(!access.status || !destinationReady) && <p role="status">로그인 연결을 확인하고 있어요…</p>}
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
