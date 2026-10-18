# d1-meter: 요청 1회의 D1 쿼리 수·읽은 행 기록

`tests/helpers/d1-meter.ts`로 저장해 쓴다. 이미 파일이 있으면 그것을 쓴다.

D1 결과의 `meta.rows_read`·`meta.rows_written`은 D1이 과금하는 값(훑은 행, 쓴 행)이다. Miniflare 로컬 D1도 같은 값을 준다.

2026-10-17에 Miniflare로 확인한 값은 다음과 같다.

- 500행 표에서 기본키 조회: 1행
- 인덱스 없는 조건: 500행
- `batch` 안의 각 문장: 따로 기록됨

`first()`는 meta를 돌려주지 않는다. 그래서 래퍼는 `first()`를 `all()`로 실행하고 첫 행을 고른다. 결과는 같다.

```ts
import type { D1DatabaseLike, D1Result, D1Statement } from '../../src/lib/d1/types';

/** One executed statement as D1 billed it: rows_read counts scanned rows, not returned rows. */
export type D1QueryRecord = {
  sql: string;
  via: 'first' | 'all' | 'run' | 'batch' | 'raw';
  rowsRead: number | null;
  rowsWritten: number | null;
};

const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const count = (meta: D1Result['meta'] | undefined, key: string) =>
  typeof meta?.[key] === 'number' ? (meta[key] as number) : null;

/** Test-only wrapper: same results as `db`, plus a log of every statement and its billed rows. */
export function meterD1(db: D1DatabaseLike) {
  const records: D1QueryRecord[] = [];
  const real = new WeakMap<object, { statement: D1Statement; sql: string }>();
  const note = (sql: string, via: D1QueryRecord['via'], meta?: D1Result['meta']) =>
    records.push({
      sql: compact(sql),
      via,
      rowsRead: count(meta, 'rows_read'),
      rowsWritten: count(meta, 'rows_written'),
    });
  function wrap(statement: D1Statement, sql: string): D1Statement {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'all' || prop === 'run')
          return async () => {
            const result = await target[prop]();
            note(sql, prop, result.meta);
            return result;
          };
        // first() returns no meta, so run all() and pick the first row exactly like D1 does.
        if (prop === 'first')
          return async (column?: string) => {
            const result = await target.all<Record<string, unknown>>();
            note(sql, 'first', result.meta);
            const row = result.results[0] ?? null;
            return column ? (row?.[column] ?? null) : row;
          };
        if (prop === 'raw')
          return (...args: unknown[]) => {
            note(sql, 'raw');
            return (target as unknown as { raw: (...a: unknown[]) => unknown }).raw(...args);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    real.set(proxy, { statement, sql });
    return proxy;
  }
  const metered = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (statements: D1Statement[]) => {
          const inner = statements.map((s) => real.get(s) ?? { statement: s, sql: '(unwrapped)' });
          const results = await target.batch(inner.map((entry) => entry.statement));
          results.forEach((result, index) => note(inner[index].sql, 'batch', result.meta));
          return results;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    db: metered as D1DatabaseLike,
    records,
    reset: () => void records.splice(0),
    summary: () => ({
      queries: records.length,
      rowsRead: records.reduce((sum, r) => sum + (r.rowsRead ?? 0), 0),
      rowsWritten: records.reduce((sum, r) => sum + (r.rowsWritten ?? 0), 0),
      unmetered: records.filter((r) => r.rowsRead === null).length,
    }),
  };
}
```

## 쓰는 법

- 서버 코드가 **테스트 프로세스 안에서** 실행돼야 래퍼가 동작한다.
- `worker.dispatchFetch`로 Miniflare 워커 안에서 실행하는 경로는 감쌀 수 없다. 이때는 `handleD1Request`(또는 해당 라우트 함수)를 직접 부른다.
- Miniflare의 `getD1Database()` 바인딩은 Node에서 바로 쓸 수 있다.

```ts
import { meterD1 } from './helpers/d1-meter';

const meter = meterD1(env.DB);
const metered = { ...env, DB: meter.db };
meter.reset();
const response = await handleD1Request(
  'assets',
  new Request(`https://sjn.test/api/d1/assets?id=${id}`),
  metered,
  { id: user, isAdmin: false },
);
expect(response.status).toBe(200);
const cost = meter.summary(); // { queries, rowsRead, rowsWritten, unmetered }
expect(cost.unmetered).toBe(0);
expect(cost.rowsRead, JSON.stringify(meter.records, null, 1)).toBeLessThanOrEqual(100);
```

- `handleD1Request`만 부르면 바깥 라우트가 하는 세션·역할·요청 제한 확인(요청마다 수 회, 각 1~2행)은 빠진다. 라우트 전체를 재려면 해당 `route.ts` 핸들러를 부르거나, 빠진 부분을 결과에 적는다.
- `tests/d1-storage.test.ts`의 "query budget" 테스트에는 문장 수만 세는 래퍼가 이미 있다. 같은 파일에서 읽은 행도 재야 한다면 이 헬퍼로 바꿔도 된다. 기존 기준(`<= 40`)은 유지한다.
- N과 5N 비교: 같은 테스트 안에서 기본 시드로 한 번 재고, 다른 사용자·공유 자재 데이터를 4N 더 넣은 뒤 같은 요청을 다시 잰다.
- `EXPLAIN QUERY PLAN`: 래퍼를 거치지 않고 `env.DB.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...).all()`로 본다. `detail`에 커지는 테이블의 `SCAN`이 있는지 확인한다.
