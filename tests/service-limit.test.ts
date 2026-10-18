import { describe, expect, it, vi } from 'vitest';
import {
  detectServiceLimit,
  nextResetAt,
  serviceLimitResponse,
  watchServiceLimit,
} from '../src/lib/platform/service-limit';

// Cloudflare's own words (developers.cloudflare.com: d1/observability/debug-d1, and the 2026-09-01
// changelog "D1 free tier limit enforcement"). Their ends differ between documents.
const READ = "Your account has exceeded D1's free tier daily row read limit. Upgrade to Workers Paid.";
const WRITE = "Your account has exceeded D1's free tier daily row write limit.";
const now = new Date('2026-10-18T03:00:00Z');

describe('which daily limit an error is', () => {
  it('reads D1’s messages as they come: a prefix, another ending, any case, in a cause', () => {
    const at = '2026-10-19T00:00:00.000Z';
    expect(detectServiceLimit(new Error(READ), now)).toEqual({ service: 'db-read', resetAt: at });
    expect(detectServiceLimit(new Error('D1_ERROR: ' + READ), now)).toEqual({
      service: 'db-read',
      resetAt: at,
    });
    expect(detectServiceLimit(new Error(WRITE.toUpperCase()), now)).toEqual({
      service: 'db-write',
      resetAt: at,
    });
    expect(
      detectServiceLimit(new Error('D1_ERROR: free tier daily row write limit reached (see dashboard)'), now),
    ).toEqual({ service: 'db-write', resetAt: at });
    expect(detectServiceLimit(new Error('wrapped', { cause: new Error(READ) }), now)?.service).toBe(
      'db-read',
    );
    expect(
      detectServiceLimit(
        new Error('a', { cause: new Error('b', { cause: new Error('D1_ERROR: ' + WRITE) }) }),
        now,
      )?.service,
    ).toBe('db-write');
    // Storage does not free itself at midnight: no time to come back.
    expect(detectServiceLimit(new Error('D1_ERROR: Exceeded maximum DB size.'), now)).toEqual({
      service: 'db-storage',
    });
    expect(
      detectServiceLimit(new Error("Your account has exceeded D1's maximum account storage limit"), now),
    ).toEqual({ service: 'db-storage' });
  });

  it('takes an AI failure already classified as quota_exhausted', () => {
    expect(detectServiceLimit({ code: 'quota_exhausted', message: '…' }, now)).toEqual({
      service: 'ai',
      resetAt: '2026-10-19T00:00:00.000Z',
    });
  });

  it('leaves every other failure alone', () => {
    for (const error of [
      new Error('UNIQUE constraint failed: d1_projects.id'),
      new Error('D1_ERROR: no such table: user'),
      new Error('Network connection lost.'),
      { code: 'rate_limited' },
      'free tier daily row read limit',
      null,
      undefined,
    ])
      expect(detectServiceLimit(error, now)).toBeNull();
  });
});

describe('when the daily limits come back', () => {
  it('is the next 00:00 UTC, 09:00 in Korea', () => {
    expect(nextResetAt(new Date('2026-10-18T23:59:59Z'))).toBe('2026-10-19T00:00:00.000Z');
    // At midnight exactly the day has just begun: the next reset is a day away.
    expect(nextResetAt(new Date('2026-10-19T00:00:00Z'))).toBe('2026-10-20T00:00:00.000Z');
    // 08:59 and 09:00 in Korea are 23:59 and 00:00 UTC.
    expect(nextResetAt(new Date('2026-10-18T23:59:00Z'))).toBe('2026-10-19T00:00:00.000Z');
    expect(nextResetAt(new Date('2026-10-19T00:00:30Z'))).toBe('2026-10-20T00:00:00.000Z');
    expect(nextResetAt(new Date('2026-12-31T15:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('the answer to a spent limit', () => {
  it('is 503 SERVICE_LIMIT with the limit only', async () => {
    const response = serviceLimitResponse({ service: 'db-read', resetAt: '2026-10-19T00:00:00.000Z' });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'limit']);
    expect(body).toMatchObject({
      code: 'SERVICE_LIMIT',
      limit: { service: 'db-read', resetAt: '2026-10-19T00:00:00.000Z' },
    });
    expect(body.error).toContain('오전 9시');
  });
});

type Statement = {
  first: () => Promise<unknown>;
  all: () => Promise<unknown>;
  run?: () => Promise<unknown>;
  bind: (...values: unknown[]) => Statement;
};
describe('watching a database for a spent limit', () => {
  const statement = (fail: boolean) => {
    const own = {
      first: vi.fn(async () => {
        if (fail) throw new Error('D1_ERROR: ' + READ);
        return { ok: 1 };
      }),
      all: vi.fn(async () => ({ results: [] })),
      bind: vi.fn<(...values: unknown[]) => Statement>(),
    };
    own.bind.mockReturnValue(own);
    return own;
  };
  it('notes the limit and passes every query, result and error through unchanged', async () => {
    const good = statement(false),
      bad = statement(true);
    const batch = vi.fn(async (items: unknown[]) => items.map(() => ({ results: [] })));
    const db = { prepare: vi.fn((query: string): Statement => (query === 'bad' ? bad : good)), batch };
    const watched = watchServiceLimit(db);
    expect(await watched.db.prepare('good').bind(1).first()).toEqual({ ok: 1 });
    expect(watched.hit()).toBeUndefined();
    // The database gets its own statements in a batch.
    await watched.db.batch([watched.db.prepare('good'), watched.db.prepare('good').bind(2)]);
    expect(batch.mock.calls[0][0]).toEqual([good, good]);
    await expect(watched.db.prepare('bad').bind(1).first()).rejects.toThrow('free tier daily row read limit');
    expect(detectServiceLimit(watched.hit())?.service).toBe('db-read');
    // One query each: nothing is read twice.
    expect(db.prepare).toHaveBeenCalledTimes(4);
    expect(good.first).toHaveBeenCalledTimes(1);
    expect(bad.first).toHaveBeenCalledTimes(1);
  });
  it('does not note other failures', async () => {
    const db = {
      prepare: vi.fn<(query: string) => { run: () => Promise<unknown> }>().mockReturnValue({
        run: async () => {
          throw new Error('UNIQUE constraint failed');
        },
      }),
    };
    const watched = watchServiceLimit(db);
    await expect(watched.db.prepare('x').run()).rejects.toThrow('UNIQUE');
    expect(watched.hit()).toBeUndefined();
  });
});
