'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor } from '@/lib/editor-store';
import { useAccess } from '@/components/app-provider';
import { getRepositories } from '@/lib/repositories';
import { createReconstructionProject } from '@/lib/reconstruction';
import styles from './reconstruction.module.css';

export default function ReconstructionRebuild({
  onMaterialsChanged,
}: {
  onMaterialsChanged: () => Promise<void>;
}) {
  const st = useEditor(),
    { writable } = useAccess();
  const [open, setOpen] = useState(false),
    [stage, setStage] = useState(''),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null),
    alive = useRef(true),
    dialog = useRef<HTMLDivElement>(null);
  const canWrite = useRef(writable);
  canWrite.current = writable;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  function close() {
    controller.current?.abort();
    controller.current = null;
    setStage('');
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const focused = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        controller.current?.abort();
        controller.current = null;
        setStage('');
        setOpen(false);
      }
      if (e.key === 'Tab') {
        const nodes = Array.from(
          dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
      if ((e.ctrlKey || e.metaKey) && ['z', 's', 'y'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', key, true);
      if (focused?.isConnected) focused.focus();
    };
  }, [open]);
  async function rebuild() {
    const captured = useEditor.getState().project;
    if (!captured?.shared.comparison || !canWrite.current || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setError('');
    setStage('원본 사진 준비 중');
    const current = () =>
      alive.current &&
      !request.signal.aborted &&
      canWrite.current &&
      useEditor.getState().project?.id === captured.id &&
      useEditor.getState().project?.activeDesignId === captured.activeDesignId &&
      useEditor.getState().project?.editRevision === captured.editRevision &&
      !useEditor.getState().draft;
    try {
      const repo = getRepositories(),
        reference = await repo.assets.get(captured.shared.comparison.referenceOriginalAssetId);
      if (!current()) return;
      const next = await createReconstructionProject(
        new File([reference.blob], reference.name, { type: reference.mime }),
        captured.shared.comparison.room,
        {
          repositories: repo,
          signal: request.signal,
          onStage: (message) => {
            if (current()) setStage(message);
          },
        },
      );
      if (!current()) return;
      await onMaterialsChanged();
      if (!current()) return;
      useEditor.getState().changeProject((p) => {
        if (!p.shared.comparison || !next.shared.comparison) return;
        p.shared.comparison.before = next.shared.comparison.before;
        p.shared.comparison.review = next.shared.comparison.review;
        p.shared.comparison.status = 'draft';
        delete p.thumbnailAssetId;
      });
      useEditor.getState().setEditing('before');
      close();
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : '원본을 다시 분석하지 못했어요.');
    } finally {
      if (controller.current === request) controller.current = null;
      if (alive.current && !request.signal.aborted) setStage('');
    }
  }
  return (
    <>
      <button
        className="btn small"
        style={{ width: '100%', margin: '10px 0' }}
        disabled={!writable || !!st.draft}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        사진 다시 분석
      </button>
      {open &&
        createPortal(
          <div className={styles.backdrop}>
            <div
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-label="Before 사진 다시 분석"
              className={styles.dialog}
            >
              <header className={styles.header}>
                <h2>원본 사진으로 Before 다시 구성</h2>
              </header>
              <div className={styles.body}>
                <p>
                  원본 사진을 자세히 분석해 현재 Before를 새 초안으로 바꿔요. 현재 Before는 실행 취소로 되돌릴
                  수 있어요.
                </p>
                <p className="muted" style={{ marginTop: 12 }}>
                  After의 디자인과 자재 수량·금액은 유지돼요. 여러 번 분석하므로 사진에 따라 시간이 걸릴 수
                  있어요.
                </p>
                {stage && (
                  <p role="status" style={{ marginTop: 18 }}>
                    {stage}
                  </p>
                )}
                {error && (
                  <p role="alert" className="error">
                    {error}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                  <button className="btn" onClick={close}>
                    취소
                  </button>
                  <button
                    className="btn primary"
                    disabled={!!stage || !writable}
                    onClick={() => void rebuild()}
                  >
                    Before 다시 만들기
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
