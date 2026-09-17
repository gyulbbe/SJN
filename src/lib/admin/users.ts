import { z } from 'zod';
import type { AdminPage, AdminUser, UserStatus } from './contracts';
import {
  adminAssertion,
  adminAuditStatement,
  adminBatch,
  adminErrorResponse,
  requireActiveAdmin,
} from './access';
import { mutationStatement, replay, sql, stamp, type Context } from '../d1/database';
import { boundedBytes, D1StorageError, hash, invalid, json, notFound } from '../d1/http';
import type { D1Actor, D1Bindings } from '../d1/types';

const inputBase = {
  userId: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().max(500).optional(),
};
const mutationSchema = z.discriminatedUnion('operation', [
  z.object({ ...inputBase, operation: z.literal('setRole'), role: z.enum(['admin', 'member']) }).strict(),
  z
    .object({ ...inputBase, operation: z.literal('setStatus'), status: z.enum(['active', 'suspended']) })
    .strict(),
]);
const pageSchema = z.object({
  q: z.string().trim().max(200).default(''),
  role: z.enum(['all', 'admin', 'member']).default('all'),
  status: z.enum(['all', 'active', 'suspended']).default('all'),
});
const cursorSchema = pageSchema
  .extend({ createdAt: z.string().min(1).max(100), id: z.string().uuid() })
  .strict();
type UserRow = Omit<AdminUser, 'isAdmin' | 'emailVerified'> & { isAdmin: number; emailVerified: number };
const selection = `SELECT u.id,u.name,u.email,u.emailVerified,u.createdAt,s.status,s.revision,
  EXISTS(SELECT 1 FROM admin_roles ar WHERE ar.user_id=u.id) AS isAdmin,
  (SELECT COUNT(*) FROM d1_projects p WHERE p.owner_id=u.id) AS projectCount
  FROM "user" u JOIN d1_user_management s ON s.user_id=u.id`;
const userDto = (row: UserRow): AdminUser => ({
  ...row,
  isAdmin: !!row.isAdmin,
  emailVerified: !!row.emailVerified,
});
const encodeCursor = (value: unknown) =>
  btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), (c) => String.fromCharCode(c)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
