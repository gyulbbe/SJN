import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyD1Migrations, allD1Migrations } from './helpers/d1-migrations';
import type { D1DatabaseLike } from '../src/lib/d1/types';

// Every route that reads D1 answers a spent daily limit the same way: 503, SERVICE_LIMIT and the
// limit, never the database's own words. Real Miniflare D1/R2 and real Better Auth; the database
// throws Cloudflare's message for the queries a case chooses.
const runtime = vi.hoisted(() => ({ value: { platform: 'node' } as Record<string, unknown> }));
vi.mock('@/lib/platform/runtime', () => ({
  getRuntimeEnvironment: () => runtime.value,
  continueInBackground: () => {},
}));
import { GET as statusRoute } from '@/app/api/storage/status/route';
import { GET as sessionRoute } from '@/app/api/storage/session/route';
import { GET as authGet, POST as authPost } from '@/app/api/auth/[...all]/route';
import { POST as projectsRoute } from '@/app/api/d1/projects/route';
import { GET as catalogRoute } from '@/app/api/catalog/materials/route';
import { GET as adminProjectsRoute } from '@/app/api/admin/projects/route';
import { POST as photorealRoute } from '@/app/api/export/photoreal/route';

const origin = 'https://service-limit.test';
const READ =
  "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to Workers Paid.";
let mf: Miniflare;
let db: D1DatabaseLike;
let ready: Record<string, unknown>;
let cookie = '';

/** The database, throwing Cloudflare's limit message for the queries `fails` picks. */
function limited(fails: (query: string) => boolean, message = READ): D1DatabaseLike {
  const own = new WeakMap<object, unknown>();
  const statement = (query: string, target: Record<string, unknown>): Record<string, unknown> => {
    const wrapped: Record<string, unknown> = new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key, object) as unknown;
        if (typeof value !== 'function') return value;
        if (key === 'bind')
          return (...values: unknown[]) =>
            statement(query, (value as (...a: unknown[]) => Record<string, unknown>).apply(object, values));
        if (['first', 'all', 'run', 'raw'].includes(String(key)))
          return async (...values: unknown[]) => {
            if (fails(query)) throw new Error(message);
            return (value as (...a: unknown[]) => unknown).apply(object, values);
          };
        return (value as (...a: unknown[]) => unknown).bind(object);
      },
    });
    own.set(wrapped, target);
    return wrapped;
  };
  return new Proxy(db as unknown as Record<string, unknown>, {
    get(object, key) {
      const value = Reflect.get(object, key, object) as unknown;
      if (key === 'prepare')
        return (query: string) =>
          statement(query, (value as (q: string) => Record<string, unknown>).call(object, query));
      if (key === 'batch')
        return async (items: object[]) => {
          if (fails('batch')) throw new Error(message);
          return (value as (s: unknown[]) => unknown).call(
            object,
            items.map((item) => own.get(item) ?? item),
          );
        };
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(object) : value;
    },
  }) as unknown as D1DatabaseLike;
}
const all = () => true;
const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(origin + path, {
    method,
    headers: {
      origin,
      'cf-connecting-ip': '203.0.113.7',
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function expectLimit(response: Response, service = 'db-read') {
  expect(response.status).toBe(503);
  const text = await response.text();
  for (const leak of ['exceeded', 'D1_ERROR', 'Workers Paid', 'free tier']) expect(text).not.toContain(leak);
  const body = JSON.parse(text);
  expect(body).toMatchObject({ code: 'SERVICE_LIMIT', limit: { service } });
  if (service !== 'db-storage') expect(body.limit.resetAt).toMatch(/T00:00:00\.000Z$/);
  return body;
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("service-limit-test"); } }',
      compatibilityDate: '2026-09-01',
      d1Databases: { DB: 'service-limit-tests' },
      r2Buckets: { ASSET_BUCKET: 'service-limit-assets' },
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  await applyD1Migrations(db, allD1Migrations);
  ready = {
    platform: 'cloudflare',
    APP_ENV: 'production',
    STORAGE_MODE: 'auto',
    DB: db,
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'test-only-secret-4c1f7d2e9b8a4f6c8d3e2a1b0c9f8e7d',
  };
  // A real member (an administrator), signed in once while the database still answers.
  runtime.value = ready;
  const signUp = await authPost(
    request('/api/auth/sign-up/email', 'POST', { username: 'limituser', password: 'limit-password-1' }),
  );
  expect(signUp.status).toBe(200);
  cookie = signUp.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const user = await db
    .prepare('SELECT id FROM user WHERE username=?')
    .bind('limituser')
    .first<{ id: string }>();
  await db.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(user!.id).run();
}, 60_000);
beforeEach(() => {
  runtime.value = ready;
});
afterAll(async () => {
  await mf?.dispose();
});

