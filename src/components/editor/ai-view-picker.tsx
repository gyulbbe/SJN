'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw } from 'lucide-react';
import {
  clampFluxDirection,
  FLUX_FRONT,
  FLUX_TURN_STEP,
  fluxEyeView,
  type FluxDirection,
} from '@/lib/ai-export/view';
import type { RoomDimensions } from '@/lib/room-types';
import type { RoomViewState } from '@/lib/room-viewer/view-state';

/** A live 3D view of the After, drawn by the same renderer class and camera as the AI input. */
export type AiPreview = {
  canvas: HTMLCanvasElement;
  render: (width: number, height: number, view: RoomViewState) => void;
  dispose: () => void;
};
/** Dragging across the whole view turns this many degrees (grabbing the room). */
const DRAG_DEGREES = 90;
const LIMIT_NOTICE = '앞쪽은 벽이 없어서 이 방향까지만 볼 수 있어요.';

/**
 * Turns the AI input's camera: drag (mouse or touch), the arrow buttons or the arrow keys, 5° a
 * press; "정면으로" goes back to the back wall. A direction that would show the open front stops at
 * the limit with a short notice. Locked while a conversion runs. The picture has the input's aspect.
 */
export default function AiViewPicker({
  room,
  aspect,
  prepare,
  composite,
  direction,
  onDirection,
  locked,
}: {
  room: RoomDimensions;
  /** The AI input's width ÷ height. */
  aspect: number;
  /** A prepared renderer of this After (photo angles as the chosen method captures them). */
  prepare: (composite: boolean) => Promise<AiPreview>;
  composite: boolean;
  direction: FluxDirection;
  onDirection: (direction: FluxDirection) => void;
  locked: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<AiPreview>();
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [notice, setNotice] = useState('');
  const drag = useRef<{ x: number; y: number; from: FluxDirection } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const job: { alive: boolean; made?: AiPreview } = { alive: true };
    setPreview(undefined);
    setError('');
    prepare(composite)
      .then((ready) => {
        job.made = ready;
        if (!job.alive) return ready.dispose();
        setPreview(ready);
      })
      .catch((cause) => {
        if (job.alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      job.alive = false;
      job.made?.dispose();
    };
  }, [prepare, composite]);
  useEffect(() => {
    const element = host.current;
    if (!element || !preview) return;
    const canvas = preview.canvas;
    element.appendChild(canvas);
    return () => canvas.remove();
  }, [preview]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!preview || width < 1) return;
    const id = requestAnimationFrame(() => {
      try {
        const scale = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.min(960, Math.round(width * scale)));
        preview.render(w, Math.max(1, Math.round(w / aspect)), fluxEyeView(room, direction));
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [preview, width, aspect, room, direction]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  function turn(from: FluxDirection, to: FluxDirection) {
    if (locked) return;
    const { direction: next, blocked } = clampFluxDirection(room, aspect, from, to);
    clearTimeout(noticeTimer.current);
    if (blocked) {
      setNotice(LIMIT_NOTICE);
      noticeTimer.current = setTimeout(() => setNotice(''), 2500);
    } else setNotice('');
    if (next.yaw !== direction.yaw || next.pitch !== direction.pitch) onDirection(next);
  }
  const step = (yaw: number, pitch: number) =>
    turn(direction, { yaw: direction.yaw + yaw, pitch: direction.pitch + pitch });
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (locked || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: direction };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || locked) return;
    const perPixel = DRAG_DEGREES / Math.max(1, event.currentTarget.clientWidth);
    // Grabbing the room: dragging right turns the camera left, dragging down tilts it up.
    turn(direction, {
      yaw: start.from.yaw - (event.clientX - start.x) * perPixel,
      pitch: start.from.pitch + (event.clientY - start.y) * perPixel,
    });
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const move = {
      ArrowLeft: [-FLUX_TURN_STEP, 0],
      ArrowRight: [FLUX_TURN_STEP, 0],
      ArrowUp: [0, FLUX_TURN_STEP],
      ArrowDown: [0, -FLUX_TURN_STEP],
    }[event.key];
    if (!move) return;
    event.preventDefault();
    step(move[0], move[1]);
  }
  const buttons = [
    ['왼쪽으로 5° 돌리기', ArrowLeft, -FLUX_TURN_STEP, 0],
    ['위로 5° 돌리기', ArrowUp, 0, FLUX_TURN_STEP],
    ['아래로 5° 돌리기', ArrowDown, 0, -FLUX_TURN_STEP],
    ['오른쪽으로 5° 돌리기', ArrowRight, FLUX_TURN_STEP, 0],
  ] as const;
  const round = (value: number) => Math.round(value);
  return (
    <div className="mb-3 min-w-0" role="group" aria-label="AI 입력 방향">
      <div className="mb-1.5 text-xs font-semibold text-[color:var(--ink)]">AI 입력 방향</div>
      <div
        ref={host}
        tabIndex={locked ? -1 : 0}
        role="application"
        aria-roledescription="3D 방향 미리보기"
        aria-label={`AI 입력 미리보기 · 좌우 ${round(direction.yaw)}°, 위아래 ${round(direction.pitch)}°. 방향키로 돌려요.`}
        data-testid="flux-view-preview"
        data-yaw={direction.yaw}
        data-pitch={direction.pitch}
        className={`relative w-full max-w-[600px] touch-none [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full select-none overflow-hidden rounded-[var(--radius-sm,8px)] bg-[#e8e8e4] outline-offset-2 focus-visible:outline focus-visible:outline-2 ${locked ? 'cursor-not-allowed opacity-70' : 'cursor-grab active:cursor-grabbing'}`}
        style={{ aspectRatio: String(aspect) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {!preview && (
          <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-[color:var(--muted)]">
            {error || '3D 미리보기를 준비하는 중이에요.'}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {buttons.map(([label, Icon, yaw, pitch]) => (
          <button
            key={label}
            type="button"
            className="btn"
            aria-label={label}
            title={label}
            disabled={locked}
            onClick={() => step(yaw, pitch)}
          >
            <Icon size={15} />
          </button>
        ))}
        <button
          type="button"
          className="btn"
          disabled={locked}
          onClick={() => turn(direction, FLUX_FRONT)}
          aria-label="정면으로"
        >
          <RotateCcw size={15} />
          정면으로
        </button>
        <span className="text-xs text-[color:var(--muted)]" data-testid="flux-view-readout">
          좌우 {round(direction.yaw)}° · 위아래 {round(direction.pitch)}°
        </span>
      </div>
      <div className="mt-1.5 min-h-[1.25rem] text-xs leading-relaxed text-[color:var(--muted)]" role="status">
        {notice ||
          (preview && !error
            ? '끌거나 화살표로 돌려 원하는 방향을 잡은 뒤 변환하세요. 이 화면 그대로 AI에 보내요.'
            : '')}
      </div>
    </div>
  );
}
