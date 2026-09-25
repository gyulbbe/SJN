import type { BackgroundRemovalProgress } from './background-removal/types';
import type { Product3dProgress } from './product3d/types';
import type { MogeProgress } from './reconstruction/moge-browser/protocol';
import { BACKGROUND_MODEL_FILES } from './background-removal/model';
import { PRODUCT3D_FILES } from './product3d/model';
import { MOGE_ARTIFACT } from './reconstruction/moge-browser/artifact';

/**
 * Overall "AI model loading" percentage for browser models. Every model reports its own stage
 * events; this module turns them into one monotonic 0–100 value with step weights. Bytes give real
 * ratios; steps without a signal fill when they end (or creep slowly while they run, flagged as an
 * estimate). Pure and clock-injected so it can be unit tested.
 */
export type ModelLoadPhase = 'checking' | 'runtime' | 'download' | 'verify' | 'initialize' | 'ready';
export type ModelLoadEvent = {
  phase: ModelLoadPhase;
  /** Bytes read so far for download/cache reads. */
  loaded?: number;
  total?: number;
  source?: 'network' | 'cache';
  message?: string;
  /** Multi-part models (360° product): which file this event belongs to. */
  part?: string;
  /** Backend fallback restart: keep the current percentage and continue in the remaining span. */
  retry?: boolean;
  /** The model works but could not be kept in the browser for next time. */
  cacheNotice?: string;
};
export type ModelLoadStep = { key: string; weight: number; bytes?: number };
export type ModelLoadSpec = { steps: readonly ModelLoadStep[] };
export type ModelLoadSnapshot = {
  /** 0–100, or null when there is no size to compare against (bytes only). */
  percent: number | null;
  phase: ModelLoadPhase;
  message: string;
  loadedBytes?: number;
  totalBytes?: number;
  source?: 'network' | 'cache';
  /** The current step has no progress signal; the value moves by elapsed time. */
  estimated: boolean;
  retrying: boolean;
  cacheNotice?: string;
  done: boolean;
};

const stepKey = (phase: ModelLoadPhase, part?: string) => (part ? `${phase}:${part}` : phase);
/** Share of a step a silent phase may reach by time alone, and how fast (ms) it approaches it. */
const CREEP_LIMIT = 0.9;
const CREEP_TIME = 4000;
const THROTTLE_MS = 100;

