'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Download,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import type { MaterialVersion, ProjectDocument, RenderSnapshot } from '@/lib/types';
import type { AssetReader } from '@/lib/render/compositor';
import { getActiveDesign } from '@/lib/comparison';
import { ROOM_PHOTO_EXPORT_QUALITY, RoomViewerRenderer } from '@/lib/room-viewer/renderer';
import { ProgressMeter } from '@/components/progress-meter';
import { projectDesignPreviewRoomContext } from '@/lib/render/design-preview-context';
import {
  clampRoomEye,
  moveRoomEye,
  resetRoomView,
  roomEyeView,
  ROOM_EYE_DEFAULT_SHIFT,
  ROOM_EYE_FOV,
  sourceRoomViewAvailable,
  normalizeRoomView,
  rotateRoomView,
  roomViewLabel,
  roomViewViewport,
  zoomRoomEye,
  type RoomEyePreset,
  type RoomViewState,
} from '@/lib/room-viewer/view-state';
import styles from './room-viewer.module.css';
import { LoginRequiredIcon, useEditingCapabilities } from '../editor/editing-capabilities';

type Mode = 'before' | 'after' | 'split' | 'compare';
type Props = {
  project: ProjectDocument;
  materials: Record<string, MaterialVersion>;
  assetReader: AssetReader;
  writable: boolean;
  onView: (view: RoomViewState) => void;
  saveStatus: 'saved' | 'dirty' | 'saving' | 'error';
  saveError: string;
  onSave: () => void;
  onDesign: (id: string) => void;
  onClose: () => void;
};
const directionButtons = [
  ['left', '왼쪽 90°', ArrowLeft],
  ['right', '오른쪽 90°', ArrowRight],
  ['up', '위로 90°', ArrowUp],
  ['down', '아래로 90°', ArrowDown],
] as const;
/** Inside the room the same buttons turn the head a little and shift the frame (verticals stay upright). */
const eyeDirectionLabels = {
  left: '왼쪽 15°',
  right: '오른쪽 15°',
  up: '위로 보기',
  down: '아래로 보기',
} as const;
const eyePresets: [RoomEyePreset, string][] = [
  ['center', '방 안 · 가운데'],
  ['left-corner', '방 안 · 왼쪽 모서리'],
  ['right-corner', '방 안 · 오른쪽 모서리'],
];
const eyeMoves = [
  ['forward', '앞으로'],
  ['back', '뒤로'],
  ['left', '왼쪽으로 이동'],
  ['right', '오른쪽으로 이동'],
] as const;