describe('a spent D1 daily limit on every route that reads D1', () => {
  it('the readiness check says daily_limit and when (the screens’ first request)', async () => {
    runtime.value = { ...ready, DB: limited(all) };
    const body = await (await statusRoute()).json();
    expect(body).toMatchObject({ ready: false, reason: 'daily_limit', limit: { service: 'db-read' } });
    expect(body.limit.resetAt).toMatch(/T00:00:00\.000Z$/);
    expect(JSON.stringify(body)).not.toContain('exceeded');
    runtime.value = { ...ready, DB: limited(all, 'D1_ERROR: Exceeded maximum DB size.') };
    expect(await (await statusRoute()).json()).toMatchObject({
      reason: 'storage_full',
      limit: { service: 'db-storage' },
    });
    // Any other failure stays a connection failure.
    runtime.value = { ...ready, DB: limited(all, 'D1_ERROR: network connection lost') };
    expect(await (await statusRoute()).json()).toMatchObject({ reason: 'connection_failed' });
    runtime.value = ready;
    expect(await (await statusRoute()).json()).toMatchObject({ ready: true, reason: 'ready' });
  });

  it('sign-in and the session (which Better Auth would answer as signed out)', async () => {
    runtime.value = { ...ready, DB: limited(all) };
    await expectLimit(
      await authPost(
        request('/api/auth/sign-in/username', 'POST', {
          username: 'limituser',
          password: 'limit-password-1',
        }),
      ),
    );
    // Better Auth answers get-session with 200 null when its query fails: not "signed out" here.
    await expectLimit(await authGet(request('/api/auth/get-session')));
    await expectLimit(await sessionRoute(request('/api/storage/session')));
    // The database answering again: the session is there.
    runtime.value = ready;
    const session = await authGet(request('/api/auth/get-session'));
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { username: 'limituser' } });
  });

  it('account data: in the sign-in check and in the handler', async () => {
    runtime.value = { ...ready, DB: limited(all) };
    await expectLimit(await projectsRoute(request('/api/d1/projects', 'POST', { operation: 'list' })));
    runtime.value = { ...ready, DB: limited((query) => /d1_projects/.test(query)) };
    await expectLimit(await projectsRoute(request('/api/d1/projects', 'POST', { operation: 'list' })));
    runtime.value = {
      ...ready,
      DB: limited(
        (query) => /d1_projects/.test(query),
        "D1_ERROR: Your account has exceeded D1's free tier daily row write limit.",
      ),
    };
    await expectLimit(
      await projectsRoute(request('/api/d1/projects', 'POST', { operation: 'list' })),
      'db-write',
    );
    runtime.value = ready;
    expect((await projectsRoute(request('/api/d1/projects', 'POST', { operation: 'list' }))).status).toBe(
      200,
    );
  });

  it('the public catalogue and the administrator’s pages', async () => {
    runtime.value = { ...ready, DB: limited(all) };
    await expectLimit(await catalogRoute());
    await expectLimit(await adminProjectsRoute(request('/api/admin/projects')));
    // Past the sign-in check, in the administrator's own query.
    runtime.value = {
      ...ready,
      DB: limited((query) => /d1_projects/.test(query) && !/d1_user_management/.test(query)),
    };
    await expectLimit(await adminProjectsRoute(request('/api/admin/projects')));
  });

  it('an AI route whose sign-in check meets the limit says so, not "check the sign-in settings"', async () => {
    runtime.value = { ...ready, DB: limited(all), AI: { run: vi.fn() } };
    const response = await photorealRoute(request('/api/export/photoreal', 'POST', {}));
    await expectLimit(response);
    expect((runtime.value.AI as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
  });

  it('watching for the limit adds no query (d1-query-budget)', async () => {
    const { createD1Auth, handleD1Auth } = await import('@/lib/auth/d1');
    // Every query run, counted on the database itself.
    const counted = () => {
      const queries: string[] = [];
      const database = limited((query) => {
        queries.push(query);
        return false;
      });
      return { queries, env: { ...ready, DB: database } as Parameters<typeof handleD1Auth>[1] };
    };
    for (const path of ['/api/auth/get-session', '/api/storage/session']) {
      const plain = counted(),
        watched = counted();
      await createD1Auth(plain.env).handler(request('/api/auth/get-session'));
      if (path === '/api/auth/get-session') await handleD1Auth(request(path), watched.env);
      else {
        runtime.value = watched.env as unknown as Record<string, unknown>;
        await sessionRoute(request(path));
      }
      expect(watched.queries.length).toBeGreaterThan(0);
      expect(watched.queries).toEqual(plain.queries);
    }
  });

  it('other failures keep their answers', async () => {
    runtime.value = { ...ready, DB: limited(all, 'D1_ERROR: no such table: d1_projects') };
    const response = await projectsRoute(request('/api/d1/projects', 'POST', { operation: 'list' }));
    expect(response.status).not.toBe(503);
    expect(await response.text()).not.toContain('SERVICE_LIMIT');
  });
});