export function createModelLoadTracker(spec: ModelLoadSpec, now: () => number = () => performance.now()) {
  const steps = spec.steps;
  const totalWeight = steps.reduce((sum, step) => sum + step.weight, 0) || 1;
  let index = -1;
  let fraction = 0;
  let stepStarted = now();
  let silent = true;
  let best = 0;
  let base = 0;
  let retrying = false;
  let done = false;
  let unknownSize = false;
  let state: Omit<ModelLoadSnapshot, 'percent' | 'estimated' | 'retrying' | 'done'> = {
    phase: 'checking',
    message: '',
  };
  let last: { at: number; percent: number | null; phase: ModelLoadPhase; message: string } | undefined;

  const raw = () => {
    if (index < 0) return 0;
    let value = 0;
    for (let i = 0; i < index; i++) value += steps[i].weight;
    const creep = silent ? CREEP_LIMIT * (1 - Math.exp(-(now() - stepStarted) / CREEP_TIME)) : 0;
    value += steps[index].weight * Math.min(1, silent ? creep : fraction);
    return (value / totalWeight) * 100;
  };
  const percent = () => {
    if (done) return 100;
    if (unknownSize) return null;
    const scaled = base + (raw() * (100 - base)) / 100;
    best = Math.min(99, Math.max(best, scaled));
    return best;
  };
  const snapshot = (): ModelLoadSnapshot => ({
    ...state,
    percent: percent(),
    estimated: !done && index >= 0 && silent,
    retrying,
    done,
  });
  const emit = (force: boolean) => {
    const next = snapshot();
    const at = now();
    if (
      !force &&
      last &&
      at - last.at < THROTTLE_MS &&
      Math.abs((next.percent ?? 0) - (last.percent ?? 0)) < 1 &&
      next.phase === last.phase &&
      next.message === last.message
    )
      return undefined;
    last = { at, percent: next.percent, phase: next.phase, message: next.message };
    return next;
  };

  return {
    /** Returns a new snapshot, or undefined when the change is too small to redraw. */
    update(event: ModelLoadEvent): ModelLoadSnapshot | undefined {
      if (done) return undefined;
      let force = event.phase !== state.phase;
      if (event.retry && !retrying) {
        // A fallback restarts earlier steps; continue from here instead of jumping back.
        base = percent() ?? best;
        index = -1;
        retrying = true;
        force = true;
      }
      if (event.phase === 'ready') {
        done = true;
        state = { ...state, phase: 'ready', message: event.message ?? state.message };
        return emit(true);
      }
      const key = stepKey(event.phase, event.part);
      const position = steps.findIndex((step) => step.key === key);
      if (position >= 0 && position !== index) {
        if (position > index || retrying) {
          index = position;
          stepStarted = now();
          fraction = 0;
          force = true;
        }
      }
      if (position === index && position >= 0) {
        const step = steps[position];
        const total = event.total ?? step.bytes;
        if (event.loaded !== undefined && total) {
          silent = false;
          fraction = Math.min(1, Math.max(0, event.loaded / total));
        } else silent = event.loaded === undefined;
        unknownSize = event.loaded !== undefined && !total;
      }
      state = {
        phase: event.phase,
        message: event.message ?? state.message,
        loadedBytes: event.loaded ?? (event.phase === state.phase ? state.loadedBytes : undefined),
        totalBytes: event.total ?? (event.loaded !== undefined ? steps[index]?.bytes : undefined),
        source: event.source ?? state.source,
        cacheNotice: event.cacheNotice ?? state.cacheNotice,
      };
      return emit(force);
    },
    /** Re-evaluates time-based estimates; call on a timer while a silent step runs. */
    tick(): ModelLoadSnapshot | undefined {
      return done ? undefined : emit(false);
    },
    complete(message?: string): ModelLoadSnapshot {
      done = true;
      if (message) state = { ...state, message };
      state = { ...state, phase: 'ready' };
      return emit(true)!;
    },
    snapshot,
  };
}
export type ModelLoadTracker = ReturnType<typeof createModelLoadTracker>;

// Step weights come from measured stage times (docs/ai-background-removal.md,
// docs/product3d-validation.md, docs/reconstruction-cloud-browser-results-20260916.md): first
// downloads dominate (27–42 s for 98 MB, ~31 s first MoGe run) while runtime import and session
// creation take 2–5 s together.
export const BACKGROUND_REMOVAL_LOAD: ModelLoadSpec = {
  steps: [
    { key: 'checking', weight: 1 },
    { key: 'runtime', weight: 4 },
    { key: 'download', weight: 85, bytes: BACKGROUND_MODEL_FILES.fp16.bytes },
    { key: 'initialize', weight: 10 },
  ],
};
const product3dBytes = Object.values(PRODUCT3D_FILES).reduce((sum, file) => sum + file.bytes, 0);
export const PRODUCT3D_LOAD: ModelLoadSpec = {
  steps: [
    { key: 'checking', weight: 1 },
    { key: 'runtime', weight: 3 },
    ...(Object.keys(PRODUCT3D_FILES) as (keyof typeof PRODUCT3D_FILES)[]).flatMap((part) => {
      const share = PRODUCT3D_FILES[part].bytes / product3dBytes;
      return [
        { key: `download:${part}`, weight: 90 * share, bytes: PRODUCT3D_FILES[part].bytes },
        { key: `initialize:${part}`, weight: 6 * share },
      ];
    }),
  ],
};
export const MOGE_LOAD: ModelLoadSpec = {
  steps: [
    { key: 'checking', weight: 1 },
    { key: 'download', weight: 82, bytes: MOGE_ARTIFACT.bytes },
    { key: 'verify', weight: 4 },
    { key: 'runtime', weight: 4 },
    { key: 'initialize', weight: 9 },
  ],
};
/** Bundled DeepLab ADE20K graph (model.json + one shard) under /models/deeplab-ade20k. */
export const DEEPLAB_MODEL_BYTES = 143_776 + 2_294_595;
export const DEEPLAB_LOAD: ModelLoadSpec = {
  steps: [
    { key: 'runtime', weight: 40 },
    { key: 'download', weight: 60, bytes: DEEPLAB_MODEL_BYTES },
  ],
};

