import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { D1DatabaseLike } from '@/lib/d1/types';

export interface D1AuthEnvironment {
  DB: D1DatabaseLike;
  APP_ENV?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export class D1AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'D1AuthError';
  }
}

export function validateD1AuthConfig(env: D1AuthEnvironment) {
  const fail = () => {
    throw new D1AuthError(503, 'auth_configuration_invalid', 'Google 로그인 설정을 확인해 주세요.');
  };
  let url: URL;
  try {
    url = new URL(env.BETTER_AUTH_URL ?? '');
  } catch {
    return fail();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && env.APP_ENV !== 'production'))
  )
    return fail();
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!secret || secret.length < 32 || !clientId || !clientSecret) return fail();
  if (/^(?:change[-_ ]?me|replace|your[-_ ]|example|better-auth-secret)/i.test(secret)) return fail();
  return { origin: url.origin, secret, clientId, clientSecret };
}

/** Explicit, read-only readiness probe. Auth never creates tables in request handlers. */
export async function checkD1AuthSchema(env: Pick<D1AuthEnvironment, 'DB'>) {
  try {
    const metadata = await env.DB.prepare('SELECT version FROM d1_auth_meta WHERE id = 1').first<{
      version: number;
    }>();
    if (metadata?.version !== 1) throw new Error('schema version');
    // LIMIT 0 still checks required columns, including optional columns Better Auth writes.
    await env.DB.prepare(
      `SELECT
      u.id, u.name, u.email, u.emailVerified, u.image, u.createdAt, u.updatedAt,
      s.id, s.token, s.userId, s.expiresAt, s.ipAddress, s.userAgent, s.createdAt, s.updatedAt,
      a.id, a.accountId, a.providerId, a.userId, a.accessToken, a.refreshToken, a.idToken,
      a.accessTokenExpiresAt, a.refreshTokenExpiresAt, a.scope, a.password, a.createdAt, a.updatedAt,
      v.id, v.identifier, v.value, v.expiresAt, v.createdAt, v.updatedAt,
      r.id, r.key, r.count, r.lastRequest, ar.user_id, um.status, um.revision
      FROM user u LEFT JOIN session s ON s.userId = u.id
      LEFT JOIN account a ON a.userId = u.id
      LEFT JOIN verification v ON 0 LEFT JOIN rateLimit r ON 0
      LEFT JOIN admin_roles ar ON ar.user_id = u.id
      LEFT JOIN d1_user_management um ON um.user_id = u.id LIMIT 0`,
    ).all();
  } catch {
    throw new D1AuthError(
      503,
      'auth_schema_unavailable',
      '로그인용 D1 마이그레이션 또는 연결을 확인해 주세요.',
    );
  }
}

/** Called from server routes with the current request's Cloudflare binding. */
export function createD1Auth(env: D1AuthEnvironment) {
  const config = validateD1AuthConfig(env);
  return betterAuth({
    appName: '공간미리',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database: env.DB as unknown as NonNullable<BetterAuthOptions['database']>,
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        prompt: 'select_account',
        accessType: 'online',
        includeGrantedScopes: false,
        requireEmailVerification: true,
        disableIdTokenSignIn: true,
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      accountLinking: { enabled: false },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const state = await env.DB.prepare('SELECT status FROM d1_user_management WHERE user_id=?')
              .bind(session.userId)
              .first<{ status: string }>();
            // SQL triggers repeat this check atomically if suspension races OAuth.
            if (state?.status !== 'active') return false;
          },
        },
      },
    },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    advanced: {
      cookiePrefix: 'sjn',
      disableCSRFCheck: false,
      disableOriginCheck: false,
      useSecureCookies: config.origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      database: {
        generateId: 'uuid',
        // Readiness validates our versioned migration; do not introspect every table on each request.
        validateSchema: false,
        joins: true,
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: { '/get-session': false, '/sign-in/social': { window: 60, max: 10 } },
    },
    telemetry: { enabled: false },
  });
}

export function assertD1RequestOrigin(request: Request, env: D1AuthEnvironment) {
  const { origin } = validateD1AuthConfig(env);
  if (new URL(request.url).origin !== origin) {
    throw new D1AuthError(403, 'origin_not_allowed', '허용되지 않은 요청 출처예요.');
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const requestOrigin = request.headers.get('origin');
  // Cookie-authenticated mutations are only accepted from this site's browser origin.
  if (requestOrigin !== origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new D1AuthError(403, 'origin_not_allowed', '허용되지 않은 요청 출처예요.');
  }
}

export async function getD1Session(request: Request, env: D1AuthEnvironment) {
  const session = await createD1Auth(env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session) return null;
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
    },
    session: { expiresAt: session.session.expiresAt },
  };
}

export async function getD1Actor(
  request: Request,
  env: D1AuthEnvironment,
): Promise<{ id: string; isAdmin: boolean }> {
  assertD1RequestOrigin(request, env);
  const session = await getD1Session(request, env);
  if (!session)
    throw new D1AuthError(
      401,
      'authentication_required',
      '로그인이 필요해요. 현재 작업을 보존하고 다시 로그인해 주세요.',
    );
  const state = await env.DB.prepare(
    'SELECT s.status,EXISTS(SELECT 1 FROM admin_roles r WHERE r.user_id=s.user_id) AS isAdmin FROM d1_user_management s WHERE s.user_id=?',
  )
    .bind(session.user.id)
    .first<{ status: string; isAdmin: number }>();
  if (!state) throw new D1AuthError(503, 'auth_schema_unavailable', '회원 상태 정보를 확인할 수 없어요.');
  if (state.status !== 'active')
    throw new D1AuthError(403, 'account_suspended', '이 계정은 이용이 정지되어 있어요.');
  return { id: session.user.id, isAdmin: !!state.isAdmin };
}

/** Route entrypoint also enforces origin on the first (not yet cookie-bearing) sign-in. */
export async function handleD1Auth(request: Request, env: D1AuthEnvironment): Promise<Response> {
  try {
    assertD1RequestOrigin(request, env);
    const response = await createD1Auth(env).handler(request);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    if (error instanceof D1AuthError) {
      return Response.json(
        { error: error.message, code: error.code },
        {
          status: error.status,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
    return Response.json(
      {
        error: '로그인을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
        code: 'authentication_unavailable',
      },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
