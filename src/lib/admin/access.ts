import type { Context } from '../d1/database';
import type { D1Statement } from '../d1/types';
import { D1StorageError, errorResponse, invalid, notFound } from '../d1/http';

const sql = (ctx: Context, query: string, ...values: unknown[]) => ctx.env.DB.prepare(query).bind(...values);
const denied = () => new D1StorageError(403, '현재 관리자 권한이 없어요.', 'ADMIN_REQUIRED');
const activeAdmin =
  "EXISTS(SELECT 1 FROM admin_roles r JOIN d1_user_management s ON s.user_id=r.user_id WHERE r.user_id=? AND s.status='active')";

/** Never rely on a role cached in a cookie or in the earlier route lookup. */
export async function requireActiveAdmin(ctx: Context): Promise<void> {
  if (!ctx.actor.id) throw new D1StorageError(401, '로그인이 필요해요.', 'AUTHENTICATION_REQUIRED');
  const row = await sql(ctx, 'SELECT ' + activeAdmin + ' AS allowed', ctx.actor.id).first<{
    allowed: number;
  }>();
  if (!row?.allowed) throw denied();
}
export function adminAssertion(
  ctx: Context,
  kind: 'access' | 'target' | 'revision' | 'last_admin' | 'self',
  expression: string,
  ...values: unknown[]
): D1Statement {
  return sql(
    ctx,
    'INSERT INTO d1_admin_checks(id,' +
      kind +
      '_ok) SELECT ?,CASE WHEN (' +
      expression +
      ') THEN 1 ELSE 0 END',
    crypto.randomUUID(),
    ...values,
  );
}
export function activeAdminAssertion(ctx: Context): D1Statement {
  return adminAssertion(ctx, 'access', activeAdmin, ctx.actor.id);
}
export interface AdminAuditEntry {
  action: string;
  targetUserId?: string;
  projectId?: string;
  projectRevision?: number;
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId: string;
}
/** Callers pass a small allowlisted summary, never a document, token or storage key. */
export function adminAuditStatement(ctx: Context, entry: AdminAuditEntry): D1Statement {
  if (
    !/^[a-z][a-z0-9_.-]{0,79}$/.test(entry.action) ||
    !entry.requestId ||
    entry.requestId.length > 200 ||
    (entry.reason?.length ?? 0) > 500
  )
    throw invalid();
  const encode = (value: unknown) => {
    if (value === undefined) return null;
    const text = JSON.stringify(value);
    if (!text || new TextEncoder().encode(text).length > 4096) throw invalid();
    return text;
  };
  return sql(
    ctx,
    `INSERT INTO d1_admin_audit(id,actor_id,action,target_user_id,project_id,project_revision,before_json,after_json,reason,request_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    crypto.randomUUID(),
    ctx.actor.id,
    entry.action,
    entry.targetUserId ?? null,
    entry.projectId ?? null,
    entry.projectRevision ?? null,
    encode(entry.before),
    encode(entry.after),
    entry.reason ?? null,
    entry.requestId,
    new Date().toISOString(),
  );
}
export function adminError(error: unknown): unknown {
  const detail = error instanceof Error ? error.message : '';
  if (/d1_admin_access/.test(detail)) return denied();
  if (/d1_admin_target/.test(detail)) return notFound();
  if (/d1_admin_revision/.test(detail))
    return new D1StorageError(
      409,
      '회원 정보가 변경됐어요. 새로 조회한 뒤 다시 시도해 주세요.',
      'REVISION_CONFLICT',
    );
  if (/d1_admin_last/.test(detail))
    return new D1StorageError(409, '마지막 활성 관리자는 해제하거나 정지할 수 없어요.', 'LAST_ACTIVE_ADMIN');
  if (/d1_admin_self/.test(detail))
    return new D1StorageError(400, '자신의 계정은 정지할 수 없어요.', 'SELF_SUSPENSION');
  return error;
}
export const adminErrorResponse = (error: unknown) => errorResponse(adminError(error));
/** Authorization and audit commit with the protected operation, including concurrent demotions. */
export async function adminBatch(ctx: Context, statements: D1Statement[]): Promise<void> {
  try {
    await ctx.env.DB.batch([
      activeAdminAssertion(ctx),
      ...statements,
      sql(ctx, 'DELETE FROM d1_admin_checks'),
    ]);
  } catch (error) {
    throw adminError(error);
  }
}
