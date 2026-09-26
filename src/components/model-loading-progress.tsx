'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressMeter } from '@/components/progress-meter';
import {
  createModelLoadTracker,
  DEEPLAB_LOAD,
  formatMegabytes,
  MOGE_LOAD,
  modelProgressValueText,
  type ModelLoadEvent,
  type ModelLoadSnapshot,
  type ModelLoadSpec,
  type ModelLoadTracker,
} from '@/lib/ai-progress';
import type { ReconstructionModelProgress } from '@/lib/reconstruction';

/** Keeps 100% on screen briefly before the caller's next stage replaces it. */
const DONE_VISIBLE_MS = 400;

/**
 * Tracks one model's loading. Pass events as they arrive; `visible` turns on at the first real
 * loading step (so a quick cache check alone never flashes a bar) and off shortly after 100%.
 */
export function useModelLoadingProgress(spec: ModelLoadSpec) {
  const tracker = useRef<ModelLoadTracker | null>(null);
  const [snapshot, setSnapshot] = useState<ModelLoadSnapshot>();
  const [visible, setVisible] = useState(false);
  const push = useCallback(
    (event: ModelLoadEvent | undefined) => {
      if (!event) return;
      tracker.current ??= createModelLoadTracker(spec);
      const next = tracker.current.update(event);
      if (next) setSnapshot(next);
      if (event.phase !== 'checking' && event.phase !== 'ready') setVisible(true);
    },
    [spec],
  );
  const reset = useCallback(() => {
    tracker.current = null;
    setSnapshot(undefined);
    setVisible(false);
  }, []);
  const done = snapshot?.done ?? false;
  const estimated = snapshot?.estimated ?? false;
  useEffect(() => {
    // Silent steps (runtime import, session creation) move by elapsed time.
    if (!visible || done || !estimated) return;
    const timer = setInterval(() => {
      const next = tracker.current?.tick();
      if (next) setSnapshot(next);
    }, 250);
    return () => clearInterval(timer);
  }, [visible, done, estimated]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setVisible(false), DONE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [done]);
  return { snapshot, visible: visible && !!snapshot, push, reset };
}

export function ModelLoadingProgress({
  title,
  snapshot,
  sequence,
  label,
  compact = false,
  storesModel = true,
  showMessage = true,
}: {
  /** e.g. "배경 제거 AI 모델" */
  title: string;
  snapshot: ModelLoadSnapshot;
  /** Several models prepared in turn: shows "AI 모델 준비 1/2". */
  sequence?: { index: number; count: number };
  /** Accessible name of the progress bar; defaults to the title. */
  label?: string;
  compact?: boolean;
  /** False where the downloaded model is not kept for next time. */
  storesModel?: boolean;
  /** Hide the stage line where the screen already shows the same stage text. */
  showMessage?: boolean;
}) {
  const bytes =
    snapshot.loadedBytes !== undefined
      ? snapshot.totalBytes
        ? `${formatMegabytes(snapshot.loadedBytes)} / ${formatMegabytes(snapshot.totalBytes)} MB`
        : `${formatMegabytes(snapshot.loadedBytes)} MB 받음`
      : '';
  const notice = snapshot.cacheNotice
    ? snapshot.cacheNotice
    : snapshot.retrying
      ? '다른 방식으로 다시 준비하는 중이에요.'
      : snapshot.source === 'cache'
        ? '저장된 모델을 불러오는 중이에요.'
        : snapshot.source === 'network' && storesModel && !snapshot.done
          ? '처음 한 번만 내려받아요. 다음부터는 저장된 모델을 써요.'
          : '';
  return (
    <ProgressMeter
      title={title}
      percent={snapshot.percent}
      valueText={modelProgressValueText(title, snapshot)}
      label={label}
      eyebrow={
        sequence && sequence.count > 1 ? `AI 모델 준비 ${sequence.index}/${sequence.count}` : undefined
      }
      message={showMessage ? snapshot.message : ''}
      detail={bytes}
      notice={notice}
      phase={snapshot.phase}
      compact={compact}
      testId="model-loading-progress"
      percentTestId="model-loading-percent"
    />
  );
}

const PHOTO_MODEL_TITLES = {
  deeplab: '벽·바닥 분석 AI 모델',
  moge: '깊이 분석 AI 모델(MoGe)',
} as const;

/**
 * Photo analysis prepares DeepLab, then MoGe (precise profile). Feed `onModelProgress` to
 * createReconstructionProject / runBrowserAnalysisTest and render `view` in place of the stage text
 * while a model is loading.
 */
export function usePhotoAnalysisModelProgress() {
  const deeplab = useModelLoadingProgress(DEEPLAB_LOAD);
  const moge = useModelLoadingProgress(MOGE_LOAD);
  const { push: pushDeeplab, reset: resetDeeplab } = deeplab;
  const { push: pushMoge, reset: resetMoge } = moge;
  const [step, setStep] = useState<Omit<ReconstructionModelProgress, 'event'>>();
  const onModelProgress = useCallback(
    (update: ReconstructionModelProgress) => {
      (update.model === 'moge' ? pushMoge : pushDeeplab)(update.event);
      setStep({ model: update.model, index: update.index, count: update.count });
    },
    [pushDeeplab, pushMoge],
  );
  const reset = useCallback(() => {
    resetDeeplab();
    resetMoge();
    setStep(undefined);
  }, [resetDeeplab, resetMoge]);
  const active = step ? (step.model === 'moge' ? moge : deeplab) : undefined;
  const view =
    step && active?.visible && active.snapshot ? (
      <ModelLoadingProgress
        title={PHOTO_MODEL_TITLES[step.model]}
        snapshot={active.snapshot}
        sequence={{ index: step.index, count: step.count }}
        showMessage={false}
      />
    ) : null;
  return { onModelProgress, reset, view };
}