function decodeCursor(text: string) {
  if (text.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalid();
  try {
    return cursorSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
        ),
      ),
    );
  } catch {
    throw invalid();
  }
}
async function listUsers(ctx: Context, request: Request): Promise<AdminPage<AdminUser>> {
  const params = new URL(request.url).searchParams;
  const filters = pageSchema.parse({
    q: params.get('q') ?? '',
    role: params.get('role') || 'all',
    status: params.get('status') || 'all',
  });
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.q) {
    where.push(
      '(instr(lower(u.name),lower(?))>0 OR instr(lower(u.email),lower(?))>0 OR instr(lower(u.id),lower(?))>0)',
    );
    const pattern = filters.q;
    values.push(pattern, pattern, pattern);
  }
  if (filters.role !== 'all') {
    where.push('EXISTS(SELECT 1 FROM admin_roles ar WHERE ar.user_id=u.id)=?');
    values.push(filters.role === 'admin' ? 1 : 0);
  }
  if (filters.status !== 'all') {
    where.push('s.status=?');
    values.push(filters.status);
  }
  if (params.has('cursor')) {
    const cursor = decodeCursor(params.get('cursor')!);
    if (cursor.q !== filters.q || cursor.role !== filters.role || cursor.status !== filters.status)
      throw invalid();
    where.push('(u.createdAt<? OR (u.createdAt=? AND u.id<?))');
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const result = await sql(
    ctx,
    selection +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY u.createdAt DESC,u.id DESC LIMIT 26',
    ...values,
  ).all<UserRow>();
  const items = result.results.slice(0, 25).map(userDto);
  const last = items.at(-1);
  const nextCursor =
    result.results.length > 25 && last
      ? encodeCursor({ ...filters, createdAt: last.createdAt, id: last.id })
      : null;
  await adminBatch(ctx, [
    adminAuditStatement(ctx, {
      action: 'user.list',
      requestId: crypto.randomUUID(),
      after: { count: items.length },
    }),
  ]);
  return { items, nextCursor };
}
async function changeUser(ctx: Context, request: Request) {
  const key = request.headers.get('x-idempotency-key');
  if (!key || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw invalid('변경 요청 식별자가 필요해요.');
  const input = mutationSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(request, 16 * 1024))),
  );
  ctx.mutation = { key, resource: 'admin-users', hash: await hash(JSON.stringify(input)) };
  const prior = await replay(ctx);
  if (prior) {
    await requireActiveAdmin(ctx);
    return prior.value;
  }
  const row = await sql(ctx, selection + ' WHERE u.id=?', input.userId).first<UserRow>();
  if (!row) throw notFound();
  const before = userDto(row);
  const nextAdmin = input.operation === 'setRole' ? input.role === 'admin' : before.isAdmin;
  const nextStatus: UserStatus = input.operation === 'setStatus' ? input.status : before.status;
  const changed = nextAdmin !== before.isAdmin || nextStatus !== before.status;
  const after: AdminUser = {
    ...before,
    isAdmin: nextAdmin,
    status: nextStatus,
    revision: before.revision + (changed ? 1 : 0),
  };
  const result = { user: after };
  const statements = [
    adminAssertion(ctx, 'target', 'EXISTS(SELECT 1 FROM d1_user_management WHERE user_id=?)', input.userId),
    adminAssertion(
      ctx,
      'revision',
      'EXISTS(SELECT 1 FROM d1_user_management WHERE user_id=? AND revision=?)',
      input.userId,
      input.expectedRevision,
    ),
    adminAssertion(ctx, 'self', '?!=? OR ?!=?', input.userId, ctx.actor.id, nextStatus, 'suspended'),
    adminAssertion(
      ctx,
      'last_admin',
      `NOT EXISTS(SELECT 1 FROM admin_roles r JOIN d1_user_management s ON s.user_id=r.user_id WHERE r.user_id=? AND s.status='active')
      OR (?=1 AND ?='active') OR (SELECT COUNT(*) FROM admin_roles r JOIN d1_user_management s ON s.user_id=r.user_id WHERE s.status='active')>1`,
      input.userId,
      Number(nextAdmin),
      nextStatus,
    ),
  ];
  if (changed) {
    if (input.operation === 'setRole')
      statements.push(
        nextAdmin
          ? sql(ctx, 'INSERT INTO admin_roles(user_id,created_at) VALUES(?,?)', input.userId, stamp())
          : sql(ctx, 'DELETE FROM admin_roles WHERE user_id=?', input.userId),
      );
    statements.push(
      sql(
        ctx,
        'UPDATE d1_user_management SET status=?,revision=revision+1,updated_at=? WHERE user_id=?',
        nextStatus,
        stamp(),
        input.userId,
      ),
    );
  }
  // The migration trigger also covers concurrent callbacks and out-of-band status updates.
  if (nextStatus === 'suspended')
    statements.push(sql(ctx, 'DELETE FROM "session" WHERE userId=?', input.userId));
  const state = (user: AdminUser) => ({
    isAdmin: user.isAdmin,
    status: user.status,
    revision: user.revision,
  });
  statements.push(
    adminAuditStatement(ctx, {
      action: input.operation === 'setRole' ? 'user.role' : 'user.status',
      targetUserId: input.userId,
      before: state(before),
      after: state(after),
      reason: input.reason,
      requestId: key,
    }),
    ...mutationStatement(ctx, { value: result }),
  );
  try {
    await adminBatch(ctx, statements);
    return result;
  } catch (error) {
    // Concurrent delivery of the same request may already have committed. Recheck
    // authorization first so a retry cannot reveal data after role revocation.
    await requireActiveAdmin(ctx);
    const committed = await replay(ctx);
    if (committed) return committed.value;
    throw error;
  }
}
export async function handleAdminUsers(
  request: Request,
  env: D1Bindings,
  actor: D1Actor | null,
): Promise<Response> {
  try {
    const ctx: Context = { env, actor: actor ?? { id: '', isAdmin: false } };
    await requireActiveAdmin(ctx);
    if (request.method === 'GET') return json(await listUsers(ctx, request));
    if (request.method !== 'POST')
      return json({ error: '허용되지 않은 요청 방식이에요.', code: 'METHOD_NOT_ALLOWED' }, 405);
    if (
      request.headers.get('origin') !== new URL(request.url).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      throw new D1StorageError(403, '허용되지 않은 요청 출처예요.', 'ORIGIN_NOT_ALLOWED');
    return json(await changeUser(ctx, request));
  } catch (error) {
    return adminErrorResponse(error);
  }
}
