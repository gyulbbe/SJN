'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccess } from '@/components/app-provider';
import { RepositoryProvider } from '@/components/repository-context';
import Editor from '@/components/editor/editor';
import RoomDialog from '@/components/rooms/room-dialog';
import { DEFAULT_ROOM } from '@/lib/room-geometry';
import { getRepositories } from '@/lib/repositories';
import { useEditor } from '@/lib/editor-store';
import {
  createGuestDraft,
  openGuestSession,
  checkpointGuestDraft,
  promoteGuestDraft,
  readGuestDraft,
  clearGuestDraft,
} from '@/lib/guest/session';
import LoginPrompt from './login-prompt';

type Session = Awaited<ReturnType<typeof openGuestSession>>;
export default function GuestWorkspace() {
  const access = useAccess();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feature, setFeature] = useState('');
  const [roomOpen, setRoomOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [resume, setResume] = useState(false);
  const [promotionFailed, setPromotionFailed] = useState(false);
  const promotion = useRef(false);
  const autoAttempt = useRef(false);
  const roomCreation = useRef<AbortController | null>(null);
  useEffect(() => () => roomCreation.current?.abort(), []);
  function closeRoom() {
    roomCreation.current?.abort();
    roomCreation.current = null;
    setRoomOpen(false);
  }
  useEffect(() => {
    setResume(new URLSearchParams(window.location.search).get('resume') === '1');
  }, []);
  useEffect(() => {
    let dead = false;
    setLoading(true);
    void openGuestSession()
      .then((value) => {
        if (!dead) {
          setSession(value);
          setError('');
        }
      })
      .catch((reason) => {
        if (!dead) setError(reason instanceof Error ? reason.message : '임시 작업을 열지 못했어요.');
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [attempt]);
  const saveToAccount = useCallback(async () => {
    if (promotion.current || !access.ready || !access.writable || !access.userId || access.expired) return;
    promotion.current = true;
    setError('');
    try {
      const current = useEditor.getState();
      if (readGuestDraft()?.promotion) {
        // A possibly committed upload is immutable until its result is confirmed.
      } else if (session && current.project?.id === session.draft.document.id) {
        current.commit();
        await checkpointGuestDraft(useEditor.getState().project ?? undefined);
      } else await checkpointGuestDraft();
      setSaving(true);
      const id = await promoteGuestDraft(getRepositories(), access.userId);
      router.replace('/projects/' + id);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '프로젝트를 저장하지 못했어요. 임시 작업은 유지돼요.',
      );
      setSaving(false);
      try {
        setPromotionFailed(!!readGuestDraft()?.promotion);
      } catch {
        setPromotionFailed(true);
      }
    } finally {
      promotion.current = false;
    }
  }, [access.ready, access.writable, access.userId, access.expired, session, router]);
  useEffect(() => {
    if (
      resume &&
      session &&
      !loading &&
      access.ready &&
      access.writable &&
      access.userId &&
      !access.expired &&
      !autoAttempt.current
    ) {
      autoAttempt.current = true;
      void saveToAccount();
    }
  }, [resume, session, loading, access.ready, access.writable, access.userId, access.expired, saveToAccount]);
  const requestLogin = useCallback(
    (next: string) => {
      if (access.ready && access.userId && !access.expired) void saveToAccount();
      else setFeature(next);
    },
    [access.ready, access.userId, access.expired, saveToAccount],
  );
  async function refreshCatalog() {
    try {
      const current = useEditor.getState();
      if (session && current.project?.id === session.draft.document.id) {
        current.commit();
        await checkpointGuestDraft(useEditor.getState().project ?? undefined);
      }
      setAttempt((v) => v + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '현재 작업을 보관하지 못했어요.');
    }
  }
  function resetDraft() {
    if (!window.confirm('이 탭의 임시 체험 작업을 삭제할까요? 계정에 저장한 프로젝트는 바뀌지 않아요.'))
      return;
    try {
      clearGuestDraft();
      setSession(null);
      setError('');
      setPromotionFailed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '체험 초기화에 실패했어요.');
    }
  }
  if (loading)
    return (
      <main className="guest-setup">
        <p role="status">체험 공간을 준비하고 있어요…</p>
      </main>
    );
  if (saving)
    return (
      <main className="guest-setup">
        <h1>내 프로젝트로 저장하고 있어요</h1>
        <p role="status">
          배치한 자재와 공간 크기를 그대로 이어가요. 저장이 끝날 때까지 이 탭을 유지해 주세요.
        </p>
      </main>
    );
  if (promotionFailed || session?.draft.promotion)
    return (
      <main className="guest-setup panel">
        <h1>프로젝트 저장을 마무리해 주세요</h1>
        <p>체험 작업은 보관되어 있어요. 중복 저장을 막기 위해 저장 결과를 확인할 때까지 편집을 멈췄어요.</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {access.ready && access.userId && !access.expired ? (
          <>
            <button className="btn primary" onClick={() => void saveToAccount()}>
              저장 다시 시도
            </button>
            <button className="btn" onClick={() => void access.signOut()}>
              다른 계정으로 로그인
            </button>
          </>
        ) : (
          <Link className="btn primary" href="/login?resume=guest">
            로그인하고 저장 계속하기
          </Link>
        )}
        <Link className="btn" href="/">
          메인으로
        </Link>
      </main>
    );
  return (
    <>
      {session ? (
        <div className="guest-workspace">
          <div className="guest-status">
            <span>로그인 전 임시 작업이며 탭을 닫으면 사라질 수 있어요.</span>
            <button className="btn" onClick={() => requestLogin('프로젝트 저장')}>
              {access.ready && access.userId ? '내 프로젝트로 저장' : '로그인 / 회원가입'}
            </button>
          </div>
          {session.warnings.map((warning) => (
            <div key={warning} role="status" className="notice">
              {warning} <button onClick={() => void refreshCatalog()}>자재 다시 확인</button>
            </div>
          ))}
          {error && (
            <div role="alert" className="error notice">
              {error}{' '}
              <button onClick={() => void saveToAccount()} disabled={!access.ready || !access.userId}>
                저장 다시 시도
              </button>
            </div>
          )}
          <RepositoryProvider value={session.repositories}>
            <Editor
              key={session.draft.document.id}
              id={session.draft.document.id}
              guestContext={{ requestLogin }}
            />
          </RepositoryProvider>
        </div>
      ) : (
        <main className="guest-setup panel">
          <Link href="/">← 메인으로</Link>
          <h1>로그인 없이 공간을 꾸며보세요</h1>
          <p>공간 크기를 정하고 자재를 검색해서 배치할 수 있어요.</p>
          {error && (
            <p role="alert" className="error">
              {error} <button onClick={() => setAttempt((v) => v + 1)}>다시 확인</button>{' '}
              <button onClick={resetDraft}>체험 초기화</button>
            </p>
          )}
          <button className="btn primary" onClick={() => setRoomOpen(true)}>
            새 프로젝트
          </button>
        </main>
      )}
      {roomOpen && (
        <RoomDialog
          initial={DEFAULT_ROOM}
          mode="create"
          onClose={closeRoom}
          onApply={async (room) => {
            roomCreation.current?.abort();
            const controller = new AbortController();
            roomCreation.current = controller;
            try {
              await createGuestDraft(room, { signal: controller.signal });
              if (controller.signal.aborted || roomCreation.current !== controller) return;
              setRoomOpen(false);
              setAttempt((v) => v + 1);
            } finally {
              if (roomCreation.current === controller) roomCreation.current = null;
            }
          }}
        />
      )}
      {feature && <LoginPrompt resumeGuest={!!session} onClose={() => setFeature('')} />}
    </>
  );
}
