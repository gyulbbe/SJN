'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ImagePlus, X, ArrowRight } from 'lucide-react';
import { DEFAULT_ROOM } from '@/lib/room-geometry';
import { getRepositories } from '@/lib/repositories';
import { createReconstructionProject } from '@/lib/reconstruction';
import styles from './reconstruction.module.css';

export default function ReconstructionDialog({
  onClose,
  onCreated,
  initialFile = null,
}: {
  initialFile?: File | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [file, setFile] = useState<File | null>(initialFile);
  const [preview, setPreview] = useState('');
  const [width, setWidth] = useState('2.4'),
    [depth, setDepth] = useState('2.4'),
    [height, setHeight] = useState('2.4');
  const [stage, setStage] = useState(''),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    mounted.current = true;
    const focused = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const nodes = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [],
        ).filter((n) => n.getClientRects().length);
        if (event.shiftKey && document.activeElement === nodes[0]) {
          event.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
          event.preventDefault();
          nodes[0]?.focus();
        }
      }
    }
    document.addEventListener('keydown', key, true);
    const requests = controller;
    return () => {
      mounted.current = false;
      requests.current?.abort();
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', key, true);
      if (focused?.isConnected) focused.focus();
    };
  }, []);
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const valid = (v: string, min: number, max: number) =>
    v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;
  const ready = !!file && valid(width, 0.5, 20) && valid(depth, 0.5, 20) && valid(height, 1, 6);
  async function start(manual = false) {
    if (!ready || !file || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setError('');
    setStage(manual ? '참고 사진과 빈 공간을 준비하고 있어요…' : '사진 분석을 준비하고 있어요…');
    try {
      const project = await createReconstructionProject(
        file,
        {
          ...DEFAULT_ROOM,
          widthMm: Math.round(+width * 1000),
          depthMm: Math.round(+depth * 1000),
          heightMm: Math.round(+height * 1000),
        },
        {
          signal: request.signal,
          manual,
          onStage: (message) => {
            if (mounted.current && !request.signal.aborted) setStage(message);
          },
        },
      );
      if (!mounted.current || request.signal.aborted) return;
      setStage('Before 초안을 이 브라우저에 저장하고 있어요…');
      await getRepositories().projects.create(project);
      if (!mounted.current || request.signal.aborted) {
        await getRepositories().projects.remove(project.id);
        return;
      }
      onCreated(project.id);
    } catch (failure) {
      if (mounted.current && !request.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : '사진을 분석하지 못했어요. 다시 시도하거나 직접 구성해 주세요.',
        );
    } finally {
      if (controller.current === request) controller.current = null;
      if (mounted.current) setStage('');
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void start();
  }
  return (
    <div className={styles.backdrop}>
      <form
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="사진으로 비교 공간 만들기"
        className={styles.dialog}
        onSubmit={submit}
      >
        <header className={styles.header}>
          <div>
            <span className="eyebrow">BEFORE → AFTER</span>
            <h2>기존 욕실에서 새 공간으로</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="비교 공간 만들기 닫기" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className={styles.body}>
          <p className={styles.description}>
            사진 속 기존 공간은 Before로 재구성해 보관해요. 생성이 끝나면 같은 크기·같은 각도의 빈 After에서
            새 타일과 제품으로 바로 꾸밀 수 있어요. Before는 나중에 확인하거나 수정할 수 있어요.
          </p>
          <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
            전체 사진과 좌우 반전, 필요한 부분 확대를 차례로 분석해요. 속도보다 원본의 배치와 특징을
            우선하므로 사진에 따라 시간이 걸릴 수 있어요.
          </p>
          <label className={styles.upload}>
            {preview ? (
              <Image unoptimized src={preview} width={750} height={500} alt="재구성할 기존 공간 참고 사진" />
            ) : (
              <>
                <ImagePlus size={30} />
                <strong>기존 공간 사진을 선택하세요</strong>
              </>
            )}
            <span>{file?.name || 'JPG · PNG · WebP / 최대 25MB'}</span>
            <input
              data-testid="reconstruction-upload"
              aria-label="기존 공간 사진"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={!!stage}
              onChange={(e) => {
                const next = e.target.files?.[0];
                e.target.value = '';
                if (!next) return;
                if (next.size > 25 * 1024 * 1024) {
                  setError('사진은 25MB 이하로 선택해 주세요.');
                  return;
                }
                setFile(next);
                setError('');
              }}
            />
          </label>
          <div className={styles.dimensions}>
            {(
              [
                ['가로 (m)', width, setWidth, 0.5, 20],
                ['깊이 (m)', depth, setDepth, 0.5, 20],
                ['높이 (m)', height, setHeight, 1, 6],
              ] as const
            ).map(([label, value, set, min, max]) => (
              <label key={label}>
                {label}
                <input
                  className="input"
                  type="number"
                  aria-label={label}
                  min={min}
                  max={max}
                  step=".01"
                  value={value}
                  disabled={!!stage}
                  onChange={(e) => set(e.target.value)}
                />
                <small>
                  {min}–{max}m
                </small>
              </label>
            ))}
          </div>
          <div className={styles.note}>
            사진은 브라우저 안에서 분석해요. 기존 타일의 색감과 기구 배치를 추정하며, 제품 외형은 유사
            모형으로 표현해요. 가려진 부분과 치수는 초안에서 확인해 주세요.
          </div>
          {stage && (
            <p className={styles.stage} role="status" aria-live="polite">
              {stage}
            </p>
          )}
          {error && (
            <p className="error notice" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className={styles.footer}>
          <button
            className="text-button"
            type="button"
            disabled={!ready || !!stage}
            onClick={() => void start(true)}
          >
            분석 없이 직접 구성
          </button>
          <div className="row">
            <button className="btn" type="button" onClick={onClose}>
              취소
            </button>
            <button className="btn primary" type="submit" disabled={!ready || !!stage}>
              {stage ? '초안 만드는 중…' : '자동 초안 만들기'}
              <ArrowRight size={16} />
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
