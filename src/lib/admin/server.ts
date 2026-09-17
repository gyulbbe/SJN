import { getD1Actor } from '../auth/d1';
import { requireD1Environment, serverError } from '../storage/server';
import type { Context } from '../d1/database';
import type { D1Bindings } from '../d1/types';

export async function authenticatedContext(request: Request): Promise<Context> {
  const env = requireD1Environment();
  const actor = await getD1Actor(request, env as unknown as Parameters<typeof getD1Actor>[1]);
  const expected = request.headers.get('X-SJN-User-Id');
  if (expected && expected !== actor.id)
    throw Object.assign(new Error('다른 계정으로 로그인되어 있어요. 계정을 다시 확인해 주세요.'), {
      status: 401,
      code: 'ACCOUNT_CHANGED',
    });
  return { env: env as unknown as D1Bindings, actor };
}
export async function adminRoute(
  request: Request,
  handle: (ctx: Context, request: Request) => Promise<Response>,
) {
  try {
    const ctx = await authenticatedContext(request);
    if (!ctx.actor.isAdmin) throw Object.assign(new Error('관리자만 사용할 수 있어요.'), { status: 403 });
    const response = await handle(ctx, request);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return serverError(error);
  }
}