export function backgroundRemovalLoadEvent(progress: BackgroundRemovalProgress): ModelLoadEvent {
  const base = { message: progress.message, retry: progress.retry, cacheNotice: progress.cacheNotice };
  switch (progress.stage) {
    case 'checking':
      return { ...base, phase: 'checking' };
    case 'loading-runtime':
      return { ...base, phase: 'runtime' };
    case 'download':
      return {
        ...base,
        phase: 'download',
        loaded: progress.loadedBytes,
        total: progress.totalBytes,
        source: progress.source ?? 'network',
      };
    case 'initializing':
      return { ...base, phase: 'initialize' };
    default:
      return { ...base, phase: 'ready' };
  }
}

/** Only geometry/coloring end the loading: encoder and backbone load in between inference runs. */
export function product3dLoadEvent(progress: Product3dProgress): ModelLoadEvent | undefined {
  const base = { message: progress.message, retry: progress.retry, cacheNotice: progress.cacheNotice };
  switch (progress.stage) {
    case 'checking':
      return { ...base, phase: 'checking' };
    case 'loading-runtime':
      return { ...base, phase: 'runtime' };
    case 'download':
      return {
        ...base,
        phase: 'download',
        part: progress.part,
        loaded: progress.loadedBytes,
        total: progress.totalBytes,
        source: progress.source ?? 'network',
      };
    case 'initializing':
      return progress.part
        ? { ...base, phase: 'initialize', part: progress.part }
        : { ...base, phase: 'checking' };
    case 'geometry':
    case 'coloring':
      return { ...base, phase: 'ready' };
    default:
      return undefined;
  }
}

export function mogeLoadEvent(progress: MogeProgress): ModelLoadEvent {
  const base = { message: progress.message };
  switch (progress.stage) {
    case 'checking':
    case 'cache':
      return { ...base, phase: 'checking' };
    case 'downloading':
      return {
        ...base,
        phase: 'download',
        loaded: progress.loaded,
        total: progress.total,
        source: 'network',
      };
    case 'verifying':
      return { ...base, phase: 'verify', source: progress.cacheSource === 'network' ? 'network' : 'cache' };
    case 'loading-runtime':
      return { ...base, phase: 'runtime' };
    case 'initializing':
      return { ...base, phase: 'initialize' };
    default:
      return { ...base, phase: 'ready' };
  }
}

export const formatMegabytes = (bytes: number) => (bytes / 1_048_576).toFixed(1);
export const formatPercent = (percent: number) => `${Math.floor(percent)}%`;

/** "AI 모델 준비 1/2 · 45%" for flows that prepare several models in turn. */
export function modelProgressLabel(
  sequence: { index: number; count: number } | undefined,
  snapshot: ModelLoadSnapshot,
) {
  const prefix =
    sequence && sequence.count > 1 ? `AI 모델 준비 ${sequence.index}/${sequence.count}` : 'AI 모델 준비';
  return snapshot.percent === null ? prefix : `${prefix} · ${formatPercent(snapshot.percent)}`;
}

/** Screen-reader value, e.g. "MoGe 모델 45%, 140.0MB 중 63.2MB". */
export function modelProgressValueText(title: string, snapshot: ModelLoadSnapshot) {
  const bytes =
    snapshot.loadedBytes !== undefined
      ? snapshot.totalBytes
        ? `, ${formatMegabytes(snapshot.totalBytes)}MB 중 ${formatMegabytes(snapshot.loadedBytes)}MB`
        : `, ${formatMegabytes(snapshot.loadedBytes)}MB 받음`
      : '';
  return `${title} ${snapshot.percent === null ? '진행 중' : formatPercent(snapshot.percent)}${bytes}`;
}
