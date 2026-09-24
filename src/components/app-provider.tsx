'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { initializeRepositories, resetRepositories } from '@/lib/repositories';
import { discoverStorage } from '@/lib/storage/bootstrap';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { STORAGE_MESSAGES, type StorageMode, type StorageStatus } from '@/lib/storage/config';
import { checkpointBeforeAccountChange, flushBeforeStorageTransition } from '@/lib/storage/recovery';
import { isPublicPage, signInDestinations, type SignInOptions } from '@/lib/auth/public-routes';
import { credentialErrorMessage } from '@/lib/auth/credential-account';
import CredentialAuthForm from './auth/credential-auth-form';

export type PasswordSignIn = SignInOptions & {
  mode: 'sign-in' | 'sign-up';
  username: string;
  password: string;
};
type Access = {
  writable: boolean;
  ready: boolean;
  mode: StorageMode;
  userId?: string;
  retry: () => void;
  signIn: (options?: SignInOptions) => Promise<void>;
  /** Resolves true once the browser is navigating to the signed-in destination. */
  signInWithPassword: (input: PasswordSignIn) => Promise<boolean>;
  signOut: () => Promise<void>;
  error: string;
  status: StorageStatus | null;
  expired: boolean;
};
const Context = createContext<Access>({
  writable: false,
  ready: false,
  mode: 'd1',
  retry: () => {},
  signIn: async () => {},
  signInWithPassword: async () => false,
  signOut: async () => {},
  error: '',
  status: null,
  expired: false,
});
export const useAccess = () => useContext(Context);

