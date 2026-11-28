/**
 * The readiness check's reuse (src/lib/storage/server.ts, docs/d1-efficiency-round3-results-20261128.md,
 * D): a passed D1/R2 check is reused for five minutes in the isolate and asks D1 nothing meanwhile; a
 * failure is never reused; a spent daily limit still reaches the screens through the other requests
 * while a pass is reused. Also the check's own statements (fewer than before, the same findings).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { meterD1 } from './helpers/d1-meter';
import type { D1DatabaseLike } from '../src/lib/d1/types';

const runtime = vi.hoisted(() => ({ value: { platform: 'node' } as Record<string, unknown> }));
vi.mock('@/lib/platform/runtime', () => ({
  getRuntimeEnvironment: () => runtime.value,
  continueInBackground: () => {},
}));
import { storageStatus, READY_REUSE_MS } from '@/lib/storage/server';
import { GET as catalogMaterials } from '@/app/api/catalog/materials/route';

const origin = 'https://ready-reuse.test';
const READ_LIMIT = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit.";
let mf: Miniflare, db: D1DatabaseLike, base: Record<string, unknown>;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ready") } }',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'ready-reuse' },
      r2Buckets: { ASSET_BUCKET: 'ready-reuse' },
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  await applyD1Migrations(db, allD1Migrations);
  base = {
    platform: 'cloudflare',
    APP_ENV: 'production',
    STORAGE_MODE: 'auto',
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'test-only-secret-ready-reuse-4c1f7d2e9b8a4f6c',
  };
}, 60000);
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await mf?.dispose();
});

/** A database object of its own whose queries can be made to fail with a message. */
function switchable() {
  const meter = meterD1(db);
  const state = { failure: '' };
  const fails = (value: unknown) =>
    typeof value === 'function'
      ? (...args: unknown[]) => {
          if (state.failure) return Promise.reject(new Error(state.failure));
          return (value as (...a: unknown[]) => unknown)(...args);
        }
      : value;
  const wrapStatement = (statement: object): object =>
    new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === 'bind')
          return (...values: unknown[]) =>
            wrapStatement((value as (...a: unknown[]) => object).apply(target, values));
        if (['first', 'all', 'run', 'raw'].includes(String(key)))
          return fails((value as (...a: unknown[]) => unknown).bind(target));
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  const database = new Proxy(meter.db as unknown as object, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === 'prepare')
        return (sql: string) => wrapStatement((value as (q: string) => object).call(target, sql));
      if (key === 'batch') return fails((value as (...a: unknown[]) => unknown).bind(target));
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { database, meter, state };
}

describe('준비 검사 재사용 (같은 isolate 5분)', () => {
  it('통과는 5분 동안 D1에 묻지 않고, 그 뒤 다시 확인한다', { timeout: 60000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { database, meter } = switchable();
    runtime.value = { ...base, DB: database };
    expect(await storageStatus()).toMatchObject({ ready: true, reason: 'ready' });
    const first = meter.summary();
    // The check's own statements: the schema list, the three versions in one, the columns in one, and the auth check's two.
    expect(first.queries).toBeLessThanOrEqual(5);
    meter.reset();
    vi.setSystemTime(Date.now() + READY_REUSE_MS - 1000);
    expect(await storageStatus()).toMatchObject({ ready: true, reason: 'ready' });
    expect(meter.summary().queries).toBe(0);
    vi.setSystemTime(Date.now() + 2000);
    expect(await storageStatus()).toMatchObject({ ready: true });
    expect(meter.summary().queries).toBe(first.queries);
  });

  it('실패는 재사용하지 않는다', { timeout: 60000 }, async () => {
    const { database, meter, state } = switchable();
    runtime.value = { ...base, DB: database };
    state.failure = 'D1_ERROR: network connection lost';
    expect(await storageStatus()).toMatchObject({ ready: false, reason: 'connection_failed' });
    expect(await storageStatus()).toMatchObject({ ready: false, reason: 'connection_failed' });
    state.failure = '';
    meter.reset();
    expect(await storageStatus()).toMatchObject({ ready: true });
    expect(meter.summary().queries).toBeGreaterThan(0);
  });

  it('통과를 재사용하는 동안 하루 한도가 차도, 다른 요청이 한도를 알린다', { timeout: 60000 }, async () => {
    const { database, state } = switchable();
    runtime.value = { ...base, DB: database };
    expect(await storageStatus()).toMatchObject({ ready: true });
    state.failure = READ_LIMIT;
    // The reused pass says ready...
    expect(await storageStatus()).toMatchObject({ ready: true });
    // ...and the screens' next request that reads D1 (here the public list) tells the limit and when.
    const list = await catalogMaterials(new Request(origin + '/api/catalog/materials'));
    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ code: 'SERVICE_LIMIT', limit: { service: 'db-read' } });
    // A different database (another deploy's binding) is checked on its own: the limit shows there.
    const other = switchable();
    other.state.failure = READ_LIMIT;
    runtime.value = { ...base, DB: other.database };
    expect(await storageStatus()).toMatchObject({ ready: false, reason: 'daily_limit' });
  });
});
