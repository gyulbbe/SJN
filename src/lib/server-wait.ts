/**
 * Waiting on a server AI call that reports no progress (FLUX photo conversion, Gemma analysis
 * steps). Shows elapsed time and, only when there is a basis for it, the usual time: this browser's
 * recent successful waits, else a measured value. No percentage is made up.
 */
export type ServerWaitSpec = {
  /** Storage key of this wait's history, e.g. `flux` or `gemma:identity`. */
  kind: string;
  /** Used until this browser has its own history; undefined shows elapsed time only. */
  fallbackMs?: number;
  /** When the caller stops waiting (the server or client deadline). */
  limitMs?: number;
};

/** 2026-09-25 real klein 4B calls with the current prompt took 8.8 s and 9.0 s (docs/flux-export.md). */
export const FLUX_WAIT: ServerWaitSpec = { kind: 'flux', fallbackMs: 9_000, limitMs: 180_000 };
/** Checking a FLUX result with Gemma: 12 real checks on 2026-09-27 took 1.0–3.4 s, median 1.4 s. */
export const FLUX_CHECK_WAIT: ServerWaitSpec = {
  kind: 'gemma:fluxCheck',
  fallbackMs: 1_400,
  limitMs: 120_000,
};
/**
 * One Gemma analysis step. There is no measured per-step time (the recorded 20–44 s are whole
 * analyses), so the usual time appears once this browser has finished that step before.
 */
export const gemmaWait = (stage: string): ServerWaitSpec => ({
  kind: 'gemma:' + stage,
  limitMs: 120_000,
});

const KEY = 'sjn:server-wait:v1:';
export const WAIT_HISTORY = 5;
/** Share of the limit after which the screen says the wait will stop. */
export const NEAR_LIMIT = 0.85;

export type WaitStorage = Pick<Storage, 'getItem' | 'setItem'>;
function defaultStorage(): WaitStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Recent successful waits in ms, oldest first; empty when storage is unavailable or damaged. */
export function readWaitHistory(kind: string, storage = defaultStorage()): number[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY + kind) ?? '[]');
    return Array.isArray(parsed)
      ? parsed
          .filter((value): value is number => typeof value === 'number' && value > 0 && value < 3_600_000)
          .slice(-WAIT_HISTORY)
      : [];
  } catch {
    return [];
  }
}

export function recordWait(kind: string, ms: number, storage = defaultStorage()) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    storage?.setItem(
      KEY + kind,
      JSON.stringify([...readWaitHistory(kind, storage), Math.round(ms)].slice(-WAIT_HISTORY)),
    );
  } catch {
    // Private windows and full storage: the wait still shows, only without this browser's history.
  }
}

export function median(values: readonly number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export type WaitExpectation = { ms: number; source: 'history' | 'measured' };
export function expectedWait(spec: ServerWaitSpec, history: readonly number[]): WaitExpectation | undefined {
  const recent = median(history);
  if (recent !== undefined) return { ms: recent, source: 'history' };
  return spec.fallbackMs === undefined ? undefined : { ms: spec.fallbackMs, source: 'measured' };
}

export type WaitState = 'waiting' | 'slow' | 'near-limit';
const seconds = (ms: number) => Math.floor(ms / 1000);
const usual = (ms: number) => Math.max(1, Math.round(ms / 1000));

export function waitState(elapsedMs: number, expectedMs: number | undefined, limitMs?: number): WaitState {
  if (limitMs !== undefined && elapsedMs >= limitMs * NEAR_LIMIT) return 'near-limit';
  if (expectedMs !== undefined && seconds(elapsedMs) > usual(expectedMs)) return 'slow';
  return 'waiting';
}

/** "12초", "1분 5초", "3분". */
export function formatWaitSeconds(total: number) {
  const whole = Math.max(0, Math.floor(total));
  if (whole < 60) return `${whole}초`;
  const rest = whole % 60;
  return rest ? `${Math.floor(whole / 60)}분 ${rest}초` : `${Math.floor(whole / 60)}분`;
}

export type ServerWaitView = {
  state: WaitState;
  /** Large figure in place of a percentage. */
  figure: string;
  /** "경과 12초 · 보통 약 9초". */
  detail: string;
  message: string;
  valueText: string;
  /** Changes every 10 s and on a state change, so screen readers are not told every second. */
  phase: string;
};

export function describeWait(input: {
  title: string;
  message: string;
  elapsedMs: number;
  expected?: WaitExpectation;
  limitMs?: number;
}): ServerWaitView {
  const { title, elapsedMs, expected, limitMs } = input;
  const state = waitState(elapsedMs, expected?.ms, limitMs);
  const elapsed = formatWaitSeconds(seconds(elapsedMs));
  const detail = expected
    ? `경과 ${elapsed} · 보통 약 ${formatWaitSeconds(usual(expected.ms))}`
    : `경과 ${elapsed}`;
  const message =
    state === 'near-limit'
      ? `오래 걸리고 있어요. 응답은 최대 ${formatWaitSeconds(seconds(limitMs!))}까지 기다려요.`
      : state === 'slow'
        ? '평소보다 오래 걸리고 있어요.'
        : input.message;
  return {
    state,
    figure: elapsed,
    detail,
    message,
    valueText: `${title}, ${detail}. ${message}`,
    phase: `${state}:${Math.floor(seconds(elapsedMs) / 10)}`,
  };
}
