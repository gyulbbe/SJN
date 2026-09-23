import { getRuntimeEnvironment, continueInBackground } from '../platform/runtime';
import { configuredStorage, blockedStatus, type RuntimeSettings, type StorageStatus } from './config';
import type { D1Bindings } from '../d1/types';

export function runtimeSelection() {
  const environment = getRuntimeEnvironment();
  return { environment, selection: configuredStorage(environment as RuntimeSettings) };
}

export async function storageStatus(): Promise<StorageStatus> {
  const { environment: env, selection } = runtimeSelection();
  if (selection.reason === 'invalid_configuration') return selection;
  if (env.platform !== 'cloudflare') return blockedStatus('unsupported_runtime');
  if (!env.DB || !env.ASSET_BUCKET) return blockedStatus('missing_bindings');
  let googleSignIn: boolean;
  try {
    const auth = await import('../auth/d1');
    googleSignIn = !!auth.validateD1AuthConfig(
      env as unknown as Parameters<typeof auth.validateD1AuthConfig>[0],
    ).google;
  } catch {
    return blockedStatus('invalid_configuration');
  }
  try {
    const [{ checkD1Storage }, auth] = await Promise.all([import('../d1'), import('../auth/d1')]);
    await Promise.all([
      checkD1Storage(env as unknown as D1Bindings),
      auth.checkD1AuthSchema(env as unknown as Parameters<typeof auth.checkD1AuthSchema>[0]),
    ]);
    return { ...selection, ready: true, googleSignIn };
  } catch {
    return blockedStatus('connection_failed');
  }
}

export function requireD1Environment() {
  const { environment, selection } = runtimeSelection();
  if (
    selection.mode !== 'd1' ||
    selection.reason === 'invalid_configuration' ||
    environment.platform !== 'cloudflare' ||
    !environment.DB ||
    !environment.ASSET_BUCKET
  )
    throw Object.assign(new Error('서버 저장 모드가 꺼져 있어요.'), { status: 503 });
  return environment;
}

export function serverError(error: unknown): Response {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
  const safeStatus = [400, 401, 403, 404, 409, 413, 429, 503].includes(status) ? status : 500;
  const message =
    safeStatus === 500
      ? '요청을 처리하지 못했어요. 현재 작업을 보존하고 다시 시도해 주세요.'
      : error instanceof Error
        ? error.message
        : '요청에 실패했어요.';
  return Response.json(
    {
      error: message,
      ...(error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['ACCOUNT_CHANGED', 'account_suspended', 'authentication_required', 'admin_required'].includes(
        error.code,
      )
        ? { code: error.code }
        : {}),
    },
    {
      status: safeStatus,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}

export async function d1Route(
  resource: 'projects' | 'materials' | 'assets' | 'cleanup' | 'role' | 'catalog' | 'project-materials',
  request: Request,
) {
  try {
    const env = requireD1Environment();
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.get('origin');
      if (
        (origin && origin !== new URL(request.url).origin) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        throw Object.assign(new Error('허용되지 않은 요청 출처예요.'), { status: 403 });
    }
    const auth = await import('../auth/d1');
    const actor = await auth.getD1Actor(request, env as unknown as Parameters<typeof auth.getD1Actor>[1]);
    const expectedUser = request.headers.get('X-SJN-User-Id');
    if (expectedUser && expectedUser !== actor.id)
      return Response.json(
        {
          error: '다른 계정으로 로그인되어 있어요. 현재 작업은 유지되며 계정을 다시 확인해야 해요.',
          code: 'ACCOUNT_CHANGED',
        },
        { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
      );
    const { handleD1Request, runD1Maintenance } = await import('../d1');
    const response = await handleD1Request(resource, request, env as unknown as D1Bindings, actor);
    if (response.ok && response.headers.get('X-SJN-Mutation') === '1') {
      response.headers.delete('X-SJN-Mutation');
      try {
        continueInBackground(runD1Maintenance(env as unknown as D1Bindings, actor));
      } catch {
        /* A scheduling failure cannot undo a confirmed database commit. */
      }
    }
    return response;
  } catch (error) {
    return serverError(error);
  }
}
