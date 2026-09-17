import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations, allD1Migrations } from './helpers/d1-migrations';
import type { D1DatabaseLike } from '../src/lib/d1/types';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const runtime = vi.hoisted(() => ({ value: { platform: 'node' } as Record<string, unknown> }));
vi.mock('@/lib/platform/runtime', () => ({ getRuntimeEnvironment: () => runtime.value }));
import { storageStatus, requireD1Environment, serverError } from '@/lib/storage/server';
import { GET as statusRoute } from '@/app/api/storage/status/route';

let mf: Miniflare;
let ready: Record<string, unknown>;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("isolated-storage-status-test"); } }',
      compatibilityDate: '2026-09-01',
      d1Databases: { DB: 'storage-server-tests' },
      r2Buckets: { ASSET_BUCKET: 'storage-server-assets' },
    }),
  );
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db as unknown as D1DatabaseLike, allD1Migrations);
  ready = {
    platform: 'cloudflare',
    APP_ENV: 'production',
    STORAGE_MODE: 'auto',
    DB: db,
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
    BETTER_AUTH_URL: 'https://storage-status.test',
    BETTER_AUTH_SECRET: 'test-only-secret-6885af99f46b4a278749d9b4f830a3a4',
    GOOGLE_CLIENT_ID: 'isolated-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'isolated-client-secret',
  };
}, 30_000);
beforeEach(() => {
  runtime.value = { platform: 'node' };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(async () => {
  await mf?.dispose();
});

describe('runtime storage status with real local D1/R2 bindings', () => {
  it('blocks an unconfigured Node runtime without falling back to browser storage', async () => {
    const prepare = vi.fn(() => {
      throw new Error('must not query');
    });
    const head = vi.fn(() => {
      throw new Error('must not touch R2');
    });
    runtime.value = { platform: 'node', DB: { prepare }, ASSET_BUCKET: { head } };
    expect(await storageStatus()).toMatchObject({
      mode: 'd1',
      ready: false,
      authRequired: true,
      reason: 'unsupported_runtime',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });
  it('blocks explicit local mode in production', async () => {
    const prepare = vi.fn();
    runtime.value = { ...ready, STORAGE_MODE: 'local', DB: { prepare } };
    expect(await storageStatus()).toMatchObject({
      mode: 'd1',
      ready: false,
      reason: 'invalid_configuration',
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it('returns a blocked reason for invalid modes, missing bindings and unsupported runtimes', async () => {
    for (const [patch, reason] of [
      [{ STORAGE_MODE: 'unknown' }, 'invalid_configuration'],
      [{ DB: undefined }, 'missing_bindings'],
      [{ ASSET_BUCKET: undefined }, 'missing_bindings'],
      [{ platform: 'node' }, 'unsupported_runtime'],
    ] as const) {
      runtime.value = { ...ready, ...patch };
      expect(await storageStatus()).toMatchObject({ mode: 'd1', ready: false, reason });
    }
  });
  it('blocks invalid Google settings before probing D1', async () => {
    const prepare = vi.fn();
    runtime.value = { ...ready, GOOGLE_CLIENT_SECRET: '', DB: { prepare } };
    expect(await storageStatus()).toMatchObject({
      mode: 'd1',
      ready: false,
      reason: 'invalid_configuration',
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it('confirms migrations and R2 access without writing a health object or creating a member', async () => {
    runtime.value = ready;
    const result = await storageStatus();
    expect(result).toEqual({ mode: 'd1', ready: true, reason: 'ready', authRequired: true });
    const db = await mf.getD1Database('DB');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM user').first()).toEqual({ count: 0 });
    const bucket = (await mf.getR2Bucket('ASSET_BUCKET')) as unknown as {
      list(): Promise<{ objects: unknown[] }>;
    };
    expect((await bucket.list()).objects).toHaveLength(0);
  });
  it('shows an authenticated backend as ready without claiming Google credentials were verified', async () => {
    runtime.value = ready;
    const response = await statusRoute();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const serialized = await response.text();
    expect(JSON.parse(serialized)).toMatchObject({ mode: 'd1', authRequired: true });
    for (const key of [
      'BETTER_AUTH_SECRET',
      'GOOGLE_CLIENT_SECRET',
      'DB',
      'ASSET_BUCKET',
      'isolated-client-secret',
    ])
      expect(serialized).not.toContain(key);
  });
  it('blocks D1 or R2 readiness failures without leaking service errors', async () => {
    runtime.value = {
      ...ready,
      ASSET_BUCKET: {
        head: async () => {
          throw new Error('sensitive bucket diagnostics');
        },
      },
    };
    expect(await storageStatus()).toMatchObject({ mode: 'd1', ready: false, reason: 'connection_failed' });
    const db = await mf.getD1Database('DB');
    await db.prepare('UPDATE d1_auth_meta SET version = 999').run();
    try {
      runtime.value = ready;
      expect(await storageStatus()).toMatchObject({ mode: 'd1', ready: false, reason: 'connection_failed' });
    } finally {
      await db.prepare('UPDATE d1_auth_meta SET version = 1').run();
    }
  });
  it('rejects the inactive Supabase execution path in both runtimes', async () => {
    runtime.value = { ...ready, STORAGE_MODE: 'supabase' };
    expect(await storageStatus()).toMatchObject({ mode: 'd1', ready: false, reason: 'invalid_configuration' });
    runtime.value = { platform: 'node', APP_ENV: 'production', STORAGE_MODE: 'supabase' };
    expect(await storageStatus()).toMatchObject({
      mode: 'd1',
      ready: false,
      reason: 'invalid_configuration',
    });
  });
  it('does not permit a cloud API call to bypass the configured local mode', () => {
    runtime.value = { ...ready, STORAGE_MODE: 'local' };
    expect(() => requireD1Environment()).toThrow('서버 저장 모드가 꺼져 있어요.');
    runtime.value = ready;
    expect(requireD1Environment()).toBe(ready);
  });
  it('bounds the public readiness response while stalled binding requests remain unresolved', async () => {
    vi.useFakeTimers();
    const pending = () => new Promise<never>(() => {});
    runtime.value = { ...ready, DB: { prepare: () => ({ first: pending, all: pending }) } };
    const result = statusRoute();
    await vi.advanceTimersByTimeAsync(4500);
    expect(await (await result).json()).toMatchObject({
      mode: 'd1',
      ready: false,
      reason: 'initialization_timeout',
    });
  });
  it('sanitizes unknown server failures while preserving actionable status codes', async () => {
    const failure = serverError(new Error('private SQL and token diagnostics'));
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain('private SQL');
    const expired = serverError(Object.assign(new Error('다시 로그인해 주세요.'), { status: 401 }));
    expect(expired.status).toBe(401);
    expect(expired.headers.get('cache-control')).toContain('no-store');
  });
});
