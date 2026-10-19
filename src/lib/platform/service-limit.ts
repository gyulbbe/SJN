/**
 * Cloudflare's free daily limits (Workers Free): D1 reads and writes, D1 storage, Workers AI. When one
 * runs out every request that needs it fails until 00:00 UTC (09:00 in Korea). The routes answer with
 * one contract so the screens can say what stopped and when it comes back, from the responses they
 * already get (no request is added to find out).
 *
 * D1's messages (developers.cloudflare.com, d1/observability/debug-d1 and the 2026-09-01 changelog
 * "D1 free tier limit enforcement"): "Your account has exceeded D1's free tier daily row read limit…",
 * "…daily row write limit…", "Exceeded maximum DB size." / "…exceeded D1's maximum account storage
 * limit". They may start with "D1_ERROR: " and their ends differ, so a part is matched, any case.
 */

export type ServiceLimitKind = 'db-read' | 'db-write' | 'db-storage' | 'ai';
export type ServiceLimit = {
  service: ServiceLimitKind;
  /** The next 00:00 UTC (ISO). None for storage: it does not free itself. */
  resetAt?: string;
};

/** The next 00:00 UTC after `now`, when the daily limits start again. */
export function nextResetAt(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

const DB_LIMITS: [RegExp, ServiceLimitKind][] = [
  [/free tier daily row read limit/i, 'db-read'],
  [/free tier daily row write limit/i, 'db-write'],
  [/exceeded maximum db size|maximum account storage limit/i, 'db-storage'],
];

/**
 * Which daily limit an error is, if any: D1's messages on the error or its causes (three deep), or
 * an AI failure already classified as `quota_exhausted` (classifyCloudGemmaFailure).
 */
export function detectServiceLimit(error: unknown, now = new Date()): ServiceLimit | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (value.code === 'quota_exhausted') return { service: 'ai', resetAt: nextResetAt(now) };
    const message = typeof value.message === 'string' ? value.message : '';
    for (const [pattern, service] of DB_LIMITS)
      if (pattern.test(message))
        return service === 'db-storage' ? { service } : { service, resetAt: nextResetAt(now) };
    current = value.cause;
  }
  return null;
}

/** The words a response carries; the screens add the time in Korea from `resetAt`. */
const LIMIT_MESSAGES: Record<ServiceLimitKind, string> = {
  'db-read':
    '오늘 서버 이용 한도를 모두 써서 로그인·저장·불러오기가 잠시 멈췄어요. 한국 시간 오전 9시 이후 다시 접속해 주세요.',
  'db-write':
    '오늘 서버 이용 한도를 모두 써서 저장이 잠시 멈췄어요. 한국 시간 오전 9시 이후 다시 저장해 주세요.',
  'db-storage': '서버 저장 공간이 가득 찼어요. 관리자에게 알려 주세요.',
  ai: '오늘 AI 이용 한도를 모두 써서 AI 기능을 쓸 수 없어요. 한국 시간 오전 9시 이후 다시 시도해 주세요.',
};

/** A D1 limit's answer: 503, `SERVICE_LIMIT` and the limit; never the original error or the account. */
export function serviceLimitResponse(limit: ServiceLimit): Response {
  return Response.json(
    { error: LIMIT_MESSAGES[limit.service], code: 'SERVICE_LIMIT', limit },
    {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    },
  );
}

type Statement = Record<PropertyKey, unknown> & { bind: (...values: unknown[]) => Statement };
/**
 * The database as it was, noting a daily-limit error thrown by a query. For code that catches the
 * database's errors itself (Better Auth's get-session answers "no session" when its query fails):
 * the caller asks afterwards whether a limit was hit. Queries, their order and their results are
 * unchanged, so nothing is read twice.
 */
export function watchServiceLimit<T extends object>(db: T): { db: T; hit: () => unknown } {
  let seen: unknown;
  const note = <R>(run: () => Promise<R>) =>
    run().catch((error: unknown) => {
      if (detectServiceLimit(error)) seen ??= error;
      throw error;
    });
  // The database wants its own statements in a batch, not the watching ones.
  const own = new WeakMap<object, object>();
  const call = (object: object, value: unknown, values: unknown[]) =>
    (value as (...a: unknown[]) => unknown).apply(object, values);
  const statement = (target: Statement): Statement => {
    const wrapped = new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key, object);
        if (typeof value !== 'function') return value;
        if (key === 'bind')
          return (...values: unknown[]) => statement(call(object, value, values) as Statement);
        if (['first', 'all', 'run', 'raw'].includes(String(key)))
          return (...values: unknown[]) => note(async () => call(object, value, values));
        return value.bind(object);
      },
    });
    own.set(wrapped, target);
    return wrapped;
  };
  const watched = new Proxy(db, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      if (key === 'prepare') return (query: string) => statement(call(object, value, [query]) as Statement);
      if (key === 'batch')
        return (statements: object[], ...rest: unknown[]) =>
          note(async () => call(object, value, [statements.map((item) => own.get(item) ?? item), ...rest]));
      if (key === 'exec') return (...values: unknown[]) => note(async () => call(object, value, values));
      return value.bind(object);
    },
  });
  return { db: watched, hit: () => seen };
}
