'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatPercent } from '@/lib/ai-progress';

/**
 * Title, large percent, bar and one detail line for a long step (AI model loading, high-quality
 * image export). Screen readers hear 10% steps and `phase` changes, not every redraw.
 */
export function ProgressMeter({
  title,
  percent,
  valueText,
  label,
  eyebrow,
  message,
  detail,
  notice,
  phase = '',
  compact = false,
  action,
  testId = 'progress-meter',
  percentTestId = 'progress-meter-percent',
}: {
  title: string;
  /** null while the amount is unknown: the bar pulses. */
  percent: number | null;
  /** Spoken value, e.g. "배경 제거 AI 모델 45%, 120MB 중 54MB". */
  valueText: string;
  /** Accessible name of the progress bar; defaults to the title. */
  label?: string;
  /** Small accent line above the title, e.g. "AI 모델 준비 1/2". */
  eyebrow?: string;
  /** Stage text under the bar. */
  message?: string;
  /** Right-aligned figures under the bar, e.g. "54 / 120 MB". */
  detail?: string;
  /** Extra line under the stage text (full size only). */
  notice?: string;
  /** Announced again when it changes even inside the same 10% step. */
  phase?: string;
  compact?: boolean;
  /** e.g. a cancel button, placed after the detail line. */
  action?: ReactNode;
  testId?: string;
  percentTestId?: string;
}) {
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef<{ bucket: number; phase: string } | null>(null);
  useEffect(() => {
    const bucket = percent === null ? -1 : Math.floor(percent / 10);
    const previous = announced.current;
    if (previous && previous.bucket === bucket && previous.phase === phase) return;
    announced.current = { bucket, phase };
    setAnnouncement(valueText);
  }, [percent, phase, valueText]);
  return (
    <div
      className={`min-w-0 rounded-[var(--radius-sm,8px)] border border-[color:var(--line)] bg-[color:var(--paper)] ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}
      data-testid={testId}
    >
      <div className="flex min-w-0 items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <div className="text-xs font-semibold text-[color:var(--accent)]">{eyebrow}</div>}
          <div
            className={`truncate font-semibold text-[color:var(--ink)] ${compact ? 'text-sm' : 'text-base'}`}
          >
            {title}
          </div>
        </div>
        <div
          className={`shrink-0 font-bold tabular-nums text-[color:var(--ink)] ${compact ? 'text-lg' : 'text-3xl'}`}
          data-testid={percentTestId}
        >
          {percent === null ? '—' : formatPercent(percent)}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={label ?? title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.floor(percent)}
        aria-valuetext={valueText}
        className={`mt-2 overflow-hidden rounded-full bg-[color:var(--surface-soft,#eeefea)] ${compact ? 'h-1.5' : 'h-2.5'}`}
      >
        {percent === null ? (
          <div className="h-full w-1/3 rounded-full bg-[color:var(--accent)] motion-safe:animate-pulse" />
        ) : (
          <div
            className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-[color:var(--muted)]">
        <span className="min-w-0 break-keep">{message ?? ''}</span>
        {detail && <span className="shrink-0 tabular-nums">{detail}</span>}
      </div>
      {notice && !compact && <div className="mt-1 text-xs text-[color:var(--muted)]">{notice}</div>}
      {action && <div className="mt-2 flex justify-end">{action}</div>}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
