'use client';
import type { ButtonHTMLAttributes } from 'react';
import styles from './google-sign-in-button.module.css';

type GoogleSignInButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  busy?: boolean;
};

export default function GoogleSignInButton({
  busy = false,
  disabled,
  className,
  ...props
}: GoogleSignInButtonProps) {
  return (
    <>
      <button
        {...props}
        type="button"
        className={['google-sign-in', styles.button, className].filter(Boolean).join(' ')}
        disabled={disabled || busy}
        aria-busy={busy}
      >
        <img src="/icons/google-g.svg" alt="" aria-hidden="true" width={20} height={20} />
        <span>{busy ? 'Google 연결 중…' : 'Google로 계속하기'}</span>
      </button>
      <span role="status" className={styles.srOnly}>
        {busy ? 'Google 계정 선택 화면을 열고 있어요…' : ''}
      </span>
    </>
  );
}
