import { describe, expect, it } from 'vitest';
import {
  describeWait,
  expectedWait,
  formatWaitSeconds,
  FLUX_WAIT,
  gemmaWait,
  median,
  readWaitHistory,
  recordWait,
  waitState,
  WAIT_HISTORY,
  type WaitStorage,
} from '../src/lib/server-wait';

function memory(): WaitStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe('server wait history', () => {
  it('keeps the last five successful waits per kind', () => {
    const storage = memory();
    for (const ms of [8000, 9000, 10000, 11000, 12000, 30000]) recordWait('flux', ms, storage);
    recordWait('gemma:identity', 4000, storage);
    expect(readWaitHistory('flux', storage)).toEqual([9000, 10000, 11000, 12000, 30000]);
    expect(readWaitHistory('flux', storage)).toHaveLength(WAIT_HISTORY);
    expect(readWaitHistory('gemma:identity', storage)).toEqual([4000]);
  });

  it('ignores storage that throws, damaged values and nonsense durations', () => {
    const throwing: WaitStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readWaitHistory('flux', throwing)).toEqual([]);
    expect(() => recordWait('flux', 9000, throwing)).not.toThrow();
    const storage = memory();
    storage.values.set('sjn:server-wait:v1:flux', '{broken');
    expect(readWaitHistory('flux', storage)).toEqual([]);
    storage.values.set('sjn:server-wait:v1:flux', JSON.stringify([9000, 'x', -1, 0, null, 7_200_000, 7000]));
    expect(readWaitHistory('flux', storage)).toEqual([9000, 7000]);
    recordWait('flux', Number.NaN, storage);
    recordWait('flux', 0, storage);
    expect(readWaitHistory('flux', storage)).toEqual([9000, 7000]);
    expect(readWaitHistory('flux', undefined)).toEqual([]);
  });
});

describe('expected wait', () => {
  it('uses the median of this browser, else the measured value, else nothing', () => {
    expect(median([])).toBeUndefined();
    expect(median([30000, 8000, 9000])).toBe(9000);
    expect(median([8000, 12000])).toBe(10000);
    expect(expectedWait(FLUX_WAIT, [])).toEqual({ ms: 9000, source: 'measured' });
    expect(expectedWait(FLUX_WAIT, [4000, 5000, 60000])).toEqual({ ms: 5000, source: 'history' });
    // No measured per-step time exists for Gemma: elapsed only until this browser has one.
    expect(expectedWait(gemmaWait('identity'), [])).toBeUndefined();
    expect(expectedWait(gemmaWait('identity'), [6000])).toEqual({ ms: 6000, source: 'history' });
    expect(gemmaWait('layout')).toEqual({ kind: 'gemma:layout', limitMs: 120_000 });
  });
});

describe('wait state and wording', () => {
  it('turns slow after the usual time and near the limit at 85%', () => {
    expect(waitState(9_900, 9_000, 180_000)).toBe('waiting');
    expect(waitState(10_000, 9_000, 180_000)).toBe('slow');
    expect(waitState(152_999, 9_000, 180_000)).toBe('slow');
    expect(waitState(153_000, 9_000, 180_000)).toBe('near-limit');
    expect(waitState(500_000, undefined)).toBe('waiting');
    expect(waitState(102_000, undefined, 120_000)).toBe('near-limit');
  });

  it('formats seconds and minutes', () => {
    expect(formatWaitSeconds(0)).toBe('0초');
    expect(formatWaitSeconds(59.9)).toBe('59초');
    expect(formatWaitSeconds(65)).toBe('1분 5초');
    expect(formatWaitSeconds(180)).toBe('3분');
  });

  it('describes elapsed, usual time and state, and announces only per 10 s or state change', () => {
    const base = { title: 'AI 현장 사진 변환', message: '서버에서 변환하는 중이에요.' };
    const expected = { ms: 9000, source: 'measured' as const };
    const early = describeWait({ ...base, elapsedMs: 3_400, expected, limitMs: 180_000 });
    expect(early).toMatchObject({
      state: 'waiting',
      figure: '3초',
      detail: '경과 3초 · 보통 약 9초',
      message: base.message,
      phase: 'waiting:0',
    });
    expect(early.valueText).toBe('AI 현장 사진 변환, 경과 3초 · 보통 약 9초. 서버에서 변환하는 중이에요.');
    expect(describeWait({ ...base, elapsedMs: 8_000, expected, limitMs: 180_000 }).phase).toBe('waiting:0');
    const slow = describeWait({ ...base, elapsedMs: 12_000, expected, limitMs: 180_000 });
    expect(slow).toMatchObject({ state: 'slow', message: '평소보다 오래 걸리고 있어요.', phase: 'slow:1' });
    const late = describeWait({ ...base, elapsedMs: 160_000, expected, limitMs: 180_000 });
    expect(late.message).toBe('오래 걸리고 있어요. 응답은 최대 3분까지 기다려요.');
    expect(late.detail).toBe('경과 2분 40초 · 보통 약 9초');
    const unknown = describeWait({ ...base, elapsedMs: 21_000, limitMs: 120_000 });
    expect(unknown).toMatchObject({ state: 'waiting', detail: '경과 21초', phase: 'waiting:2' });
  });
});