/** A full navigation releases the previous account's asset URLs, stores, and editor caches. */
function reopenWorkspace() {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Repository identity must not survive a client-side navigation.
  window.location.assign('/');
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const publicPage = isPublicPage(pathname);
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [userId, setUserId] = useState<string>();
  const [ready, setReady] = useState(false);
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [accountChanged, setAccountChanged] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const initializing = useRef(0);
  const changingAccount = useRef(false);
  const transitionBusy = useRef(false);
  const mode = status?.mode ?? 'd1';
  const protectAccountTransition = accountChanged && !['/materials', '/try', '/login'].includes(pathname);
  // A file dropped outside an upload area would make the browser open it and leave the page.
  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);
  const suspendChangedAccount = useCallback(async () => {
    if (changingAccount.current) return;
    changingAccount.current = true;
    // Capture inputs and the old account scope before permissions cause UI effects to run.
    const checkpoint = checkpointBeforeAccountChange();
    setAccountChanged(true);
    setExpired(false);
    setWritable(false);
    setError('계정 변경을 확인했어요. 이전 계정의 작업을 복구본으로 보관하고 있어요…');
    try {
      await checkpoint;
      resetRepositories();
      setReady(false);
      setError(
        '계정이 변경됐어요. 이전 작업은 해당 계정의 복구본으로 보관했어요. 계정을 확인한 뒤 다시 열어 주세요.',
      );
    } catch (reason) {
      setError(
        '이전 계정의 작업을 복구본에 보관하지 못했어요. 현재 작업은 메모리에 유지 중이니 이 탭을 닫지 말고 이전 계정으로 돌아가 주세요. ' +
          (reason instanceof Error ? reason.message : '브라우저 저장 공간을 확인해 주세요.'),
      );
    }
  }, []);

  useEffect(() => {
    const generation = ++initializing.current;
    const controller = new AbortController();
    let dead = false;
    setReady(false);
    setWritable(false);
    void (async () => {
      const value = await discoverStorage({ signal: controller.signal });
      if (dead || generation !== initializing.current) return;
      setStatus(value);
      setError('');
      if (!value.ready) {
        setUserId(undefined);
        return;
      }
      try {
        const response = await fetch('/api/auth/get-session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (dead || generation !== initializing.current) return;
        if ([401, 403].includes(response.status)) {
          if (response.status === 403) setError('이용이 정지된 계정이에요. 관리자에게 문의해 주세요.');
          setUserId(undefined);
          setReady(false);
          return;
        }
        if (!response.ok) throw new Error('로그인 상태를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.');
        const session = await response.json();
        if (dead || generation !== initializing.current) return;
        if (session?.user?.id && typeof session.user.id === 'string') {
          initializeRepositories(value.mode, session.user.id);
          setUserId(session.user.id);
          setExpired(false);
          setReady(true);
          setWritable(true);
        } else {
          setUserId(undefined);
          setReady(false);
        }
      } catch (reason) {
        if (!dead) setError(reason instanceof Error ? reason.message : '로그인 상태를 확인하지 못했어요.');
      }
    })();
    return () => {
      dead = true;
      controller.abort();
    };
  }, [attempt]);

  useEffect(() => {
    function expiry(event: Event) {
      if ((event as CustomEvent)?.detail?.accountChanged) {
        void suspendChangedAccount();
        return;
      }
      setExpired(true);
      setWritable(false);
      setError(
        (event as CustomEvent)?.detail?.suspended
          ? '이용이 정지된 계정이에요. 관리자에게 문의해 주세요.'
          : '로그인이 만료됐어요. 다시 로그인하면 본인 계정의 저장 작업을 확인할 수 있어요.',
      );
    }
    window.addEventListener('sjn-auth-expired', expiry);
    return () => window.removeEventListener('sjn-auth-expired', expiry);
  }, [mode, suspendChangedAccount]);

  useEffect(() => {
    if (!ready || !userId) return;
    let dead = false;
    let busy = false;
    let lastCheck = Date.now();
    const controller = new AbortController();
    async function checkSession() {
      if (busy || document.visibilityState === 'hidden' || Date.now() - lastCheck < 30_000) return;
      busy = true;
      lastCheck = Date.now();
      try {
        const response = await fetch('/api/auth/get-session', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok && ![401, 403].includes(response.status)) return;
        const session = !response.ok ? null : await response.json();
        if (dead) return;
        if (!session?.user?.id) {
          setExpired(true);
          setWritable(false);
          setError('로그인이 만료됐어요. 작업은 유지되며 다시 로그인한 뒤 서버 저장을 재시도할 수 있어요.');
        } else if (session.user.id !== userId) {
          void suspendChangedAccount();
        } else if (!accountChanged) {
          setExpired(false);
          setWritable(true);
        }
      } catch {
        /* Connectivity failures never replace the active workspace. */
      } finally {
        busy = false;
      }
    }
    const timer = window.setInterval(() => void checkSession(), 300_000);
    const refresh = () => void checkSession();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      dead = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [ready, mode, userId, accountChanged, suspendChangedAccount]);

  async function transition(action: () => Promise<void> | void) {
    if (transitionBusy.current) return;
    transitionBusy.current = true;
    try {
      if (!(await flushBeforeStorageTransition())) return;
      await action();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '현재 작업을 보존하지 못했어요. 다시 시도해 주세요.',
      );
    } finally {
      transitionBusy.current = false;
    }
  }
  async function reconnect() {
    await transition(() => {
      // Account transitions always reopen at the list, never reuse a project ID.
      if (ready || accountChanged) {
        reopenWorkspace();
        return;
      }
      setAttempt((value) => value + 1);
    });
  }
  /** Both sign-in methods preserve the guest draft or current work before leaving the page. */
  async function prepareSignIn(options: SignInOptions) {
    if (options.resumeGuest) {
      const { readGuestDraft, checkpointGuestDraft } = await import('@/lib/guest/session');
      const { useEditor } = await import('@/lib/editor-store');
      const draft = readGuestDraft();
      if (!draft) throw new Error('이어서 저장할 체험 작업을 찾지 못했어요.');
      const current = useEditor.getState();
      if (current.project?.id === draft.document.id) {
        current.commit();
        await checkpointGuestDraft(useEditor.getState().project ?? undefined);
      } else {
        await checkpointGuestDraft();
      }
    } else if (!(await flushBeforeStorageTransition())) {
      throw new Error('현재 작업을 보관하지 못했어요. 작업을 확인한 뒤 다시 로그인해 주세요.');
    }
    setError('');
  }
  async function signInWithPassword({ mode, username, password, ...options }: PasswordSignIn) {
    if (transitionBusy.current) return false;
    transitionBusy.current = true;
    try {
      await prepareSignIn(options);
      const response = await fetch(
        mode === 'sign-up' ? '/api/auth/sign-up/email' : '/api/auth/sign-in/username',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          signal: AbortSignal.timeout(15_000),
          // The server derives the account email from the ID; the client never supplies one.
          body: JSON.stringify({ username, password }),
        },
      );
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(credentialErrorMessage(mode, response.status, result?.code));
      }
      // Same full navigation as the Google return so account storage starts fresh.
      window.location.assign(signInDestinations(options).callbackURL);
      return true;
    } finally {
      transitionBusy.current = false;
    }
  }
  async function signIn(options: SignInOptions = {}) {
    if (transitionBusy.current) return;
    transitionBusy.current = true;
    try {
      await prepareSignIn(options);
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          provider: 'google',
          ...signInDestinations(options),
        }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.url !== 'string')
        throw new Error('Google 로그인 연결에 실패했어요. OAuth 설정과 배포 주소를 확인해 주세요.');
      const target = new URL(result.url);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com')
        throw new Error('Google 로그인 주소가 올바르지 않아요.');
      window.location.assign(target.href);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '로그인을 시작하지 못했어요.');
      throw reason;
    } finally {
      transitionBusy.current = false;
    }
  }
  async function signOut() {
    await transition(async () => {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('로그아웃하지 못했어요. 다시 시도해 주세요.');
      resetRepositories();
      reopenWorkspace();
    });
  }
  const retry = () => void reconnect();
  return (
    <Context.Provider
      value={{
        writable,
        ready,
        mode,
        userId,
        retry,
        signIn,
        signInWithPassword,
        signOut,
        error,
        status,
        expired,
      }}
    >
      {!publicPage && status && STORAGE_MESSAGES[status.reason] && (
        <div className="readonly-banner" role="status">
          {STORAGE_MESSAGES[status.reason]}{' '}
          <button onClick={() => void reconnect()}>서버 연결 다시 확인</button>
        </div>
      )}
      {!publicPage && expired && (
        <div className="readonly-banner" role="alert">
          {error}{' '}
          {/* The member guard below also offers ID sign-in; this is the one-click Google shortcut. */}
          {status?.googleSignIn !== false && (
            <button onClick={() => void signIn().catch(() => {})}>Google로 다시 로그인</button>
          )}
        </div>
      )}
      {(!publicPage || !!userId) && ready && !expired && !accountChanged && error && (
        <div className="readonly-banner" role="alert">
          {error} {accountChanged && <button onClick={() => void reconnect()}>계정 다시 확인</button>}
        </div>
      )}
      {protectAccountTransition && (
        <main className="auth-page">
          <div className="panel auth-card">
            <h1>로그인 계정이 변경됐어요</h1>
            <p role="alert">{error}</p>
            <button className="btn primary" onClick={() => void reconnect()}>
              계정 다시 확인
            </button>
          </div>
        </main>
      )}
      <div style={{ display: protectAccountTransition ? 'none' : 'contents' }}>{children}</div>
    </Context.Provider>
  );
}
export function StorageBadge() {
  return (
    <span className="storage-badge">
      <span />
      계정 작업 공간
    </span>
  );
}
export function BackendGuard({ children }: { children: React.ReactNode }) {
  const { status, ready, expired, retry, error } = useAccess();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  if (isPublicPage(pathname) || (ready && !expired)) return children;
  if (!status)
    return (
      <main className="auth-page">
        <p role="status">로그인 연결을 확인하고 있어요…</p>
      </main>
    );
  return (
    <main className="auth-page">
      <div className="panel auth-card auth-compact">
        <Link className="auth-back" href="/">
          ← 메인으로
        </Link>
        <h1>로그인 / 회원가입</h1>
        <CredentialAuthForm disabled={!status.ready} onBusyChange={setBusy} />
        {!status.ready && <p role="alert">로그인과 D1·R2 연결 설정을 먼저 확인해 주세요.</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {(!status.ready || error || expired) && (
          <button className="btn" disabled={busy} onClick={retry}>
            로그인 상태 다시 확인
          </button>
        )}
      </div>
    </main>
  );
}
