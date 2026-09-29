'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, RotateCcw } from 'lucide-react';
import {
  clampFluxOrbit,
  fluxOrbitLabel,
  fluxOrbitView,
  turnFluxOrbit,
  type FluxTurn,
} from '@/lib/ai-export/view';
import type { RoomOrbit, RoomViewState } from '@/lib/room-viewer/view-state';

/** A live 3D view of the After, drawn by the same renderer class and camera as the AI input. */
export type AiPreview = {
  canvas: HTMLCanvasElement;
  render: (width: number, height: number, view: RoomViewState) => void;
  dispose: () => void;
};
/** Dragging across the whole view turns this many degrees (grabbing the room). */
const DRAG_DEGREES = 180;

/**
 * Turns the AI input's camera around the room: drag (mouse or touch; across for the heading, up and
 * down for the height), the buttons or the arrow keys a quarter at a time, "위에서" straight down,
 * "옆에서" level, "정면으로" back to the start. Locked while a conversion runs. The picture has the
 * input's aspect and white backdrop.
 */
export default function AiViewPicker({
  aspect,
  prepare,
  composite,
  orbit,
  onOrbit,
  locked,
}: {
  /** The AI input's width ÷ height. */
  aspect: number;
  /** A prepared renderer of this After (photo angles as the chosen method captures them). */
  prepare: (composite: boolean) => Promise<AiPreview>;
  composite: boolean;
  orbit: RoomOrbit;
  onOrbit: (orbit: RoomOrbit) => void;
  locked: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<AiPreview>();
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const drag = useRef<{ x: number; y: number; from: RoomOrbit } | null>(null);

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
        preview.render(w, Math.max(1, Math.round(w / aspect)), fluxOrbitView(orbit));
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [preview, width, aspect, orbit]);

  function go(next: RoomOrbit) {
    if (locked) return;
    const clamped = clampFluxOrbit(next);
    if (clamped.azimuth !== orbit.azimuth || clamped.elevation !== orbit.elevation) onOrbit(clamped);
  }
  const turn = (to: FluxTurn) => go(turnFluxOrbit(orbit, to));
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (locked || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: orbit };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || locked) return;
    const perPixel = DRAG_DEGREES / Math.max(1, event.currentTarget.clientWidth);
    // Grabbing the room: dragging right turns it right (the camera goes left), dragging down tips
    // its top towards you (the camera rises).
    go({
      azimuth: start.from.azimuth - (event.clientX - start.x) * perPixel,
      elevation: start.from.elevation + (event.clientY - start.y) * perPixel,
    });
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const to = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'side' } as const)[
      event.key as 'ArrowLeft'
    ];
    if (!to) return;
    event.preventDefault();
    turn(to);
  }
  const label = fluxOrbitLabel(orbit);
  const buttons = [
    { turn: 'left', label: '왼쪽으로 90° 돌리기', Icon: ArrowLeft },
    { turn: 'right', label: '오른쪽으로 90° 돌리기', Icon: ArrowRight },
    { turn: 'top', label: '위에서 보기', Icon: ArrowUp, text: '위에서' },
    { turn: 'side', label: '옆에서 보기', Icon: ArrowDown, text: '옆에서' },
  ] as const;
  return (
    <div className="mb-3 min-w-0" role="group" aria-label="AI 입력 시점">
      <div className="mb-1.5 text-xs font-semibold text-[color:var(--ink)]">AI 입력 시점</div>
      <div
        ref={host}
        tabIndex={locked ? -1 : 0}
        role="application"
        aria-roledescription="3D 시점 미리보기"
        aria-label={`AI 입력 미리보기 · ${label}. 방향키로 돌려요.`}
        data-testid="flux-view-preview"
        data-azimuth={orbit.azimuth}
        data-elevation={orbit.elevation}
        className={`relative w-full max-w-[600px] touch-none select-none overflow-hidden rounded-[var(--radius-sm,8px)] border border-[color:var(--line)] bg-white outline-offset-2 focus-visible:outline focus-visible:outline-2 [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full ${locked ? 'cursor-not-allowed opacity-70' : 'cursor-grab active:cursor-grabbing'}`}
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
        {buttons.map(({ turn: to, label: name, Icon, ...rest }) => (
          <button
            key={to}
            type="button"
            className="btn"
            aria-label={name}
            title={name}
            disabled={locked}
            onClick={() => turn(to)}
          >
            <Icon size={15} />
            {'text' in rest ? rest.text : null}
          </button>
        ))}
        <button
          type="button"
          className="btn"
          disabled={locked}
          onClick={() => turn('front')}
          aria-label="정면으로"
        >
          <RotateCcw size={15} />
          정면으로
        </button>
        <span className="text-xs font-semibold text-[color:var(--ink)]" data-testid="flux-view-readout">
          {label}
        </span>
      </div>
      <div className="mt-1.5 text-xs leading-relaxed text-[color:var(--muted)]">
        {preview && !error
          ? '끌어서 돌리거나 버튼으로 90°씩 돌린 뒤 변환하세요. 이 화면 그대로 AI에 보내고, 방 둘레 흰 여백은 결과에서도 흰색으로 되돌려요.'
          : ''}
      </div>
    </div>
  );
}