export default function RoomViewer({
  project,
  materials,
  assetReader,
  writable,
  onView,
  saveStatus,
  saveError,
  onSave,
  onDesign,
  onClose,
}: Props) {
  const { guest, requestLogin } = useEditingCapabilities();
  const requireLogin = (feature: string) => {
    if (!guest) return false;
    onClose();
    requestLogin(feature);
    return true;
  };
  const dialog = useRef<HTMLDialogElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [renderer, setRenderer] = useState<RoomViewerRenderer | null>(null);
  const [view, setView] = useState(() => normalizeRoomView(project.roomView));
  const [requestedMode, setMode] = useState<Mode>(() => (guest ? 'after' : 'split'));
  const mode: Mode = guest ? 'after' : requestedMode;
  const [split, setSplit] = useState(0.5);
  const [box, setBox] = useState({ width: 1000, height: 650, dpr: 1 });
  const [readySnapshot, setReadySnapshot] = useState<{ renderer: RoomViewerRenderer; key: string } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState(false);
  /** Samples averaged so far for a high-quality download. */
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const exportAbort = useRef<AbortController | null>(null);
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [exportMode, setExportMode] = useState<'after' | 'compare'>('compare');
  const [frame, setFrame] = useState(0);
  const [notices, setNotices] = useState<RoomViewerRenderer['notices']>([]);
  const live = useRef(true);
  const urls = useRef(new Set<string>());
  const viewRef = useRef(view);
  viewRef.current = view;
  const after = getActiveDesign(project)?.scene ?? project.shared.baseline;
  const before = project.shared.comparison?.before ?? project.shared.baseline;
  const design = getActiveDesign(project);
  // Scene inputs exclude view, names, costs and their revisions. Camera changes never rebuild geometry.
  const fitScenes = projectDesignPreviewRoomContext(project)?.fitScenes;
  const fitScenesRef = useRef(fitScenes);
  fitScenesRef.current = fitScenes;
  const sceneKey = JSON.stringify([after, before, materials, fitScenes]);
  // A cached preparation can finish in one React batch. Track its identity rather than a boolean.
  const prepared = readySnapshot?.renderer === renderer && readySnapshot?.key === sceneKey;
  const snapshotRef = useRef<RenderSnapshot>({ scene: after, beforeScene: before, materials });
  snapshotRef.current = { scene: after, beforeScene: before, materials };
  const aspect = after.imageWidth / after.imageHeight;
  const displayAspect = aspect * (mode === 'compare' ? 2 : 1);
  const fit = useMemo(() => {
    const width = Math.max(1, Math.min(box.width, box.height * displayAspect));
    return { width, height: width / displayAspect };
  }, [box.width, box.height, displayAspect]);
  const update = useCallback(
    (next: RoomViewState) => {
      const normalized = normalizeRoomView(next);
      viewRef.current = normalized;
      setView(normalized);
      if (writable) onView(normalized);
    },
    [onView, writable],
  );
  const externalView = JSON.stringify(project.roomView ?? null);
  useEffect(() => {
    // Shared workspace restore/adoption can change the camera while this dialog stays open.
    const id = requestAnimationFrame(() => {
      const incoming = normalizeRoomView(JSON.parse(externalView));
      if (JSON.stringify(incoming) !== JSON.stringify(viewRef.current)) {
        viewRef.current = incoming;
        setView(incoming);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [externalView]);
  const turn = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      update(rotateRoomView(viewRef.current, direction));
    },
    [update],
  );

  useEffect(() => {
    live.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    const oldOverflow = document.body.style.overflow;
    const createdUrls = urls.current;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    viewport.current?.focus();
    return () => {
      live.current = false;
      exportAbort.current?.abort();
      document.body.style.overflow = oldOverflow;
      element?.close();
      previousFocus?.focus();
      for (const url of createdUrls) URL.revokeObjectURL(url);
      createdUrls.clear();
    };
  }, []);
  useEffect(() => {
    let instance: RoomViewerRenderer;
    try {
      setReadySnapshot(null);
      setError('');
      instance = new RoomViewerRenderer();
      host.current?.appendChild(instance.canvas);
      instance.canvas.setAttribute('aria-label', '현재 시점의 Before After 공간');
      setRenderer(instance);
    } catch (cause) {
      setRenderer(null);
      setError('공간 보기를 시작하지 못했어요. ' + (cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    const lost = () => {
      if (!live.current) return;
      setReadySnapshot(null);
      setError('그래픽 연결이 끊겼어요. 현재 시점과 편집 내용은 유지돼요. 다시 시도해 주세요.');
    };
    instance.canvas.addEventListener('webglcontextlost', lost);
    return () => {
      instance.canvas.removeEventListener('webglcontextlost', lost);
      instance.dispose();
      instance.canvas.remove();
    };
  }, [retry]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setBox({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
        dpr: Math.min(2, window.devicePixelRatio || 1),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!renderer) return;
    let cancelled = false;
    setReadySnapshot(null);
    setError('');
    void renderer
      .setSnapshot(snapshotRef.current, assetReader, { fitScenes: fitScenesRef.current })
      .then(() => {
        if (cancelled) return;
        setNotices([...renderer.notices]);
        setReadySnapshot({ renderer, key: sceneKey });
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [renderer, sceneKey, assetReader]);
  useEffect(() => {
    if (!renderer || !prepared) return;
    const id = requestAnimationFrame(() => {
      try {
        const scale = Math.min(box.dpr, 2048 / Math.max(fit.width, fit.height));
        renderer.render(
          Math.max(1, Math.round(fit.width * scale)),
          Math.max(1, Math.round(fit.height * scale)),
          view,
          mode,
          split,
        );
        setNotices([...renderer.notices]);
        setError('');
        setFrame((n) => n + 1);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [renderer, readySnapshot, prepared, view, mode, split, fit.width, fit.height, box.dpr]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      if (current.projection === 'room-eye') {
        update(zoomRoomEye(current, Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.002)));
        return;
      }
      update({
        ...current,
        zoom: Math.max(
          0.25,
          Math.min(8, current.zoom * Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.002)),
        ),
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [update]);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: RoomViewState; x: number; y: number; distance: number } | null>(null);
  function beginGesture() {
    const points = [...pointers.current.values()];
    if (!points.length) {
      gesture.current = null;
      return;
    }
    gesture.current = {
      view: viewRef.current,
      x: points[0].x,
      y: points[0].y,
      distance: points.length > 1 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0,
    };
  }
  async function download() {
    if (requireLogin('이미지 출력')) return;
    if (!renderer || !prepared || exporting) return;
    setExporting(true);
    setError('');
    const controller = new AbortController();
    exportAbort.current = controller;
    const capturedView = structuredClone(viewRef.current);
    const name = `${project.name}-${design?.name ?? '공간'}-${roomViewLabel(capturedView)}`.replace(
      /[<>:"/\\|?*]/g,
      '-',
    );
    try {
      const blob = await renderer.export(capturedView, {
        format,
        mode: exportMode,
        longEdge: 4096,
        quality: ROOM_PHOTO_EXPORT_QUALITY,
        onProgress: (done, total) => {
          if (live.current) setExportProgress({ done, total });
        },
        signal: controller.signal,
      });
      if (!live.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${name}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Keep until dialog cleanup so even a slow browser can acquire the download bytes.
    } catch (cause) {
      const cancelled = cause instanceof DOMException && cause.name === 'AbortError';
      if (live.current && !cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (exportAbort.current === controller) exportAbort.current = null;
      if (live.current) {
        setExporting(false);
        setExportProgress(null);
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="room-view-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.shell} data-testid="room-viewer">
        <header className={styles.header}>
          <div>
            <h2 id="room-view-title">공간 둘러보기</h2>
            <p>
              {guest
                ? '공간을 회전·확대하며 배치를 확인해요.'
                : 'Before와 After를 같은 각도로 확인해요. 배치는 바뀌지 않아요.'}
            </p>
            {view.sourceCamera && (
              <p>
                {after.room && sourceRoomViewAvailable(after.room, view)
                  ? view.sourceCamera.source === 'estimated'
                    ? '사진에서 추정한 촬영 시점이에요. 원본 비율을 유지하며 빈 여백이 생길 수 있어요.'
                    : '저장한 사진 시점이에요. 원본 비율을 유지해요.'
                  : '공간 크기가 바뀌어 이전 사진 시점은 보관 중이에요. 크기 변경 직전 전체 복원으로 돌아갈 수 있어요.'}
              </p>
            )}
          </div>
          <button type="button" className={styles.close} aria-label="공간 둘러보기 닫기" onClick={onClose}>
            <X size={22} />
          </button>
        </header>
        <div className={styles.toolbar}>
          <div className={styles.turns}>
            {directionButtons.map(([direction, orbitLabel, Icon]) => {
              const label = view.projection === 'room-eye' ? eyeDirectionLabels[direction] : orbitLabel;
              return (
                <button
                  type="button"
                  key={direction}
                  onClick={() => turn(direction)}
                  title={view.projection === 'room-eye' ? label : `${label} · 현재 화면 축 기준`}
                >
                  <Icon size={18} />
                  {label}
                </button>
              );
            })}
          </div>
          {after.room && (
            <div className={styles.eye} role="group" aria-label="방 안 시점">
              {eyePresets.map(([preset, label]) => (
                <button
                  type="button"
                  key={preset}
                  onClick={() => update(roomEyeView(after.room!, preset, viewRef.current))}
                >
                  {label}
                </button>
              ))}
              {view.projection === 'room-eye' &&
                eyeMoves.map(([direction, label]) => (
                  <button
                    type="button"
                    key={direction}
                    onClick={() => update(moveRoomEye(after.room!, viewRef.current, direction))}
                  >
                    {label}
                  </button>
                ))}
            </div>
          )}
          <div className={styles.tools}>
            {view.sourceCamera && (
              <>
                <button
                  type="button"
                  aria-pressed={view.projection === 'source-photo'}
                  disabled={!after.room || !sourceRoomViewAvailable(after.room, view)}
                  onClick={() => update(resetRoomView(viewRef.current, 'source-photo'))}
                >
                  사진 시점 보기
                </button>
                <button
                  type="button"
                  aria-pressed={view.projection === 'room-fit'}
                  onClick={() => update(resetRoomView(viewRef.current, 'room-fit'))}
                >
                  전체 공간 보기
                </button>
              </>
            )}
            <button type="button" onClick={() => update(resetRoomView(viewRef.current))}>
              <RotateCcw size={16} />
              {view.projection === 'room-eye' ? '바깥 시점으로' : '기본 시점'}
            </button>
            <button
              type="button"
              onClick={() => {
                const current = viewRef.current;
                update(
                  current.projection === 'room-eye' && current.eye
                    ? {
                        ...current,
                        eye: { ...current.eye, fov: ROOM_EYE_FOV, shift: ROOM_EYE_DEFAULT_SHIFT },
                      }
                    : { ...current, zoom: 1, pan: { x: 0, y: 0 } },
                );
              }}
            >
              <Maximize size={16} />
              화면 맞춤
            </button>
            <button
              type="button"
              aria-label="공간 축소"
              onClick={() =>
                update(
                  viewRef.current.projection === 'room-eye'
                    ? zoomRoomEye(viewRef.current, 1 / 1.1)
                    : { ...viewRef.current, zoom: Math.max(0.25, viewRef.current.zoom / 1.25) },
                )
              }
            >
              <Minus size={17} />
            </button>
            {view.projection === 'room-eye' && view.eye ? (
              <output aria-label="방 안 시점 화각">{Math.round(view.eye.fov)}°</output>
            ) : (
              <output aria-label="공간 확대율">{Math.round(view.zoom * 100)}%</output>
            )}
            <button
              type="button"
              aria-label="공간 확대"
              onClick={() =>
                update(
                  viewRef.current.projection === 'room-eye'
                    ? zoomRoomEye(viewRef.current, 1.1)
                    : { ...viewRef.current, zoom: Math.min(8, viewRef.current.zoom * 1.25) },
                )
              }
            >
              <Plus size={17} />
            </button>
          </div>
        </div>
        <div className={styles.subbar}>
          <div className={styles.modes}>
            {(
              [
                ['before', 'Before'],
                ['after', 'After'],
                ['split', '겹쳐 비교'],
                ['compare', '나란히 비교'],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                aria-pressed={mode === value}
                key={value}
                title={guest && value !== 'after' ? '로그인 필요' : undefined}
                onClick={() => {
                  if (value !== 'after' && requireLogin('Before / After 비교')) return;
                  setMode(value);
                }}
              >
                {label}
                {guest && value !== 'after' && <LoginRequiredIcon />}
              </button>
            ))}
          </div>
          <label>
            시안{guest && <LoginRequiredIcon />}{' '}
            <select
              aria-label="둘러볼 시안"
              title={guest ? '로그인 필요' : undefined}
              value={project.activeDesignId ?? ''}
              disabled={!project.designs.length}
              onChange={(event) => {
                if (!requireLogin('시안 관리')) onDesign(event.target.value);
              }}
            >
              {project.designs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <output className={styles.direction} data-testid="room-view-direction">
            {roomViewLabel(view)}
          </output>
        </div>
        <div
          ref={viewport}
          className={styles.viewport}
          role="group"
          aria-label="공간 보기 · 방향키로 90도 회전, 드래그로 이동"
          tabIndex={0}
          data-testid="room-view-viewport"
          data-view={JSON.stringify(view)}
          data-frame={frame}
          aria-busy={!prepared}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const direction = (
              { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const
            )[event.key as 'ArrowLeft'];
            if (direction) {
              event.preventDefault();
              event.stopPropagation();
              turn(direction);
            } else if (event.key === '0') {
              event.preventDefault();
              update(resetRoomView(viewRef.current));
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || (event.target as HTMLElement).closest('button,input,select,a')) return;
            event.currentTarget.focus();
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            event.currentTarget.setPointerCapture(event.pointerId);
            beginGesture();
          }}
          onPointerMove={(event) => {
            if (!pointers.current.has(event.pointerId) || !gesture.current) return;
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const points = [...pointers.current.values()],
              base = gesture.current;
            if (base.view.projection === 'room-eye' && base.view.eye && after.room) {
              // Drag turns the head (and shifts the frame); pinch changes the lens angle.
              if (points.length > 1 && base.distance > 0)
                update(
                  zoomRoomEye(
                    base.view,
                    Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / base.distance,
                  ),
                );
              else
                update({
                  ...base.view,
                  eye: clampRoomEye(after.room, {
                    ...base.view.eye,
                    yaw: base.view.eye.yaw - ((event.clientX - base.x) / fit.width) * base.view.eye.fov,
                    shift: base.view.eye.shift + (event.clientY - base.y) / fit.height,
                  }),
                });
              return;
            }
            const dragArea =
              base.view.projection === 'source-photo'
                ? roomViewViewport(fit.width / (mode === 'compare' ? 2 : 1), fit.height, base.view)
                : fit;
            if (points.length > 1 && base.distance > 0)
              update({
                ...base.view,
                zoom: Math.max(
                  0.25,
                  Math.min(
                    8,
                    (base.view.zoom * Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)) /
                      base.distance,
                  ),
                ),
              });
            else
              update({
                ...base.view,
                pan: {
                  x: Math.max(-4, Math.min(4, base.view.pan.x + (event.clientX - base.x) / dragArea.width)),
                  y: Math.max(-4, Math.min(4, base.view.pan.y + (event.clientY - base.y) / dragArea.height)),
                },
              });
          }}
          onPointerUp={(event) => {
            pointers.current.delete(event.pointerId);
            beginGesture();
          }}
          onPointerCancel={(event) => {
            pointers.current.delete(event.pointerId);
            beginGesture();
          }}
          onLostPointerCapture={(event) => {
            pointers.current.delete(event.pointerId);
            beginGesture();
          }}
        >
          <div ref={host} className={styles.canvasHost} style={{ width: fit.width, height: fit.height }} />
          {!prepared && !error && (
            <div className={styles.message} role="status">
              공간과 제품을 준비하고 있어요…
            </div>
          )}
          {error && (
            <div className={styles.message} role="alert">
              <p>{error}</p>
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                다시 시도
              </button>
              <button type="button" onClick={onClose}>
                기존 편집으로 돌아가기
              </button>
            </div>
          )}
          <div className={styles.sceneLabels} aria-hidden="true">
            <span>{mode === 'after' ? 'After' : 'Before'}</span>
            {(mode === 'split' || mode === 'compare') && <span>After · {design?.name}</span>}
          </div>
        </div>
        {mode === 'split' && (
          <label className={styles.slider}>
            Before{' '}
            <input
              type="range"
              min="0"
              max="100"
              value={split * 100}
              aria-label="둘러보기 Before After 비교 위치"
              onChange={(event) => setSplit(Number(event.target.value) / 100)}
            />{' '}
            After
          </label>
        )}
        <div className={styles.information}>
          <span>
            {view.projection === 'room-eye'
              ? '방 안 눈높이 시점 · 드래그로 둘러보기 · 휠/핀치로 화각 · 앞벽 쪽은 보지 않아요.'
              : '드래그로 이동 · 휠/핀치로 확대 · 가까운 벽과 바닥은 내부가 보이도록 생략해요.'}
          </span>
          {!writable && <strong>읽기 전용 · 시점은 이 창에서만 유지돼요.</strong>}
        </div>
        {writable && (
          <div className={styles.saveState} role={saveStatus === 'error' ? 'alert' : 'status'}>
            {saveStatus === 'error' ? (
              <>
                시점 저장 실패: {saveError}{' '}
                <button type="button" onClick={onSave}>
                  시점 저장 다시 시도
                </button>
              </>
            ) : saveStatus === 'saved' ? (
              guest ? (
                '이 탭에 시점 임시 보관됨'
              ) : (
                '프로젝트에 시점 저장됨'
              )
            ) : (
              '시점 저장 중…'
            )}
          </div>
        )}
        {!!notices.length && (
          <details className={styles.notices} open={notices.some((notice) => notice.severity === 'error')}>
            <summary>표현 범위와 확인할 항목 {notices.length}개 · 다운로드에도 같은 표현이 적용돼요</summary>
            <ul>
              {notices.map((notice, index) => (
                <li key={`${notice.id}-${index}`}>
                  <strong>
                    {notice.side === 'before' ? 'Before' : 'After'} · {notice.name}
                  </strong>{' '}
                  — {notice.message}
                </li>
              ))}
            </ul>
          </details>
        )}
        {exporting && exportProgress && (
          <div className="mx-5 mb-2 max-[650px]:mx-2.5">
            <ProgressMeter
              compact
              title="고화질로 만드는 중"
              label="고화질 이미지 만들기"
              percent={(exportProgress.done / exportProgress.total) * 100}
              valueText={`고화질 이미지 ${exportProgress.done}/${exportProgress.total}장, ${Math.floor((exportProgress.done / exportProgress.total) * 100)}%`}
              message="여러 장을 겹쳐 부드러운 그림자와 윤곽을 만들어요."
              detail={`${exportProgress.done}/${exportProgress.total}장`}
              testId="room-export-progress"
              percentTestId="room-export-percent"
              action={
                <button type="button" onClick={() => exportAbort.current?.abort()}>
                  다운로드 취소
                </button>
              }
            />
          </div>
        )}
        <footer className={styles.footer}>
          <span>{prepared ? '현재 시점으로 저장' : '준비 후 다운로드할 수 있어요'}</span>
          <label>
            출력{' '}
            <select
              aria-label="둘러보기 출력 종류"
              value={exportMode}
              onChange={(event) => setExportMode(event.target.value as 'after' | 'compare')}
            >
              <option value="compare">Before / After 나란히</option>
              <option value="after">After</option>
            </select>
          </label>
          <label>
            형식{' '}
            <select
              aria-label="둘러보기 파일 형식"
              value={format}
              onChange={(event) => setFormat(event.target.value as 'png' | 'jpeg')}
            >
              <option value="png">PNG</option>
              <option value="jpeg">JPG</option>
            </select>
          </label>
          <button
            type="button"
            className={styles.primary}
            title={guest ? '로그인 필요' : undefined}
            disabled={!guest && (!prepared || exporting || !!error)}
            onClick={() => void download()}
          >
            <Download size={17} />
            {exporting ? '이미지 준비 중…' : '현재 시점 다운로드'}
            {guest && <LoginRequiredIcon />}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
