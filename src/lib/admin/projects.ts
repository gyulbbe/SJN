import { z } from 'zod';
import type { AdminPage, AdminProjectDetail, AdminProjectSummary } from './contracts';
import { requireActiveAdmin, adminBatch, adminAuditStatement, adminErrorResponse } from './access';
import { batch, readDocument, replay, sql, type Context } from '../d1/database';
import { assets } from '../d1/assets';
import { materials } from '../d1/materials';
import { projects } from '../d1/projects';
import { bodyJson, boundedDocument, D1StorageError, hash, invalid, json, notFound } from '../d1/http';
import { identifierSchema } from '../storage/validation';
import type { ProjectDocument } from '../types';

interface AdminProjectRow {
  id: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  name: string;
  created_at: string;
  updated_at: string;
  storage_revision: number;
  object_key: string;
}
const methods = () => new D1StorageError(405, '지원하지 않는 요청 방식이에요.', 'METHOD_NOT_ALLOWED');
async function scoped(ctx: Context, projectId: unknown) {
  const id = identifierSchema.parse(projectId);
  const row = await sql(
    ctx,
    `SELECT p.*,u.name AS owner_name,u.email AS owner_email
    FROM d1_projects p JOIN "user" u ON u.id=p.owner_id WHERE p.id=?`,
    id,
  ).first<AdminProjectRow>();
  if (!row) throw notFound();
  return {
    row,
    ctx: {
      ...ctx,
      adminProject: { id, ownerId: row.owner_id, requestId: crypto.randomUUID() },
    } satisfies Context,
  };
}
async function recordRead(ctx: Context, action: string, projectRevision?: number) {
  await batch(ctx, [
    adminAuditStatement(ctx, {
      action,
      targetUserId: ctx.adminProject!.ownerId,
      projectId: ctx.adminProject!.id,
      projectRevision,
      requestId: ctx.adminProject!.requestId,
    }),
  ]);
}
async function mutate(
  ctx: Context,
  request: Request,
  body: Record<string, unknown>,
  resource: string,
  run: () => Promise<unknown>,
) {
  const requestHash = await hash(boundedDocument(body));
  const supplied = request.headers.get('X-Idempotency-Key');
  if (supplied !== null && !/^[A-Za-z0-9._:-]{1,200}$/.test(supplied))
    throw invalid('저장 요청 식별자를 확인해 주세요.');
  ctx.mutation = {
    key: supplied ?? `${resource}:${requestHash}`,
    hash: requestHash,
    resource: `${resource}:${ctx.adminProject!.id}`,
  };
  try {
    const previous = await replay(ctx);
    if (previous) {
      await requireActiveAdmin(ctx);
      return json(previous.value);
    }
    return json(await run());
  } catch (error) {
    // The action author owns retry records. Never impersonate the project owner to replay writes.
    await requireActiveAdmin(ctx);
    const previous = await replay(ctx);
    if (previous) return json(previous.value);
    throw error;
  }
}
function listCursor(value: string | null): { updatedAt: string; id: string } | undefined {
  if (!value) return;
  if (value.length > 500) throw invalid('목록 위치를 확인해 주세요.');
  try {
    return z
      .object({ updatedAt: z.string().datetime(), id: identifierSchema })
      .parse(JSON.parse(atob(value)));
  } catch {
    throw invalid('목록 위치를 확인해 주세요.');
  }
}
export async function adminProjects(ctx: Context, request: Request): Promise<Response> {
  try {
    await requireActiveAdmin(ctx);
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const query = z
        .string()
        .trim()
        .max(200)
        .parse(url.searchParams.get('q') ?? '');
      const ownerId = z
        .string()
        .max(200)
        .parse(url.searchParams.get('ownerId') ?? '');
      const cursor = listCursor(url.searchParams.get('cursor'));
      const clauses: string[] = [],
        values: unknown[] = [];
      if (query) {
        clauses.push(
          '(instr(lower(p.name),lower(?))>0 OR instr(lower(u.name),lower(?))>0 OR instr(lower(u.email),lower(?))>0)',
        );
        values.push(query, query, query);
      }
      if (ownerId) {
        clauses.push('p.owner_id=?');
        values.push(ownerId);
      }
      if (cursor) {
        clauses.push('(p.updated_at<? OR (p.updated_at=? AND p.id>?))');
        values.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
      }
      const rows = await sql(
        ctx,
        `SELECT p.*,u.name AS owner_name,u.email AS owner_email
        FROM d1_projects p JOIN "user" u ON u.id=p.owner_id ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
        ORDER BY p.updated_at DESC,p.id ASC LIMIT 26`,
        ...values,
      ).all<AdminProjectRow>();
      const shown = rows.results.slice(0, 25),
        last = shown.at(-1);
      const result: AdminPage<AdminProjectSummary> = {
        items: shown.map((row) => ({
          id: row.id,
          name: row.name,
          ownerId: row.owner_id,
          ownerName: row.owner_name,
          ownerEmail: row.owner_email,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          storageRevision: row.storage_revision,
        })),
        nextCursor:
          rows.results.length > 25 && last
            ? btoa(JSON.stringify({ updatedAt: last.updated_at, id: last.id }))
            : null,
      };
      await adminBatch(ctx, [
        adminAuditStatement(ctx, {
          action: 'project.list',
          requestId: crypto.randomUUID(),
          after: { count: shown.length },
        }),
      ]);
      return json(result);
    }
    if (request.method !== 'POST') throw methods();
    const body = await bodyJson(request);
    if (!['load', 'save'].includes(String(body.operation)))
      throw invalid('관리자 편집에서는 불러오기와 저장만 할 수 있어요.');
    const id = body.id ?? (body.document as { id?: unknown } | undefined)?.id;
    const scope = await scoped(ctx, id);
    if (body.operation === 'load') {
      const document = await readDocument<ProjectDocument>(scope.ctx, scope.row.object_key);
      await recordRead(scope.ctx, 'project.load', scope.row.storage_revision);
      const result: AdminProjectDetail = {
        document,
        owner: { id: scope.row.owner_id, name: scope.row.owner_name, email: scope.row.owner_email },
      };
      return json(result);
    }
    if (!body.document || (body.document as { id?: unknown }).id !== scope.row.id)
      throw invalid('편집 중인 프로젝트를 확인해 주세요.');
    return await mutate(scope.ctx, request, body, 'admin-projects', () => projects(scope.ctx, body));
  } catch (error) {
    return adminErrorResponse(error);
  }
}
export async function adminProjectAssets(ctx: Context, request: Request): Promise<Response> {
  try {
    await requireActiveAdmin(ctx);
    if (!['GET', 'POST'].includes(request.method)) throw methods();
    const scope = await scoped(ctx, new URL(request.url).searchParams.get('projectId'));
    const result = await assets(scope.ctx, request);
    // Duplicate uploads can return without a commit; recheck the current role for that path too.
    if (request.method === 'POST') await requireActiveAdmin(scope.ctx);
    if (request.method === 'GET')
      await recordRead(scope.ctx, 'project.asset.read', scope.row.storage_revision);
    return result;
  } catch (error) {
    return adminErrorResponse(error);
  }
}
export async function adminProjectMaterials(ctx: Context, request: Request): Promise<Response> {
  try {
    await requireActiveAdmin(ctx);
    if (request.method !== 'POST') throw methods();
    const body = await bodyJson(request);
    if (!['list', 'getVersion', 'create'].includes(String(body.operation)))
      throw invalid('프로젝트 자재는 조회 또는 새 모형 생성만 할 수 있어요.');
    const scope = await scoped(ctx, body.projectId);
    if (body.operation === 'create')
      return await mutate(scope.ctx, request, body, 'admin-project-materials', () =>
        materials(scope.ctx, body, true),
      );
    const result = await materials(scope.ctx, body, false);
    await recordRead(scope.ctx, 'project.material.read', scope.row.storage_revision);
    return json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
