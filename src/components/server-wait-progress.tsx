'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressMeter } from '@/components/progress-meter';
import {
  describeWait,
  expectedWait,
  gemmaWait,
  readWaitHistory,
  recordWait,
  type ServerWaitSpec,
  type WaitExpectation,
} from '@/lib/server-wait';
import type { CloudWaitEvent } from '@/lib/reconstruction/cloud-quality';

type WaitStart = {
  /** Omitted for local preparation: elapsed time only, nothing recorded. */
  spec?: ServerWaitSpec;
  message: string;
  eyebrow?: string;
};
export type ServerWait = WaitStart & { started: number; expected?: WaitExpectation; elapsedMs: number };

/**
 * One wait at a time. `finish(true)` records the wait for this browser's usual time; failures,
 * cancellations and cached answers are not recorded.
 */
export function useServerWait() {
  const current = useRef<(WaitStart & { started: number; expected?: WaitExpectation }) | null>(null);
  const [active, setActive] = useState<typeof current.current>(null);
  const [seconds, setSeconds] = useState(0);
  const start = useCallback((options: WaitStart) => {
    const entry = {
      ...options,
      started: performance.now(),
      expected: options.spec ? expectedWait(options.spec, readWaitHistory(options.spec.kind)) : undefined,
    };
    current.current = entry;
    setActive(entry);
    setSeconds(0);
  }, []);
  const finish = useCallback((record: boolean) => {
    const entry = current.current;
    current.current = null;
    setActive(null);
    if (record && entry?.spec) recordWait(entry.spec.kind, performance.now() - entry.started);
  }, []);
  useEffect(() => {
    if (!active) return;
    // Checked four times a second so the shown second turns over on time; renders once a second.
    const timer = setInterval(() => setSeconds(Math.floor((performance.now() - active.started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [active]);
  const wait: ServerWait | null = active ? { ...active, elapsedMs: seconds * 1000 } : null;
  return { wait, start, finish };
}

/** Elapsed time and, when known, the usual time of a server AI call; a pulsing bar, no percentage. */
export function ServerWaitProgress({
  title,
  wait,
  compact = false,
}: {
  title: string;
  wait: ServerWait | null;
  compact?: boolean;
}) {
  if (!wait) return null;
  const view = describeWait({
    title,
    message: wait.message,
    elapsedMs: wait.elapsedMs,
    expected: wait.expected,
    limitMs: wait.spec?.limitMs,
  });
  return (
    <ProgressMeter
      title={title}
      percent={null}
      figure={view.figure}
      valueText={view.valueText}
      eyebrow={wait.eyebrow}
      message={view.message}
      detail={view.detail}
      phase={view.phase}
      compact={compact}
      testId="server-wait-progress"
      percentTestId="server-wait-elapsed"
    />
  );
}

/** Gemma steps of the precise photo analysis: which step this is and how long it is taking. */
export function useCloudAnalysisWait() {
  const { wait, start, finish } = useServerWait();
  const steps = useRef(0);
  const onCloudWait = useCallback(
    (event: CloudWaitEvent) => {
      if (event.phase === 'start') {
        steps.current += 1;
        // How many steps run depends on what the photo shows, so there is no "of N".
        start({ spec: gemmaWait(event.stage), message: '', eyebrow: `AI 확인 ${steps.current}번째` });
      } else finish(event.ok && !event.cached);
    },
    [start, finish],
  );
  const reset = useCallback(() => {
    steps.current = 0;
    finish(false);
  }, [finish]);
  const view = wait ? <ServerWaitProgress title="Cloudflare AI 분석" wait={wait} /> : null;
  return { onCloudWait, reset, view };
}
