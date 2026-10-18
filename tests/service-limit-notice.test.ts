import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiLimitHint,
  clearServiceLimit,
  formatResetAt,
  limitFromBody,
  noteServiceAnswer,
  readServiceLimits,
  reportServiceLimit,
  serviceLimitMessage,
} from '../src/lib/service-limit-notice';

/** A browser's storage, or one that refuses (a private window). */
function storage(refuse = false) {
  const values = new Map<string, string>();
  const fail = () => {
    throw new Error('SecurityError');
  };
  return {
    values,
    getItem: (key: string) => (refuse ? fail() : (values.get(key) ?? null)),
    setItem: (key: string, value: string) => (refuse ? fail() : void values.set(key, value)),
    removeItem: (key: string) => (refuse ? fail() : void values.delete(key)),
  };
}
afterEach(() => {
  clearServiceLimit('db');
  clearServiceLimit('ai');
  vi.unstubAllGlobals();
});

describe('when it comes back, in Korea’s time on the browser’s clock', () => {
  const reset = '2026-10-19T00:00:00.000Z'; // Monday 19 October, 09:00 in Korea
  it('says today or tomorrow in front of the date and weekday', () => {
    // Sunday 18 October 12:00 in Korea: tomorrow.
    expect(formatResetAt(reset, new Date('2026-10-18T03:00:00Z'))).toBe('내일 10월 19일(월) 오전 9시');
    // Monday 19 October 08:59 in Korea (23:59 UTC the day before): today.
    expect(formatResetAt(reset, new Date('2026-10-18T23:59:00Z'))).toBe('오늘 10월 19일(월) 오전 9시');
    // Further away: the date alone.
    expect(formatResetAt(reset, new Date('2026-10-17T03:00:00Z'))).toBe('10월 19일(월) 오전 9시');
  });
  it('crosses the end of a month and of a year', () => {
    expect(formatResetAt('2026-11-01T00:00:00.000Z', new Date('2026-10-31T10:00:00Z'))).toBe(
      '내일 11월 1일(일) 오전 9시',
    );
    expect(formatResetAt('2027-01-01T00:00:00.000Z', new Date('2026-12-31T05:00:00Z'))).toBe(
      '내일 1월 1일(금) 오전 9시',
    );
    // 00:30 UTC on 31 December is already 09:30 on the 31st in Korea: the next reset is "tomorrow".
    expect(formatResetAt('2027-01-01T00:00:00.000Z', new Date('2026-12-31T00:30:00Z'))).toBe(
      '내일 1월 1일(금) 오전 9시',
    );
  });
});

describe('the notice’s words', () => {
  const now = new Date('2026-10-18T03:00:00Z');
  const resetAt = '2026-10-19T00:00:00.000Z';
  it('say what stopped, when it comes back and what still works', () => {
    expect(serviceLimitMessage({ service: 'db-read', resetAt }, now)).toBe(
      '오늘 서버 이용 한도를 모두 써서 로그인·저장·불러오기가 잠시 멈췄어요. 내일 10월 19일(월) 오전 9시 이후 다시 접속해 주세요. 열려 있는 작업은 이 기기에 보관돼요.',
    );
    expect(serviceLimitMessage({ service: 'ai', resetAt }, now)).toBe(
      '오늘 AI 이용 한도를 모두 써서 AI 기능(실사 변환·방향 사진·설비 분석)을 쓸 수 없어요. 내일 10월 19일(월) 오전 9시 이후 다시 시도해 주세요. 편집과 저장은 계속할 수 있어요.',
    );
    expect(serviceLimitMessage({ service: 'db-write', resetAt }, now)).toContain('저장이 잠시 멈췄어요');
    // Storage does not come back by itself: no time.
    expect(serviceLimitMessage({ service: 'db-storage' }, now)).toBe(
      '서버 저장 공간이 가득 찼어요. 관리자에게 알려 주세요.',
    );
    expect(aiLimitHint({ service: 'ai', resetAt }, now)).toBe('AI 한도 · 내일 10월 19일(월) 오전 9시 이후');
  });
});

describe('reading a limit from an answer', () => {
  it('takes only a well-formed limit', () => {
    const resetAt = '2026-10-19T00:00:00.000Z';
    expect(limitFromBody({ code: 'SERVICE_LIMIT', limit: { service: 'db-read', resetAt } })).toEqual({
      service: 'db-read',
      resetAt,
    });
    expect(limitFromBody({ code: 'quota_exhausted', limit: { service: 'ai', resetAt } })).toEqual({
      service: 'ai',
      resetAt,
    });
    expect(limitFromBody({ limit: { service: 'db-storage' } })).toEqual({ service: 'db-storage' });
    for (const body of [
      null,
      { code: 'quota_exhausted' },
      { limit: { service: 'db-read' } },
      { limit: { service: 'disk', resetAt } },
      { limit: { service: 'ai', resetAt: 'tomorrow' } },
    ])
      expect(limitFromBody(body)).toBeNull();
  });
});

describe('keeping the notice', () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  it('keeps one a kind in the browser until it comes back, and a normal answer takes it away', () => {
    const local = storage();
    vi.stubGlobal('localStorage', local);
    reportServiceLimit({ service: 'db-read', resetAt });
    reportServiceLimit({ service: 'ai', resetAt });
    reportServiceLimit({ service: 'db-write', resetAt }); // replaces the database's
    expect(readServiceLimits()).toEqual([
      { service: 'ai', resetAt },
      { service: 'db-write', resetAt },
    ]);
    expect(JSON.parse(local.values.get('sjn-service-limit')!)).toHaveLength(2);
    // Past its time it is not shown, with no request.
    expect(readServiceLimits(Date.parse(resetAt) + 1)).toEqual([]);
    // A failed answer without a limit keeps it; a normal one clears that kind only.
    expect(noteServiceAnswer(false, { error: 'other' }, 'db')).toBeNull();
    expect(readServiceLimits()).toHaveLength(2);
    noteServiceAnswer(true, {}, 'db');
    expect(readServiceLimits()).toEqual([{ service: 'ai', resetAt }]);
    expect(
      noteServiceAnswer(false, { code: 'quota_exhausted', limit: { service: 'ai', resetAt } }, 'ai'),
    ).toEqual({
      service: 'ai',
      resetAt,
    });
    noteServiceAnswer(true, null, 'ai');
    expect(local.values.has('sjn-service-limit')).toBe(false);
  });
  it('still works for the page when the browser refuses its storage', () => {
    vi.stubGlobal('localStorage', storage(true));
    reportServiceLimit({ service: 'db-read', resetAt });
    expect(readServiceLimits()).toEqual([{ service: 'db-read', resetAt }]);
    clearServiceLimit('db');
    expect(readServiceLimits()).toEqual([]);
  });
  it('ignores what it cannot read', () => {
    const local = storage();
    local.values.set('sjn-service-limit', '{not json');
    vi.stubGlobal('localStorage', local);
    expect(readServiceLimits()).toEqual([]);
    local.values.set(
      'sjn-service-limit',
      JSON.stringify([
        { service: 'ai', resetAt: 'x' },
        { service: 'ai', resetAt },
      ]),
    );
    expect(readServiceLimits()).toEqual([{ service: 'ai', resetAt }]);
  });
});
