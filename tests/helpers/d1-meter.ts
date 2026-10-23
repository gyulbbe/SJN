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
