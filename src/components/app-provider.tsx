'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { getRepositories } from '@/lib/repositories';
type Access = { writable: boolean; ready: boolean; retry: () => void; mode: 'local' | 'supabase' };
const Context = createContext<Access>({ writable: false, ready: false, retry: () => {}, mode: 'local' });
export const useAccess = () => useContext(Context);
export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState({ writable: false, ready: false });
  const [attempt, setAttempt] = useState(0);
  const mode = process.env.NEXT_PUBLIC_STORAGE_MODE === 'supabase' ? 'supabase' : 'local';
  useEffect(() => {
    if (mode === 'supabase') {
      setState({ writable: true, ready: true });
      return;
    }
    let released = false;
    let release: () => void = () => {};
    if (!navigator.locks) {
      setState({ writable: false, ready: true });
      return;
    }
    const controller = new AbortController();
    setState({ writable: false, ready: true });
    // Queue rather than ifAvailable: StrictMode's cleanup may release the first
    // lease one microtask after the second effect, and must not strand this tab.
    void navigator.locks
      .request('gongganmiri-local-writer', { signal: controller.signal }, async () => {
        if (released) return;
        setState({ writable: true, ready: true });
        await new Promise<void>((resolve) => {
          release = resolve;
          if (released) resolve();
        });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setState({ writable: false, ready: true });
      });
    return () => {
      released = true;
      controller.abort();
      release();
    };
  }, [attempt, mode]);
  return (
    <Context.Provider value={{ ...state, mode, retry: () => setAttempt((x) => x + 1) }}>
      {state.ready && !state.writable && (
        <div className="readonly-banner">
          다른 탭에서 편집 중이에요. 이 탭은 읽기 전용입니다.{' '}
          <button onClick={() => setAttempt((x) => x + 1)}>편집권 다시 확인</button>
        </div>
      )}
      {children}
    </Context.Provider>
  );
}
export function StorageBadge() {
  const { mode } = useAccess();
  return (
    <span className="storage-badge">
      <span />
      {mode === 'local' ? '로컬 작업 공간' : '클라우드 작업 공간'}
    </span>
  );
}
export function BackendGuard({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cloud = process.env.NEXT_PUBLIC_STORAGE_MODE === 'supabase';
  useEffect(() => {
    if (!cloud) {
      setReady(true);
      return;
    }
    void import('@/lib/supabase/client')
      .then(async (m) => {
        const c = m.createBrowserSupabase();
        const { data, error } = await c.auth.getUser();
        if (error && error.message !== 'Auth session missing!') setError(error.message);
        setReady(!!data.user);
      })
      .catch((e) => setError(String(e)));
  }, [cloud]);
  async function auth(signup: boolean) {
    setBusy(true);
    try {
      getRepositories();
      const { createBrowserSupabase } = await import('@/lib/supabase/client');
      const c = createBrowserSupabase();
      const result = signup
        ? await c.auth.signUp({ email, password })
        : await c.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (result.data.session) setReady(true);
      else setError('이메일의 가입 확인 링크를 열고 로그인해 주세요.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!cloud || ready) return children;
  return (
    <main className="auth-page">
      <div className="panel auth-card">
        <h1>공간미리 로그인</h1>
        <p className="muted">Supabase 서버 모드 · 로컬 자료는 자동 전송되지 않습니다.</p>
        <label className="field">
          이메일
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          비밀번호
          <input
            className="input"
            type="password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="btn primary" disabled={busy} onClick={() => auth(false)}>
          로그인
        </button>{' '}
        <button className="btn" disabled={busy} onClick={() => auth(true)}>
          회원가입
        </button>
      </div>
    </main>
  );
}
