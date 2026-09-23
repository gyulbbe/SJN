'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAccess } from '@/components/app-provider';
import CredentialAuthForm from '@/components/auth/credential-auth-form';

export default function LoginPrompt({
  resumeGuest = false,
  onClose,
}: {
  resumeGuest?: boolean;
  onClose: () => void;
}) {
  const access = useAccess();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
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
      <div className="guest-login-heading">
        <h2 id="guest-login-title">로그인 / 회원가입</h2>
        <button
          className="icon-btn guest-dialog-close"
          aria-label="로그인 안내 닫기"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <CredentialAuthForm
        resumeGuest={resumeGuest}
        disabled={!access.status?.ready}
        onBusyChange={setBusy}
      />
      {!access.status && <p role="status">로그인 연결을 확인하고 있어요…</p>}
      {access.status && !access.status.ready && (
        <p role="alert">
          로그인 연결을 준비하지 못했어요. <button onClick={access.retry}>다시 확인</button>
        </p>
      )}
      {access.error && (
        <p className="error" role="alert">
          {access.error}
        </p>
      )}
    </dialog>
  );
}
