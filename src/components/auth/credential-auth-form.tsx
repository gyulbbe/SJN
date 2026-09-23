'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useAccess } from '@/components/app-provider';
import GoogleSignInButton from './google-sign-in-button';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from '@/lib/auth/credential-account';

type Mode = 'sign-in' | 'sign-up';
const fieldClass = 'grid gap-1.5 text-[13px] font-semibold text-[color:var(--ink)]';

/** ID/password sign-in and sign-up, with Google offered underneath when the server has it configured. */
export default function CredentialAuthForm({
  resumeGuest = false,
  disabled = false,
  onBusyChange,
}: {
  resumeGuest?: boolean;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const access = useAccess();
  const hintId = useId();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState<'password' | 'google' | null>(null);
  const [error, setError] = useState('');
  const locked = disabled || !!pending;
  const google = access.status?.googleSignIn !== false;
  useEffect(() => {
    onBusyChange?.(!!pending);
  }, [pending, onBusyChange]);

  function switchMode(next: Mode) {
    setMode(next);
    setConfirm('');
    setError('');
  }
  function validate() {
    if (mode === 'sign-in') return username.trim() && password ? '' : '아이디와 비밀번호를 입력해 주세요.';
    if (!USERNAME_PATTERN.test(username)) return '아이디는 영문·숫자·밑줄 4~20자로 입력해 주세요.';
    if (password.length < PASSWORD_MIN_LENGTH) return `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상 입력해 주세요.`;
    if (password !== confirm) return '비밀번호 확인이 일치하지 않아요.';
    return '';
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const invalid = validate();
    setError(invalid);
    if (invalid) return;
    setPending('password');
    try {
      const navigating = await access.signInWithPassword({
        mode,
        username: username.trim(),
        password,
        resumeGuest,
      });
      // Stay locked while the browser leaves for the signed-in page.
      if (!navigating) setPending(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '로그인하지 못했어요.');
      setPending(null);
    }
  }
  async function continueWithGoogle() {
    setError('');
    setPending('google');
    try {
      await access.signIn({ resumeGuest });
    } catch {
      // AppProvider exposes the Google error to the surrounding screen.
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-4">
      <div
        role="group"
        aria-label="로그인 또는 회원가입 선택"
        className="grid grid-cols-2 gap-1 rounded-[var(--radius-sm)] bg-[color:var(--surface-soft)] p-1"
      >
        {(
          [
            ['sign-in', '로그인'],
            ['sign-up', '회원가입'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={!!pending}
            onClick={() => switchMode(value)}
            className="min-h-10 rounded-md text-sm font-semibold text-[color:var(--muted)] aria-pressed:bg-[color:var(--paper)] aria-pressed:text-[color:var(--ink)] aria-pressed:shadow-sm"
          >
            {label}
          </button>
        ))}
      </div>
      <form className="grid gap-3" noValidate onSubmit={(event) => void submit(event)}>
        <label className={fieldClass}>
          아이디
          <input
            className="input"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={20}
            value={username}
            disabled={locked}
            aria-describedby={mode === 'sign-up' ? hintId : undefined}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        {mode === 'sign-up' && (
          <small id={hintId} className="-mt-1.5 text-xs text-[color:var(--muted)]">
            영문·숫자·밑줄 4~20자, 비밀번호 {PASSWORD_MIN_LENGTH}자 이상
          </small>
        )}
        <label className={fieldClass}>
          비밀번호
          <input
            className="input"
            type="password"
            name="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            disabled={locked}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {mode === 'sign-up' && (
          <label className={fieldClass}>
            비밀번호 확인
            <input
              className="input"
              type="password"
              name="password-confirm"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              value={confirm}
              disabled={locked}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
        )}
        {error && <div role="alert">{error}</div>}
        <button className="btn primary min-h-12 w-full justify-center" type="submit" disabled={locked}>
          {pending === 'password' ? '확인하고 있어요…' : mode === 'sign-up' ? '회원가입하기' : '로그인하기'}
        </button>
      </form>
      {google && (
        <>
          <div className="flex items-center gap-3 text-xs text-[color:var(--muted)] before:h-px before:flex-1 before:bg-[color:var(--line)] after:h-px after:flex-1 after:bg-[color:var(--line)]">
            또는
          </div>
          <GoogleSignInButton
            busy={pending === 'google'}
            disabled={disabled || pending === 'password'}
            onClick={() => void continueWithGoogle()}
          />
        </>
      )}
    </div>
  );
}
