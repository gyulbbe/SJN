'use client';
import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, X } from 'lucide-react';
import { useAccess } from '@/components/app-provider';

export default function LoginPrompt({
  feature,
  resumeGuest = false,
  onClose,
}: {
  feature: string;
  resumeGuest?: boolean;
  onClose: () => void;
}) {
  const access = useAccess();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="guest-login-dialog"
      aria-labelledby="guest-login-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <button
        className="icon-btn guest-dialog-close"
        aria-label="로그인 안내 닫기"
        disabled={busy}
        onClick={onClose}
      >
        <X size={19} />
      </button>
      <span className="auth-emblem" aria-hidden="true">
        <LockKeyhole size={24} />
      </span>
      <h2 id="guest-login-title">로그인하고 이어서 이용하세요</h2>
      <p>{feature} 기능은 로그인 후 사용할 수 있어요.</p>
      {resumeGuest && <p>지금 배치한 공간은 로그인 후 내 프로젝트로 저장해 이어갈 수 있어요.</p>}
      <p className="muted">Google 계정으로 처음 로그인하면 회원가입도 함께 진행돼요.</p>
      <button
        className="btn primary"
        disabled={busy || !access.status?.ready}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await access.signIn({ resumeGuest });
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : '로그인을 시작하지 못했어요.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Google 연결 중…' : 'Google로 시작하기'}
      </button>
      {busy && <p role="status">Google 계정 선택 화면을 열고 있어요…</p>}
      {!access.status && <p role="status">로그인 연결을 확인하고 있어요…</p>}
      {access.status && !access.status.ready && (
        <p role="alert">
          로그인 연결을 준비하지 못했어요. <button onClick={access.retry}>다시 확인</button>
        </p>
      )}
      {(error || access.error) && (
        <p className="error" role="alert">
          {error || access.error}
        </p>
      )}
      <button className="btn" disabled={busy} onClick={onClose}>
        체험 계속하기
      </button>
    </dialog>
  );
}
