'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Ruler, X } from 'lucide-react';
import type { RoomDefinition } from '@/lib/room-types';
import { renderRoomBackground } from '@/lib/room-background';
import styles from './room-dialog.module.css';

type Props = {
  initial: RoomDefinition;
  mode: 'create' | 'resize';
  resetWarnings?: string[];
  affectedDesignCount?: number;
  onRestore?: () => void;
  onRedoRestore?: () => void;
  onApply: (room: RoomDefinition) => Promise<void>;
  onClose: () => void;
};

function dimension(value: string, minimum: number, maximum: number) {
  const number = Number(value);
  return value.trim() && Number.isFinite(number) && number >= minimum && number <= maximum
    ? Math.round(number * 1000)
    : null;
}

export default function RoomDialog({
  initial,
  mode,
  resetWarnings = [],
  affectedDesignCount = 0,
  onRestore,
  onRedoRestore,
  onApply,
  onClose,
}: Props) {
  const [width, setWidth] = useState(String(initial.widthMm / 1000));
  const [depth, setDepth] = useState(String(initial.depthMm / 1000));
  const [height, setHeight] = useState(String(initial.heightMm / 1000));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const previewUrl = useRef('');
  const submitting = useRef(false);
  const mounted = useRef(true);
  const closeRef = useRef(onClose);
  const widthMm = dimension(width, 0.5, 20);
  const depthMm = dimension(depth, 0.5, 20);
  const heightMm = dimension(height, 1, 6);
  const valid = widthMm !== null && depthMm !== null && heightMm !== null;
  const needsConfirmation = resetWarnings.length > 0;

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    mounted.current = true;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    firstInput.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const focusable = Array.from(
          formRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0],
          last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', keydown, true);
    return () => {
      mounted.current = false;
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown, true);
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    if (widthMm === null || depthMm === null || heightMm === null) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPreviewBusy(true);
      setPreviewError('');
      try {
        const image = await renderRoomBackground({ widthMm, depthMm, heightMm }, { width: 768, height: 512 });
        if (cancelled) return;
        const nextUrl = URL.createObjectURL(image.blob);
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = nextUrl;
        setPreview(nextUrl);
      } catch (failure) {
        if (!cancelled)
          setPreviewError(failure instanceof Error ? failure.message : '공간 미리보기를 만들지 못했어요.');
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [widthMm, depthMm, heightMm]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (!valid || (needsConfirmation && !confirmed) || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await onApply({ kind: 'parametric', version: 1, widthMm, depthMm, heightMm });
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : '공간을 만들지 못했어요. 다시 시도해 주세요.');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} onKeyDown={(event) => event.stopPropagation()}>
      <form
        ref={formRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="공간 크기 설정"
        aria-describedby="room-description"
        onSubmit={submit}
        noValidate
      >
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>나의 공간 설정</span>
            <h2>공간 크기를 알려주세요</h2>
          </div>
          <button className={styles.close} type="button" aria-label="공간 크기 설정 닫기" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className={styles.body}>
          <p id="room-description" className={styles.description}>
            {mode === 'create' && 'Before와 After 모두 빈 공간으로 시작하고, After에서 새 디자인을 꾸며요. '}
            방의 크기에 맞춰 타일 크기와 반복, 제품의 표시 크기와 자재 수량·금액 수량을 맞춰요.
          </p>
          {mode === 'resize' && (
            <div className={styles.hint}>
              <strong>
                Before와 시안 {affectedDesignCount}개의 크기·면적 연동 자재 수량·금액을 함께 변경해요.
              </strong>
              <p>
                적용하면 각 시안의 실행 취소는 새 크기에서 시작해요. 최근 크기 변경 한 번은 아래 전체 복원으로
                되돌릴 수 있어요.
              </p>
              {(onRestore || onRedoRestore) && (
                <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  {onRestore && (
                    <button type="button" className="btn small" disabled={busy} onClick={onRestore}>
                      크기 변경 직전 전체 복원
                    </button>
                  )}
                  {onRedoRestore && (
                    <button type="button" className="btn small" disabled={busy} onClick={onRedoRestore}>
                      전체 다시 실행
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className={styles.preview} aria-busy={previewBusy && valid}>
            {preview && !previewError && (
              <Image
                unoptimized
                src={preview}
                alt="입력한 크기에 맞춘 빈 공간 미리보기"
                width={768}
                height={512}
              />
            )}
            {previewError ? (
              <p role="alert">{previewError}</p>
            ) : (
              !preview && <span>빈 공간 미리보기를 준비하고 있어요…</span>
            )}
            {preview && !previewError && previewBusy && valid && (
              <span className={styles.previewStatus}>크기에 맞추고 있어요…</span>
            )}
            {!valid && (
              <span className={styles.previewStatus}>유효한 크기를 입력하면 미리보기가 바뀌어요.</span>
            )}
          </div>
          <div className={styles.fields}>
            <label>
              가로 (m)
              <input
                ref={firstInput}
                aria-label="가로 (m)"
                type="number"
                inputMode="decimal"
                min="0.5"
                max="20"
                step="0.01"
                value={width}
                disabled={busy}
                aria-invalid={attempted && widthMm === null}
                aria-describedby="room-width-hint"
                onChange={(event) => {
                  setWidth(event.target.value);
                  setError('');
                }}
              />
              <small id="room-width-hint" className={attempted && widthMm === null ? styles.invalid : ''}>
                0.5–20m
              </small>
            </label>
            <label>
              깊이 (m)
              <input
                aria-label="깊이 (m)"
                type="number"
                inputMode="decimal"
                min="0.5"
                max="20"
                step="0.01"
                value={depth}
                disabled={busy}
                aria-invalid={attempted && depthMm === null}
                aria-describedby="room-depth-hint"
                onChange={(event) => {
                  setDepth(event.target.value);
                  setError('');
                }}
              />
              <small id="room-depth-hint" className={attempted && depthMm === null ? styles.invalid : ''}>
                0.5–20m
              </small>
            </label>
            <label>
              높이 (m)
              <input
                aria-label="높이 (m)"
                type="number"
                inputMode="decimal"
                min="1"
                max="6"
                step="0.01"
                value={height}
                disabled={busy}
                aria-invalid={attempted && heightMm === null}
                aria-describedby="room-height-hint"
                onChange={(event) => {
                  setHeight(event.target.value);
                  setError('');
                }}
              />
              <small id="room-height-hint" className={attempted && heightMm === null ? styles.invalid : ''}>
                1–6m
              </small>
            </label>
          </div>
          <div className={styles.area}>
            <Ruler size={18} />
            <span>
              바닥 면적{' '}
              <strong>
                {widthMm !== null && depthMm !== null
                  ? ((widthMm * depthMm) / 1_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 4 }) +
                    ' ㎡'
                  : '—'}
              </strong>
            </span>
          </div>
          <p className={styles.hint}>
            기본값은 2.4 × 2.4 × 2.4m예요. 실제 치수를 측정한 경우 그 값으로 바꿔주세요. 입력한 값은 공간
            설정값으로 저장돼요.
          </p>
          {needsConfirmation && (
            <section className={styles.warnings}>
              <h3>크기를 바꾸면 다음 수동 보정을 초기화해요</h3>
              <ul>
                {resetWarnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
              <p>
                현재 자재와 제품은 유지해요. 적용한 뒤 이 화면의 전체 복원으로 모든 시안을 변경 직전으로
                되돌릴 수 있어요.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                수동 보정 초기화 확인
              </label>
            </section>
          )}
          {attempted && !valid && (
            <p role="alert" className={styles.error}>
              가로·깊이는 0.5–20m, 높이는 1–6m 범위로 입력해 주세요.
            </p>
          )}
          {attempted && needsConfirmation && !confirmed && (
            <p role="alert" className={styles.error}>
              초기화되는 수동 보정을 확인해 주세요.
            </p>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </div>
        <footer className={styles.footer}>
          <button className={styles.button} type="button" onClick={onClose}>
            취소
          </button>
          <button className={styles.primary} type="submit" disabled={busy}>
            {busy ? '공간을 준비하고 있어요…' : mode === 'create' ? '공간 만들기' : '크기 적용'}
          </button>
        </footer>
      </form>
    </div>
  );
}
