'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { BackgroundRemovalClient } from '@/lib/background-removal/client';
import type { BackgroundRemovalProgress, BackgroundRemovalResult } from '@/lib/background-removal/types';
import { resolveBackgroundRemovalInput } from '@/lib/background-removal/source';
import styles from './background-removal-test.module.css';

type Source = { url: string; width: number; height: number; name: string; label: string };
type Center = { x: number; y: number };
const ZOOM_OPTIONS = [25, 50, 100, 200, 400, 800];
const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(2)}초`;

export function BackgroundRemovalTest({
  assetId,
  direction,
  onClose,
}: {
  assetId: string;
  direction: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const originalViewport = useRef<HTMLDivElement>(null);
  const resultViewport = useRef<HTMLDivElement>(null);
  const clientRef = useRef<BackgroundRemovalClient | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<Source>();
  const [result, setResult] = useState<BackgroundRemovalResult>();
  const [resultUrl, setResultUrl] = useState('');
  const [busy, setBusy] = useState(true);
  const [progress, setProgress] = useState<BackgroundRemovalProgress>({
    stage: 'checking',
    message: '선택한 제품 사진을 준비하고 있어요.',
  });
  const [error, setError] = useState('');
  const [background, setBackground] = useState<'checker' | 'white' | 'black'>('checker');
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [center, setCenter] = useState<Center>({ x: 0.5, y: 0.5 });
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const drag = useRef<{ pointerId: number; x: number; y: number; center: Center } | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const measure = () => {
      const areas = [originalViewport.current, resultViewport.current].filter(
        (area): area is HTMLDivElement => !!area,
      );
      if (areas.length)
        setViewport({
          width: Math.min(...areas.map((area) => area.clientWidth)),
          height: Math.min(...areas.map((area) => area.clientHeight)),
        });
    };
    const observer = new ResizeObserver(measure);
    if (originalViewport.current) observer.observe(originalViewport.current);
    if (resultViewport.current) observer.observe(resultViewport.current);
    measure();
    return () => {
      observer.disconnect();
      dialog?.close();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let activeClient: BackgroundRemovalClient | undefined;
    const urls: string[] = [];
    setBusy(true);
    setError('');
    setSource(undefined);
    setResult(undefined);
    setResultUrl('');
    setZoom('fit');
    setCenter({ x: 0.5, y: 0.5 });
    setProgress({ stage: 'checking', message: '선택한 제품 사진의 원본을 준비하고 있어요.' });
    void (async () => {
      const { asset: input, sourceLabel } = await resolveBackgroundRemovalInput(assetId);
      if (!alive) return;
      const originalUrl = URL.createObjectURL(input.blob);
      urls.push(originalUrl);
      setSource({
        url: originalUrl,
        width: input.width,
        height: input.height,
        name: input.name,
        label: sourceLabel,
      });
      setProgress({ stage: 'loading-runtime', message: 'AI 실행 모듈을 불러오고 있어요.' });
      const { BackgroundRemovalClient: Client } = await import('@/lib/background-removal/client');
      if (!alive) return;
      activeClient = new Client();
      clientRef.current = activeClient;
      const completed = await activeClient.run(input.blob, (next) => {
        if (alive) setProgress(next);
      });
      if (!alive) return;
      const url = URL.createObjectURL(completed.blob);
      urls.push(url);
      setResult(completed);
      setResultUrl(url);
    })()
      .catch((reason: unknown) => {
        if (alive)
          setError(reason instanceof Error ? reason.message : '배경 제거에 실패했어요. 다시 시도해 주세요.');
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      activeClient?.dispose();
      if (clientRef.current === activeClient) clientRef.current = null;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [assetId, attempt]);

  const fitScale = source ? Math.min(viewport.width / source.width, viewport.height / source.height, 1) : 1;
  const scale = zoom === 'fit' ? fitScale : zoom / 100;
  const zoomPercent = Math.round(scale * 100);
  const changeZoom = (value: number | 'fit') => {
    setZoom(value);
    if (value === 'fit') setCenter({ x: 0.5, y: 0.5 });
  };
  const constrain = (value: Center): Center => {
    if (!source) return { x: 0.5, y: 0.5 };
    const halfX = Math.min(0.5, viewport.width / (2 * source.width * scale));
    const halfY = Math.min(0.5, viewport.height / (2 * source.height * scale));
    return {
      x: Math.max(halfX, Math.min(1 - halfX, value.x)),
      y: Math.max(halfY, Math.min(1 - halfY, value.y)),
    };
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!source || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      center: constrain(center),
    };
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !source || drag.current.pointerId !== event.pointerId) return;
    setCenter(
      constrain({
        x: drag.current.center.x - (event.clientX - drag.current.x) / (source.width * scale),
        y: drag.current.center.y - (event.clientY - drag.current.y) / (source.height * scale),
      }),
    );
  };
  const keyPan = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!source) return;
    const delta = (
      {
        ArrowLeft: { x: -50, y: 0 },
        ArrowRight: { x: 50, y: 0 },
        ArrowUp: { x: 0, y: -50 },
        ArrowDown: { x: 0, y: 50 },
      } as Record<string, Center>
    )[event.key];
    if (!delta) return;
    event.preventDefault();
    const current = constrain(center);
    setCenter(
      constrain({
        x: current.x + delta.x / (source.width * scale),
        y: current.y + delta.y / (source.height * scale),
      }),
    );
  };
  const imageStyle = source
    ? {
        width: source.width,
        height: source.height,
        transform: `translate(${-constrain(center).x * source.width * scale}px, ${-constrain(center).y * source.height * scale}px) scale(${scale})`,
      }
    : undefined;
  const download = () => {
    if (!resultUrl || !source) return;
    const anchor = document.createElement('a');
    anchor.href = resultUrl;
    anchor.download = `${source.name.split('.').slice(0, -1).join('.') || source.name}_AI_배경제거_테스트.png`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };
  const close = () => {
    clientRef.current?.dispose();
    onClose();
  };
  const downloadPercent =
    progress.stage === 'download' && progress.totalBytes && progress.loadedBytes !== undefined
      ? Math.min(100, (progress.loadedBytes / progress.totalBytes) * 100)
      : undefined;

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="background-removal-title"
      aria-describedby="background-removal-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>제품 사진 · {direction}</span>
          <h2 id="background-removal-title">AI 배경 제거 테스트</h2>
          <p id="background-removal-description">
            테스트 미리보기예요. 원본과 등록된 제품에는 적용하지 않아요.
          </p>
        </div>
        <button type="button" className="btn" onClick={close}>
          {busy ? '취소하고 닫기' : '닫기'}
        </button>
      </header>
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <div className={styles.backgrounds} role="group" aria-label="비교 배경색">
            {(
              [
                ['checker', '체크무늬'],
                ['white', '흰색'],
                ['black', '검은색'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`btn small ${background === value ? 'active' : ''}`}
                aria-pressed={background === value}
                onClick={() => setBackground(value)}
              >
                <span className={`${styles.swatch} ${styles[value]}`} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <label className={styles.zoom}>
            확대
            <select
              className="input"
              aria-label="미리보기 확대"
              value={zoom}
              disabled={!source}
              onChange={(event) =>
                changeZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))
              }
            >
              <option value="fit">화면 맞춤</option>
              {ZOOM_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}%{value === 100 ? ' · 실제 크기' : ''}
                </option>
              ))}
            </select>
            <span className={styles.zoomValue}>{source ? `${zoomPercent}%` : '—'}</span>
          </label>
        </div>
        <p className={styles.navigationHint}>
          두 사진의 확대·이동이 함께 바뀌어요. 확대 후 드래그하거나 방향키로 가장자리를 확인하세요.
        </p>
        <div className={styles.comparison}>
          {(['original', 'result'] as const).map((kind) => (
            <section key={kind} className={styles.imageCard}>
              <h3>{kind === 'original' ? '원본' : '배경 제거 결과'}</h3>
              <div
                ref={kind === 'original' ? originalViewport : resultViewport}
                className={`${styles.viewport} ${styles[background]}`}
                tabIndex={0}
                role="region"
                aria-label={kind === 'original' ? '원본 사진 확대 보기' : '배경 제거 결과 확대 보기'}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onLostPointerCapture={() => {
                  drag.current = null;
                }}
                onKeyDown={keyPan}
              >
                {(kind === 'original' && source) || (kind === 'result' && resultUrl) ? (
                  <img
                    className={styles.image}
                    src={kind === 'original' ? source!.url : resultUrl}
                    alt={kind === 'original' ? 'AI 테스트 원본 사진' : 'AI 배경 제거 결과'}
                    data-testid={`background-removal-${kind}`}
                    draggable={false}
                    style={imageStyle}
                  />
                ) : (
                  <span className={styles.placeholder}>
                    {kind === 'original'
                      ? '원본 사진을 불러오고 있어요.'
                      : busy
                        ? 'AI가 처리 중이에요.'
                        : '아직 결과가 없어요.'}
                  </span>
                )}
              </div>
            </section>
          ))}
        </div>
        {source && <p className={styles.sourceLabel}>{source.label}</p>}
        {busy && (
          <div role="status" className={styles.progress} aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            <div>
              <strong>{progress.message}</strong>
              {progress.stage === 'download' && (
                <>
                  <progress max="100" value={downloadPercent} aria-label="모델 다운로드 진행" />
                  {progress.loadedBytes !== undefined && (
                    <span>
                      {(progress.loadedBytes / 1_048_576).toFixed(1)} MB
                      {progress.totalBytes ? ` / ${(progress.totalBytes / 1_048_576).toFixed(1)} MB` : ''}
                    </span>
                  )}
                </>
              )}
              <p>
                저장된 모델을 먼저 사용하고, 필요한 모델이 없을 때 다운로드해요. 사진은 이 브라우저에서만
                처리해요.
              </p>
            </div>
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            <strong>배경 제거를 완료하지 못했어요.</strong>
            <p>{error}</p>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setAttempt((value) => value + 1);
              }}
            >
              다시 시도
            </button>
          </div>
        )}
        {result && source && (
          <div className={styles.report} aria-live="polite">
            <dl className={styles.dimensions}>
              <div>
                <dt>입력 사진</dt>
                <dd>
                  {source.width} × {source.height} px
                </dd>
              </div>
              <div>
                <dt>AI 분석 해상도</dt>
                <dd>
                  {result.analysisWidth} × {result.analysisHeight} px
                </dd>
              </div>
              <div>
                <dt>저장 해상도</dt>
                <dd>
                  {result.width} × {result.height} px · 투명 PNG
                </dd>
              </div>
            </dl>
            <dl className={styles.timings}>
              <div>
                <dt>모델 다운로드</dt>
                <dd data-testid="background-removal-download-time">{seconds(result.downloadMs)}</dd>
                <small>
                  {result.cacheSource === 'network'
                    ? '네트워크 사용'
                    : result.cacheSource === 'cache'
                      ? '브라우저 캐시 사용'
                      : '메모리 재사용'}
                </small>
              </div>
              <div>
                <dt>모델 준비</dt>
                <dd data-testid="background-removal-initialization-time">
                  {seconds(result.initializationMs)}
                </dd>
                <small>실행 모듈·캐시 관리·초기화</small>
              </div>
              <div>
                <dt>이미지 처리</dt>
                <dd data-testid="background-removal-processing-time">{seconds(result.processingMs)}</dd>
                <small>사진 준비·추론·PNG 변환</small>
              </div>
              <div>
                <dt>그중 AI 추론</dt>
                <dd data-testid="background-removal-inference-time">{seconds(result.inferenceMs)}</dd>
                <small>
                  {result.backend === 'webgpu' ? 'WebGPU' : 'CPU · WASM'} / {result.precision.toUpperCase()}
                </small>
              </div>
            </dl>
            {result.fallbackReason && <p className={styles.notice}>{result.fallbackReason}</p>}
            {result.cacheNotice && <p className={styles.notice}>{result.cacheNotice}</p>}
            <p className={styles.note}>
              모델: studioludens/birefnet-lite-512. 분석한 마스크를 입력 크기로 확대해 저장하므로, 원본 크기의
              PNG여도 가는 부품이나 반투명 경계가 완벽하게 복원되지는 않아요. 원래 투명했던 부분은 결과에서도
              유지해요.
            </p>
          </div>
        )}
      </div>
      <footer className={styles.footer}>
        <span>배경색은 미리보기에만 사용하고 PNG는 투명하게 저장해요.</span>
        <button type="button" className="btn primary" disabled={!result || busy} onClick={download}>
          투명 PNG 다운로드
        </button>
      </footer>
    </dialog>
  );
}
