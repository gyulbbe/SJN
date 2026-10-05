'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, RotateCcw } from 'lucide-react';
import {
  fluxOrbitLabel,
  fluxOrbitView,
  snapFluxOrbit,
  turnFluxOrbit,
  type FluxTurn,
} from '@/lib/ai-export/view';
import type { RoomOrbit, RoomViewState } from '@/lib/room-viewer/view-state';

/** A live 3D view of the After, drawn by the same renderer class and camera as the AI input. */
export type AiPreview = {
  canvas: HTMLCanvasElement;
  render: (width: number, height: number, view: RoomViewState) => void;
  /** Which product photo stood in for a missing one in the last picture, in plain words. */
  notes?: () => string[];
  dispose: () => void;
};

/**
 * Turns the AI input's camera to one of four sides, 90° at a time: the buttons or the ← → keys,
 * "정면으로" back to the start. There is no free drag and no view from above or the side: every
 * product is a flat photo facing the camera (see FOUR_DIRECTION_VIEWS). Locked while a conversion
 * runs. The picture has the input's aspect and white backdrop, and says which product photo stood in
 * for a missing direction.
 */
export default function AiViewPicker({
  aspect,
  prepare,
  orbit,
  onOrbit,
  locked,
}: {
  /** The AI input's width ÷ height. */
  aspect: number;
  /** A prepared renderer of this After. */
  prepare: () => Promise<AiPreview>;
  orbit: RoomOrbit;
  onOrbit: (orbit: RoomOrbit) => void;
  locked: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<AiPreview>();
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const side = snapFluxOrbit(orbit);

  useEffect(() => {
    const job: { alive: boolean; made?: AiPreview } = { alive: true };
    setPreview(undefined);
    setError('');
    prepare()
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
  }, [prepare]);
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
        preview.render(w, Math.max(1, Math.round(w / aspect)), fluxOrbitView(side));
        setNotes(preview.notes?.() ?? []);
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [preview, width, aspect, side.azimuth, side.elevation]); // eslint-disable-line react-hooks/exhaustive-deps

  const turn = (to: FluxTurn) => {
    if (locked) return;
    const next = turnFluxOrbit(side, to);
    if (next.azimuth !== orbit.azimuth || next.elevation !== orbit.elevation) onOrbit(next);
  };
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const to = ({ ArrowLeft: 'left', ArrowRight: 'right' } as const)[event.key as 'ArrowLeft'];
    if (!to) return;
    event.preventDefault();
    turn(to);
  }
  const label = fluxOrbitLabel(side);
  const buttons = [
    { turn: 'left', label: '왼쪽으로 90° 돌리기', Icon: ArrowLeft },
    { turn: 'right', label: '오른쪽으로 90° 돌리기', Icon: ArrowRight },
  ] as const;
  return (
    <div className="mb-3 min-w-0" role="group" aria-label="AI 입력 시점">
      <div className="mb-1.5 text-xs font-semibold text-[color:var(--ink)]">AI 입력 시점</div>
      <div
        ref={host}
        tabIndex={locked ? -1 : 0}
        role="application"
        aria-roledescription="4방향 시점 미리보기"
        aria-label={`AI 입력 미리보기 · ${label}. 방향키 ← →로 돌려요.`}
        data-testid="flux-view-preview"
        data-azimuth={side.azimuth}
        data-elevation={side.elevation}
        className={`relative w-full max-w-[600px] select-none overflow-hidden rounded-[var(--radius-sm,8px)] border border-[color:var(--line)] bg-white outline-offset-2 focus-visible:outline focus-visible:outline-2 [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full ${locked ? 'cursor-not-allowed opacity-70' : ''}`}
        style={{ aspectRatio: String(aspect) }}
        onKeyDown={onKeyDown}
      >
        {!preview && (
          <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-xs text-[color:var(--muted)]">
            {error || '3D 미리보기를 준비하는 중이에요.'}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {buttons.map(({ turn: to, label: name, Icon }) => (
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
          ? '정면·오른쪽·뒤·왼쪽 네 방향 중에서 버튼이나 ← → 키로 90°씩 돌려 고르세요. 제품은 그 방향에서 보이는 사진 한 장으로 보이고, 이 화면 그대로 AI에 보내요. 방 둘레 흰 여백은 결과에서도 흰색으로 되돌려요.'
          : ''}
      </div>
      {preview && !error && notes.length > 0 && (
        <ul
          className="mt-1.5 list-disc pl-4 text-xs leading-relaxed text-[color:var(--muted)]"
          data-testid="flux-view-notes"
        >
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
