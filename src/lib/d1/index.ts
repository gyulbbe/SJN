import { manageCatalog } from '../catalog/server';
import { assets } from './assets';
import { cleanup } from './cleanup';
import { replay, type Context } from './database';
import { bodyJson, boundedDocument, D1StorageError, errorResponse, hash, invalid, json } from './http';
import { materials } from './materials';
import { projects } from './projects';
import type { D1Actor, D1Bindings, D1Resource } from './types';

export { checkD1Storage } from './database';
export { runD1Maintenance } from './cleanup';
export { D1StorageError } from './http';
export type { D1Actor, D1Bindings, D1Resource } from './types';

function mutationResponse(value: unknown): Response {
  const response = json(value);
  response.headers.set('X-SJN-Mutation', '1');
  return response;
}

/** Actor must come from the verified server session, never request JSON or headers. */
export async function handleD1Request(
  resource: D1Resource,
  request: Request,
  env: D1Bindings,
  actor: D1Actor,
): Promise<Response> {
  const ctx: Context = { env, actor };
  try {
    if (!actor?.id) throw new D1StorageError(401, '로그인이 필요해요.', 'UNAUTHENTICATED');
    const origin = request.headers.get('origin');
    if (request.method !== 'GET' && origin && origin !== new URL(request.url).origin)
      throw new D1StorageError(403, '허용되지 않은 요청 출처예요.', 'FORBIDDEN');
    if (resource === 'role') {
      if (request.method !== 'GET') throw new D1StorageError(405, '지원하지 않는 요청 방식이에요.');
      return json({ isAdmin: actor.isAdmin });
    }
    if (resource === 'assets') {
      const response = await assets(ctx, request);
      if (request.method === 'POST' && response.ok) response.headers.set('X-SJN-Mutation', '1');
      return response;
    }
    if (request.method !== 'POST')
      throw new D1StorageError(405, '지원하지 않는 요청 방식이에요.', 'METHOD_NOT_ALLOWED');
    const body = await bodyJson(request);
    const operation = body.operation;
    if (
      (resource === 'catalog' ||
        (resource === 'materials' && !['list', 'getVersion'].includes(String(operation)))) &&
      !actor.isAdmin
    )
      throw new D1StorageError(403, '자재와 분류는 관리자만 변경할 수 있어요.', 'FORBIDDEN');
    if (resource === 'project-materials' && operation !== 'create')
      throw invalid('프로젝트 모형은 새로 생성만 할 수 있어요.');
    const mutating =
      typeof operation === 'string' &&
      ['create', 'save', 'duplicate', 'remove', 'update', 'setActive'].includes(operation);
    if (mutating) {
      const requestHash = await hash(boundedDocument(body));
      const supplied = request.headers.get('X-Idempotency-Key');
      if (supplied !== null && !/^[A-Za-z0-9._:-]{1,200}$/.test(supplied))
        throw invalid('저장 요청 식별자를 확인해 주세요.');
      // Only inherently identified writes get a default retry key. Repeating an identical
      // setActive/create/duplicate operation may be a new user action after intervening edits.
      if (supplied || (resource === 'projects' && ['create', 'save'].includes(operation))) {
        ctx.mutation = { key: supplied ?? `${resource}:${requestHash}`, hash: requestHash, resource };
        const previous = await replay(ctx);
        if (previous) return mutationResponse(previous.value);
      }
    }
    const result =
      resource === 'projects'
        ? await projects(ctx, body)
        : resource === 'catalog'
          ? await manageCatalog(ctx, body)
          : resource === 'project-materials'
            ? await materials(ctx, body, true)
            : resource === 'materials'
              ? await materials(ctx, body)
              : await cleanup(ctx, body);
    return mutating ? mutationResponse(result) : json(result);
  } catch (error) {
    // An uncertain response or simultaneous retry can lose the mutation UNIQUE race.
    // Return the committed result only when both the owner and complete request hash agree.
    if (ctx.mutation) {
      try {
        const previous = await replay(ctx);
        if (previous) return mutationResponse(previous.value);
      } catch (replayError) {
        return errorResponse(replayError);
      }
    }
    return errorResponse(error);
  }
}
