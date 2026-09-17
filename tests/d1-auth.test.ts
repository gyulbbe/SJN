import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  assertD1RequestOrigin,
  checkD1AuthSchema,
  createD1Auth,
  D1AuthError,
  getD1Actor,
  getD1Session,
  handleD1Auth,
  validateD1AuthConfig,
  type D1AuthEnvironment,
} from '@/lib/auth/d1';

// This suite uses real Better Auth and Miniflare D1. Google HTTP responses are
// locally signed provider fixtures, never real Google OAuth or a production bypass.
const origin = 'https://sjn-auth.test';
let mf: Miniflare;
let env: D1AuthEnvironment;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
function request(path: string, method = 'GET', cookie?: string, body?: unknown, ip = '203.0.113.10') {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      origin,
      'cf-connecting-ip': ip,
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function startLogin() {
  const auth = createD1Auth(env);
  const response = await auth.handler(
    request('/api/auth/sign-in/social', 'POST', undefined, {
      provider: 'google',
      callbackURL: '/',
      errorCallbackURL: '/?auth=error',
      disableRedirect: true,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url: string };
  return { auth, response, authorize: new URL(body.url), cookie: cookies(response) };
}

async function mockGoogle(authorize: URL, emailVerified = true) {
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'local-test-key', alg: 'RS256', use: 'sig' };
  const idToken = await new SignJWT({
    email: 'member@sjn-auth.test',
    email_verified: emailVerified,
    name: '로컬 OAuth 테스트',
    picture: 'https://sjn-auth.test/avatar.png',
    ...(authorize.searchParams.get('nonce') ? { nonce: authorize.searchParams.get('nonce') } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(env.GOOGLE_CLIENT_ID!)
    .setSubject('google-local-test-member')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(keys.privateKey);
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      expect(form.get('code_verifier')).toBeTruthy();
      expect(form.get('redirect_uri')).toBe(`${origin}/api/auth/callback/google`);
      return Response.json({
        access_token: 'local-only-access-token',
        id_token: idToken,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected external request in isolated auth test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function completeLogin() {
  const login = await startLogin();
  await mockGoogle(login.authorize);
  const response = await login.auth.handler(
    request(
      `/api/auth/callback/google?code=local-code&state=${login.authorize.searchParams.get('state')}`,
      'GET',
      login.cookie,
    ),
  );
  expect(response.status).toBe(302);
  expect(new URL(response.headers.get('location')!, origin).href).toBe(`${origin}/`);
  return { ...login, response, cookie: cookies(response) };
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("test"); } }',
      compatibilityDate: '2026-09-01',
      d1Databases: { DB: 'd1-auth-tests' },
    }),
  );
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db as unknown as D1AuthEnvironment['DB'], allD1Migrations);
  env = {
    DB: db as unknown as D1AuthEnvironment['DB'],
    APP_ENV: 'production',
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'test-only-secret-8a03d9e1aebb4495831f9ce6b84e061b',
    GOOGLE_CLIENT_ID: 'local-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'local-only-client-secret',
  };
  keys = await generateKeyPair('RS256', { extractable: true });
}, 30_000);

beforeEach(async () => {
  await env.DB.batch(
    ['admin_roles', 'session', 'account', 'verification', 'rateLimit', 'user'].map((table) =>
      env.DB.prepare(`DELETE FROM "${table}"`),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mf?.dispose();
});

describe('D1 Google auth configuration and migrations', () => {
  it('checks the actual migration without inserting a readiness object or account', async () => {
    await expect(checkD1AuthSchema(env)).resolves.toBeUndefined();
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM user').first()).toEqual({ count: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_roles').first()).toEqual({ count: 0 });
  });
  it('rejects missing secrets, non-origin URLs, and insecure production URLs', () => {
    for (const patch of [
      { BETTER_AUTH_SECRET: '' },
      { GOOGLE_CLIENT_ID: '' },
      { GOOGLE_CLIENT_SECRET: '' },
      { BETTER_AUTH_SECRET: 'replace-me-with-your-own-32-character-secret' },
      { BETTER_AUTH_URL: `${origin}/api/auth` },
      { BETTER_AUTH_URL: 'http://localhost:3000' },
      { BETTER_AUTH_URL: 'https://user:pass@example.com' },
      { BETTER_AUTH_URL: `${origin}?redirect=1` },
    ])
      expect(() => validateD1AuthConfig({ ...env, ...patch })).toThrow(D1AuthError);
    expect(
      validateD1AuthConfig({ ...env, APP_ENV: 'local', BETTER_AUTH_URL: 'http://127.0.0.1:8787' }).origin,
    ).toBe('http://127.0.0.1:8787');
  });
  it('fails readiness on a missing migration version', async () => {
    await env.DB.prepare('UPDATE d1_auth_meta SET version = 999').run();
    try {
      await expect(checkD1AuthSchema(env)).rejects.toMatchObject({
        status: 503,
        code: 'auth_schema_unavailable',
      });
    } finally {
      await env.DB.prepare('UPDATE d1_auth_meta SET version = 1').run();
    }
  });
  it('keeps passwords and account auto-linking disabled and enables secure cookies', () => {
    const auth = createD1Auth(env);
    expect(auth.options.emailAndPassword.enabled).toBe(false);
    expect(auth.options.account.accountLinking.enabled).toBe(false);
    expect(auth.options.advanced.useSecureCookies).toBe(true);
    expect(auth.options.telemetry.enabled).toBe(false);
  });
});

describe('real auth handlers with an isolated Google provider fixture', () => {
  it('starts Google OAuth with PKCE and stores one-use state in D1', async () => {
    const { response, authorize, cookie } = await startLogin();
    expect(authorize.origin).toBe('https://accounts.google.com');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/callback/google`);
    expect(cookie).toContain('sjn.state');
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/i);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS count FROM verification').first<{ count: number }>())?.count,
    ).toBe(1);
  });
  it('registers a regular member, verifies the signed cookie, and reads role from D1', async () => {
    const { cookie } = await completeLogin();
    const req = request('/api/cloud/projects', 'GET', cookie);
    const actor = await getD1Actor(req, env);
    expect(actor).toMatchObject({ isAdmin: false });
    expect(actor.id).toMatch(/^[0-9a-f-]{36}$/);
    const session = await getD1Session(req, env);
    expect(session?.user.email).toBe('member@sjn-auth.test');
    expect(session?.session).not.toHaveProperty('token');
    await env.DB.prepare('INSERT INTO admin_roles (user_id) VALUES (?)').bind(actor.id).run();
    expect((await getD1Actor(req, env)).isAdmin).toBe(true);
    await env.DB.prepare('DELETE FROM admin_roles WHERE user_id = ?').bind(actor.id).run();
    expect((await getD1Actor(req, env)).isAdmin).toBe(false);
    const account = await env.DB.prepare('SELECT accessToken FROM account').first<{ accessToken: string }>();
    expect(account?.accessToken).not.toBe('local-only-access-token');
  });
  it('logs an existing Google member in again without duplicate signup or privilege promotion', async () => {
    const first = await completeLogin();
    const firstActor = await getD1Actor(request('/api/d1/projects', 'GET', first.cookie), env);
    expect((await first.auth.handler(request('/api/auth/sign-out', 'POST', first.cookie, {}))).status).toBe(
      200,
    );
    const second = await completeLogin();
    const secondActor = await getD1Actor(request('/api/d1/projects', 'GET', second.cookie), env);
    expect(secondActor).toEqual(firstActor);
    expect(secondActor.isAdmin).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM user').first()).toEqual({ count: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM account').first()).toEqual({ count: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_roles').first()).toEqual({ count: 0 });
    await expect(getD1Actor(request('/api/d1/projects', 'GET', first.cookie), env)).rejects.toMatchObject({
      status: 401,
    });
  }, 30000);
  it('rejects unverified provider email instead of creating a usable member session', async () => {
    const login = await startLogin();
    await mockGoogle(login.authorize, false);
    const response = await login.auth.handler(
      request(
        `/api/auth/callback/google?code=local-code&state=${login.authorize.searchParams.get('state')}`,
        'GET',
        login.cookie,
      ),
    );
    expect(response.headers.get('location')).toContain('error');
    expect(await getD1Session(request('/api/cloud/projects', 'GET', cookies(response)), env)).toBeNull();
  });
  it('rejects missing, expired and tampered sessions', async () => {
    await expect(getD1Actor(request('/api/cloud/projects'), env)).rejects.toMatchObject({ status: 401 });
    const { cookie } = await completeLogin();
    await expect(
      getD1Actor(request('/api/cloud/projects', 'GET', `${cookie}tampered`), env),
    ).rejects.toMatchObject({ status: 401 });
    await env.DB.prepare('UPDATE session SET expiresAt = ?').bind(new Date(0).toISOString()).run();
    await expect(getD1Actor(request('/api/cloud/projects', 'GET', cookie), env)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('uses two D1 queries for an existing actor without refreshing or introspecting schema', async () => {
    const login = await completeLogin();
    const prepared: string[] = [];
    const countedEnvironment: D1AuthEnvironment = {
      ...env,
      DB: {
        // Preserve native D1 adapter detection while proving no schema exec is needed.
        ...{
          exec: () => {
            throw new Error('Unexpected D1 exec during actor lookup');
          },
        },
        prepare(query) {
          prepared.push(query);
          return env.DB.prepare(query);
        },
        batch(statements) {
          return env.DB.batch(statements);
        },
      },
    };
    const actor = await getD1Actor(request('/api/d1/projects', 'GET', login.cookie), countedEnvironment);
    expect(actor.id).toBeTruthy();
    expect(prepared).toHaveLength(2);
    expect(prepared.every((query) => /^select/i.test(query.trim()))).toBe(true);
    expect(prepared[0]).toContain('session');
    expect(prepared[1]).toContain('admin_roles');
  });
  it('revokes old sessions and rejects a suspended member returning through Google OAuth', async () => {
    const first = await completeLogin();
    const actor = await getD1Actor(request('/api/d1/projects', 'GET', first.cookie), env);
    await env.DB.prepare(
      "UPDATE d1_user_management SET status='suspended',revision=revision+1 WHERE user_id=?",
    )
      .bind(actor.id)
      .run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM session').first()).toEqual({ count: 0 });
    await expect(getD1Actor(request('/api/d1/projects', 'GET', first.cookie), env)).rejects.toMatchObject({
      status: 401,
    });
    const login = await startLogin();
    await mockGoogle(login.authorize);
    const response = await login.auth.handler(
      request(
        '/api/auth/callback/google?code=local-code&state=' + login.authorize.searchParams.get('state'),
        'GET',
        login.cookie,
      ),
    );
    expect(response.headers.get('location')).toContain('error');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM session').first()).toEqual({ count: 0 });
    expect(await getD1Session(request('/api/d1/projects', 'GET', cookies(response)), env)).toBeNull();
    await env.DB.prepare("UPDATE d1_user_management SET status='active',revision=revision+1 WHERE user_id=?")
      .bind(actor.id)
      .run();
    const restored = await completeLogin();
    expect(await getD1Actor(request('/api/d1/projects', 'GET', restored.cookie), env)).toEqual(actor);
  }, 30000);
  it('checks latest state if suspension happens between session lookup and actor authorization', async () => {
    const login = await completeLogin();
    let suspended = false;
    const raced: D1AuthEnvironment = {
      ...env,
      DB: {
        ...{
          exec: () => {
            throw new Error('Unexpected exec');
          },
        },
        batch: (statements) => env.DB.batch(statements),
        prepare(query) {
          const statement = env.DB.prepare(query);
          if (!query.includes('AS isAdmin FROM d1_user_management')) return statement;
          return {
            ...statement,
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                ...bound,
                async first<T>() {
                  await env.DB.prepare("UPDATE d1_user_management SET status='suspended' WHERE user_id=?")
                    .bind(values[0])
                    .run();
                  suspended = true;
                  return bound.first<T>();
                },
              };
            },
          };
        },
      },
    };
    await expect(getD1Actor(request('/api/d1/projects', 'GET', login.cookie), raced)).rejects.toMatchObject({
      status: 403,
      code: 'account_suspended',
    });
    expect(suspended).toBe(true);
  });
  it('logout invalidates the server session immediately', async () => {
    const login = await completeLogin();
    const response = await login.auth.handler(request('/api/auth/sign-out', 'POST', login.cookie, {}));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(getD1Actor(request('/api/cloud/projects', 'GET', login.cookie), env)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects state replay and a callback without the browser state cookie', async () => {
    const login = await startLogin();
    const fetchMock = await mockGoogle(login.authorize);
    const callback = `/api/auth/callback/google?code=local-code&state=${login.authorize.searchParams.get('state')}`;
    const withoutCookie = await login.auth.handler(request(callback));
    expect(withoutCookie.headers.get('location')).toContain('error');
    expect(fetchMock).not.toHaveBeenCalled();
    const fresh = await completeLogin();
    const replay = await fresh.auth.handler(
      request(
        `/api/auth/callback/google?code=local-code&state=${fresh.authorize.searchParams.get('state')}`,
        'GET',
        fresh.cookie,
      ),
    );
    expect(replay.headers.get('location')).toContain('error');
  });
  it('rejects hostile login origins and external post-login redirects', async () => {
    const auth = createD1Auth(env);
    const response = await handleD1Auth(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin: 'https://attacker.test', 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    const redirect = await auth.handler(
      request('/api/auth/sign-in/social', 'POST', undefined, {
        provider: 'google',
        callbackURL: 'https://attacker.test',
      }),
    );
    expect(redirect.status).toBe(403);
  });
  it('limits repeated sign-in attempts across separate auth instances', async () => {
    for (let i = 0; i < 10; i++) await startLogin();
    const response = await createD1Auth(env).handler(
      request('/api/auth/sign-in/social', 'POST', undefined, { provider: 'google', callbackURL: '/' }),
    );
    expect(response.status).toBe(429);
  }, 20_000);
});

describe('cookie-authenticated cloud mutation origin boundary', () => {
  it('accepts same-origin writes and rejects missing/foreign origins', () => {
    expect(() =>
      assertD1RequestOrigin(request('/api/cloud/projects', 'POST', undefined, {}), env),
    ).not.toThrow();
    const origins: Record<string, string>[] = [
      {},
      { origin: 'https://attacker.test' },
      { origin, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of origins) {
      expect(() =>
        assertD1RequestOrigin(new Request(`${origin}/api/cloud/projects`, { method: 'POST', headers }), env),
      ).toThrow(D1AuthError);
    }
    expect(() => assertD1RequestOrigin(new Request('https://attacker.test/api/cloud/projects'), env)).toThrow(
      D1AuthError,
    );
  });
});
