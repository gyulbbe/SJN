'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { initializeRepositories, resetRepositories } from '@/lib/repositories';
import { discoverStorage } from '@/lib/storage/bootstrap';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { STORAGE_MESSAGES, type StorageMode, type StorageStatus } from '@/lib/storage/config';
import { checkpointBeforeAccountChange, flushBeforeStorageTransition } from '@/lib/storage/recovery';

type Access = {
  writable: boolean;
  ready: boolean;
  mode: StorageMode;
  userId?: string;
  retry: () => void;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  openLocal: () => Promise<void>;
  error: string;
  status: StorageStatus | null;
  expired: boolean;
};
const Context = createContext<Access>({
  writable: false,
  ready: false,
  mode: 'local',
  retry: () => {},
  signIn: async () => {},
  signOut: async () => {},
  openLocal: async () => {},
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
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [userId, setUserId] = useState<string>();
  const [ready, setReady] = useState(false);
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [accountChanged, setAccountChanged] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [lockAttempt, setLockAttempt] = useState(0);
  const initializing = useRef(0);
  const changingAccount = useRef(false);
  const transitionBusy = useRef(false);
  const mode = status?.mode ?? 'local';
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
      if (value.mode === 'local') {
        initializeRepositories('local');
        setUserId(undefined);
        setReady(true);
        return;
      }
      if (!value.ready) {
        setUserId(undefined);
        return;
      }
      try {
        if (value.mode === 'supabase' && value.supabase) {
          const { configureBrowserSupabase } = await import('@/lib/supabase/client');
          configureBrowserSupabase(value.supabase);
        }
        const response = await fetch(value.mode === 'd1' ? '/api/auth/get-session' : '/api/storage/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (dead || generation !== initializing.current) return;
        if (response.status === 401) {
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
    if (!ready || mode !== 'local') return;
    let released = false;
    let release: () => void = () => {};
    const controller = new AbortController();
    if (!navigator.locks) {
      setWritable(false);
      return;
    }
    void navigator.locks
      .request('gongganmiri-local-writer', { signal: controller.signal }, async () => {
        if (released) return;
        setWritable(true);
        await new Promise<void>((resolve) => {
          release = resolve;
          if (released) resolve();
        });
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setWritable(false);
      });
    return () => {
      released = true;
      controller.abort();
      release();
      setWritable(false);
    };
  }, [ready, mode, lockAttempt]);

  useEffect(() => {
    function expiry(event: Event) {
      if (mode === 'local') return;
      if ((event as CustomEvent)?.detail?.accountChanged) {
        void suspendChangedAccount();
        return;
      }
      setExpired(true);
      setError('로그인이 만료됐어요. 작업은 유지되며 다시 로그인한 뒤 서버 저장을 재시도할 수 있어요.');
    }
    window.addEventListener('sjn-auth-expired', expiry);
    return () => window.removeEventListener('sjn-auth-expired', expiry);
  }, [mode, suspendChangedAccount]);

  useEffect(() => {
    if (!ready || mode === 'local' || !userId) return;
    let dead = false;
    let busy = false;
    let lastCheck = Date.now();
    const controller = new AbortController();
    async function checkSession() {
      if (busy || document.visibilityState === 'hidden' || Date.now() - lastCheck < 30_000) return;
      busy = true;
      lastCheck = Date.now();
      try {
        const response = await fetch(mode === 'd1' ? '/api/auth/get-session' : '/api/storage/session', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok && response.status !== 401) return;
        const session = response.status === 401 ? null : await response.json();
        if (dead) return;
        if (!session?.user?.id) {
          setExpired(true);
          setError('로그인이 만료됐어요. 작업은 유지되며 다시 로그인한 뒤 서버 저장을 재시도할 수 있어요.');
        } else if (session.user.id !== userId) {
          void suspendChangedAccount();
        } else if (!accountChanged) {
          setExpired(false);
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
  async function openLocal() {
    if (status?.mode !== 'local') return;
    await transition(() => {
      try {
        sessionStorage.setItem('sjn-workspace', 'local');
      } catch {}
      resetRepositories();
      reopenWorkspace();
    });
  }
  async function reconnect() {
    await transition(() => {
      try {
        sessionStorage.removeItem('sjn-workspace');
      } catch {}
      // Backend/account transitions always reopen at the list, never reuse a project ID.
      if (ready || accountChanged) {
        reopenWorkspace();
        return;
      }
      setAttempt((value) => value + 1);
    });
  }
  async function signIn() {
    await transition(async () => {
      setError('');
      if (mode === 'supabase') {
        reopenWorkspace();
        return;
      }
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          provider: 'google',
          callbackURL: '/',
          errorCallbackURL: '/login?authError=google',
        }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.url !== 'string')
        throw new Error('Google 로그인 연결에 실패했어요. OAuth 설정과 배포 주소를 확인해 주세요.');
      const target = new URL(result.url);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com')
        throw new Error('Google 로그인 주소가 올바르지 않아요.');
      window.location.assign(target.href);
    });
  }
  async function signOut() {
    await transition(async () => {
      if (mode === 'supabase') {
        const { createBrowserSupabase } = await import('@/lib/supabase/client');
        const result = await createBrowserSupabase().auth.signOut();
        if (result.error) throw result.error;
      } else {
        const response = await fetch('/api/auth/sign-out', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('로그아웃하지 못했어요. 다시 시도해 주세요.');
      }
      resetRepositories();
      reopenWorkspace();
    });
  }
  const retry = () => {
    if (mode === 'local' && ready && !writable) setLockAttempt((value) => value + 1);
    else void reconnect();
  };
  return (
    <Context.Provider
      value={{ writable, ready, mode, userId, retry, signIn, signOut, openLocal, error, status, expired }}
    >
      {status && STORAGE_MESSAGES[status.reason] && (
        <div className="readonly-banner" role="status">
          {STORAGE_MESSAGES[status.reason]}{' '}
          <button onClick={() => void reconnect()}>서버 연결 다시 확인</button>
        </div>
      )}
      {expired && (
        <div className="readonly-banner" role="alert">
          {error}{' '}
          <button onClick={() => void signIn()}>
            {mode === 'd1' ? 'Google로 다시 로그인' : '다시 로그인'}
          </button>
        </div>
      )}
      {ready && !expired && !accountChanged && error && (
        <div className="readonly-banner" role="alert">
          {error} {accountChanged && <button onClick={() => void reconnect()}>계정 다시 확인</button>}
        </div>
      )}
      {ready && !writable && mode === 'local' && (
        <div className="readonly-banner">
          다른 탭에서 편집 중이에요. 이 탭은 읽기 전용입니다.{' '}
          <button onClick={retry}>편집권 다시 확인</button>
        </div>
      )}
      {accountChanged && (
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
      <div style={{ display: accountChanged ? 'none' : 'contents' }}>{children}</div>
    </Context.Provider>
  );
}
export function StorageBadge() {
  const access = useAccess();
  return (
    <span className="storage-badge">
      <span />
      {access.mode === 'local' ? '로컬 작업 공간' : '클라우드 작업 공간'}
      {access.mode === 'local' && (
        <button className="text-button" onClick={() => void access.openLocal()}>
          로컬 자료 열기
        </button>
      )}
    </span>
  );
}
export function BackendGuard({ children }: { children: React.ReactNode }) {
  const { status, ready, mode, signIn, retry, error } = useAccess();
  const pathname = usePathname();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('authError'))
      setAuthError('Google 로그인이 완료되지 않았어요. 설정과 동의 화면을 확인하고 다시 시도해 주세요.');
  }, []);
  async function supabaseAuth(signup: boolean) {
    setBusy(true);
    setAuthError('');
    try {
      const { createBrowserSupabase } = await import('@/lib/supabase/client');
      const client = createBrowserSupabase();
      const result = signup
        ? await client.auth.signUp({ email, password })
        : await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (result.data.session) reopenWorkspace();
      else setAuthError('이메일의 가입 확인 링크를 열고 로그인해 주세요.');
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : '로그인에 실패했어요.');
    } finally {
      setBusy(false);
    }
  }
  if (pathname === '/materials' || pathname === '/login' || ready) return children;
  if (!status)
    return (
      <main className="auth-page">
        <p role="status">작업 공간을 준비하고 있어요…</p>
      </main>
    );
  return (
    <main className="auth-page">
      <div className="panel auth-card">
        <h1>공간미리 로그인</h1>
        <p className="muted">로그인 계정에 작업을 저장해요. 기존 로컬 자료는 자동 업로드되지 않아요.</p>
        {mode === 'd1' ? (
          <button
            className="btn primary"
            disabled={busy || !status.ready}
            onClick={async () => {
              setBusy(true);
              try {
                await signIn();
              } finally {
                setBusy(false);
              }
            }}
          >
            Google로 시작하기
          </button>
        ) : (
          <>
            <label className="field">
              이메일
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="field">
              비밀번호
              <input
                className="input"
                type="password"
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="btn primary" disabled={busy} onClick={() => void supabaseAuth(false)}>
              로그인
            </button>
            <button className="btn" disabled={busy} onClick={() => void supabaseAuth(true)}>
              회원가입
            </button>
          </>
        )}
        {(error || authError) && (
          <p role="alert" className="error">
            {error || authError}
          </p>
        )}
        <button className="btn" disabled={busy} onClick={retry}>
          로그인 상태 다시 확인
        </button>
        <Link className="text-button" href="/materials">
          로그인 없이 자재 둘러보기
        </Link>
      </div>
    </main>
  );
}
