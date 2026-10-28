import { adminBatch, requireActiveAdmin } from '../admin/access';
import type { D1Actor, D1Bindings, D1Statement } from './types';
import { boundedDocument, conflict, GRACE_MS, invalid, notFound } from './http';

export interface Context {
  env: D1Bindings;
  actor: D1Actor;
  mutation?: Mutation;
  /** Fresh administrator authorization is required again at the commit/replay boundary. */
  adminWrite?: boolean;
  /** Created only after server authorization; actor remains the administrator. */
  adminProject?: { id: string; ownerId: string; requestId: string };
}
export interface Mutation {
  key: string;
  hash: string;
  resource: string;
}
export interface AssetRow {
  id: string;
  owner_id: string;
  object_key: string;
  source_asset_id: string | null;
  metadata_json: string;
  content_hash: string;
  created_at: string;
  deleting: number;
}
export const sql = (ctx: Context, query: string, ...values: unknown[]) =>
  ctx.env.DB.prepare(query).bind(...values);
export const stamp = () => new Date().toISOString();
export const later = () => new Date(Date.now() + GRACE_MS).toISOString();
/** Data ownership is distinct from the authenticated action author. */
export const dataOwnerId = (ctx: Context) => ctx.adminProject?.ownerId ?? ctx.actor.id;
interface Condition {
  sql: string;
  values: unknown[];
}
/**
 * The administrator project scope may read version `column`: the project's own references, what this
 * administrator made for it, or a current public catalog version. Checked per version, never by
 * building the whole set (a material's current version is always one of its own versions).
 * CROSS JOIN fixes the join order (SQLite keeps it as written): from the one version to its
 * material, never from every public material.
 */
function adminVersionVisible(
  project: NonNullable<Context['adminProject']>,
  actorId: string,
  column: string,
): Condition {
  return {
    sql: `(EXISTS(SELECT 1 FROM d1_project_versions pv WHERE pv.project_id=? AND pv.version_id=${column})
      OR EXISTS(SELECT 1 FROM d1_admin_project_versions av WHERE av.project_id=? AND av.actor_id=? AND av.version_id=${column})
      OR EXISTS(SELECT 1 FROM d1_material_versions cv CROSS JOIN d1_materials cm
        WHERE cv.id=${column} AND cm.id=cv.material_id AND cm.current_version_id=cv.id
        AND cm.scope='shared' AND cm.active=1 AND cm.purpose='catalog' AND json_extract(cv.payload_json,'$.reconstruction') IS NULL))`,
    values: [project.id, project.id, actorId],
  };
}
/** Asset `a` itself is readable, before following derived assets. Joins start from `a`'s references. */
function directlyVisibleAsset(ctx: Context): Condition {
  if (!ctx.adminProject)
    return {
      sql: `(a.owner_id=? OR EXISTS(SELECT 1 FROM d1_material_assets r
        CROSS JOIN d1_material_versions v CROSS JOIN d1_materials m
        WHERE r.asset_id=a.id AND v.id=r.version_id AND m.id=v.material_id AND m.scope='shared'))`,
      values: [ctx.actor.id],
    };
  const version = adminVersionVisible(ctx.adminProject, ctx.actor.id, 'r.version_id');
  return {
    sql: `(EXISTS(SELECT 1 FROM d1_project_assets r WHERE r.project_id=? AND r.asset_id=a.id)
      OR EXISTS(SELECT 1 FROM d1_admin_project_assets r WHERE r.project_id=? AND r.actor_id=? AND r.asset_id=a.id)
      OR EXISTS(SELECT 1 FROM d1_material_assets r WHERE r.asset_id=a.id AND ${version.sql}))`,
    values: [ctx.adminProject.id, ctx.adminProject.id, ctx.actor.id, ...version.values],
  };
}
/**
 * `visible_assets(id)`: the requested ids (a JSON array) that the actor may read. An asset is readable
 * when it, or an asset derived from it (`source_asset_id` chain, none being deleted), is directly
 * visible. The walk starts from the requested ids and stops at the first visible one, so the cost
 * follows the request, not the number of stored assets.
 */
export function visibleAssetsQuery(ctx: Context, refs: string): { cte: string; values: unknown[] } {
  const direct = directlyVisibleAsset(ctx);
  return {
    cte: `WITH RECURSIVE requested(id) AS (SELECT value FROM json_each(?)),
    asset_chain(root,id,ok) AS (
      SELECT a.id,a.id,${direct.sql} FROM requested q JOIN d1_assets a ON a.id=q.id WHERE a.deleting=0
      UNION SELECT c.root,a.id,${direct.sql} FROM asset_chain c JOIN d1_assets a ON a.source_asset_id=c.id
        WHERE c.ok=0 AND a.deleting=0
    ),
    visible_assets(id) AS (SELECT DISTINCT root FROM asset_chain WHERE ok=1)`,
    values: [refs, ...direct.values, ...direct.values],
  };
}
/**
 * `visible_versions(id)`: the requested ids (a JSON array) that the actor may read. The member form
 * stays a plain join so SQLite folds it into each caller's lookup.
 */
export function visibleVersionsQuery(ctx: Context, refs: string): { cte: string; values: unknown[] } {
  if (!ctx.adminProject)
    return {
      cte: `WITH visible_versions(id) AS (SELECT v.id FROM d1_material_versions v CROSS JOIN d1_materials m
        WHERE v.id IN (SELECT value FROM json_each(?)) AND m.id=v.material_id AND (m.owner_id=? OR m.scope='shared'))`,
      values: [refs, ctx.actor.id],
    };
  const version = adminVersionVisible(ctx.adminProject, ctx.actor.id, 'q.value');
  return {
    cte: `WITH visible_versions(id) AS (SELECT DISTINCT q.value FROM json_each(?) q WHERE ${version.sql})`,
    values: [refs, ...version.values],
  };
}
/** Every version the administrator project scope may read; only for listing them. */
export function adminVisibleVersionsSet(project: NonNullable<Context['adminProject']>, actorId: string) {
  return {
    cte: `WITH visible_versions(id) AS (
      SELECT version_id FROM d1_project_versions WHERE project_id=?
      UNION SELECT version_id FROM d1_admin_project_versions WHERE project_id=? AND actor_id=?
      UNION SELECT v.id FROM d1_material_versions v JOIN d1_materials m ON m.current_version_id=v.id
        WHERE m.scope='shared' AND m.active=1 AND m.purpose='catalog' AND json_extract(v.payload_json,'$.reconstruction') IS NULL
    )`,
    values: [project.id, project.id, actorId],
  };
}
export async function readableAsset(ctx: Context, id: string): Promise<AssetRow> {
  const visible = visibleAssetsQuery(ctx, JSON.stringify([id]));
  const row = await sql(
    ctx,
    `${visible.cte} SELECT a.* FROM d1_assets a JOIN visible_assets v ON v.id=a.id WHERE a.id=?`,
    ...visible.values,
    id,
  ).first<AssetRow>();
  if (!row) throw notFound();
  return row;
}
export function referenceJson(ids: string[]): string {
  const text = JSON.stringify([...new Set(ids)]);
  if (ids.length > 10000 || text.length > 512 * 1024)
    throw invalid('연결된 자료가 너무 많아요. 프로젝트를 나눠 주세요.');
  return text;
}
/** Batch assertion: named CHECK constraints distinguish conflicts from forbidden references. */
export function assertion(
  ctx: Context,
  kind: 'conflict' | 'reference',
  expression: string,
  ...values: unknown[]
): D1Statement {
  return sql(
    ctx,
    `INSERT INTO d1_checks(id,${kind}_ok) SELECT ?,CASE WHEN (${expression}) THEN 1 ELSE 0 END`,
    crypto.randomUUID(),
    ...values,
  );
}
export function assetAssertion(ctx: Context, refs: string): D1Statement {
  const visible = visibleAssetsQuery(ctx, refs);
  return assertion(
    ctx,
    'reference',
    `${visible.cte} SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(SELECT 1 FROM visible_assets a WHERE a.id=r.value))`,
    ...visible.values,
    refs,
  );
}
export function versionAssertion(ctx: Context, refs: string): D1Statement {
  const visible = visibleVersionsQuery(ctx, refs);
  return assertion(
    ctx,
    'reference',
    `${visible.cte} SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(SELECT 1 FROM visible_versions v WHERE v.id=r.value))`,
    ...visible.values,
    refs,
  );
}
export async function batch(ctx: Context, statements: D1Statement[]): Promise<void> {
  // Checks only live inside this atomic D1 transaction. D1 serializes concurrent batches.
  const guarded = [...statements, sql(ctx, 'DELETE FROM d1_checks')];
  if (ctx.adminProject) {
    guarded.unshift(
      assertion(
        ctx,
        'reference',
        'EXISTS(SELECT 1 FROM d1_projects WHERE id=? AND owner_id=?)',
        ctx.adminProject.id,
        ctx.adminProject.ownerId,
      ),
    );
    await adminBatch(ctx, guarded);
  } else if (ctx.adminWrite) await adminBatch(ctx, guarded);
  else await ctx.env.DB.batch(guarded);
}
export function queueObject(ctx: Context, key: string, assetId: string | null = null): D1Statement {
  const due = later();
  return sql(
    ctx,
    `INSERT OR IGNORE INTO d1_cleanup_jobs(object_key,owner_id,asset_id,eligible_at,next_attempt_at)
    VALUES(?,?,?,?,?)`,
    key,
    dataOwnerId(ctx),
    assetId,
    due,
    due,
  );
}
export async function stageObject(
  ctx: Context,
  key: string,
  value: string | Uint8Array,
  contentType: string,
  assetId: string | null = null,
): Promise<void> {
  // A crash or failed D1 commit leaves a durable cleanup record before any upload exists.
  await queueObject(ctx, key, assetId).run();
  await ctx.env.ASSET_BUCKET.put(key, value, {
    httpMetadata: { contentType, cacheControl: 'private, no-store' },
  });
}
export function committedObject(ctx: Context, key: string): D1Statement {
  return sql(ctx, 'DELETE FROM d1_cleanup_jobs WHERE object_key=?', key);
}
export async function readDocument<T>(ctx: Context, key: string): Promise<T> {
  const object = await ctx.env.ASSET_BUCKET.get(key);
  if (!object) throw new Error('Committed document is missing');
  return JSON.parse(await object.text()) as T;
}
export function mutationStatement(
  ctx: Context,
  response: { key: string } | { value: unknown },
): D1Statement[] {
  if (!ctx.mutation) return [];
  return [
    sql(
      ctx,
      `INSERT INTO d1_mutations(owner_id,request_key,resource,request_hash,response_key,response_json,created_at)
    VALUES(?,?,?,?,?,?,?)`,
      ctx.actor.id,
      ctx.mutation.key,
      ctx.mutation.resource,
      ctx.mutation.hash,
      'key' in response ? response.key : null,
      'value' in response ? boundedDocument(response.value) : null,
      stamp(),
    ),
  ];
}
export async function replay(ctx: Context): Promise<{ value: unknown } | null> {
  if (!ctx.mutation) return null;
  if (ctx.adminWrite || ctx.adminProject) await requireActiveAdmin(ctx);
  const row = await sql(
    ctx,
    'SELECT * FROM d1_mutations WHERE owner_id=? AND request_key=?',
    ctx.actor.id,
    ctx.mutation.key,
  ).first<{
    resource: string;
    request_hash: string;
    response_key: string | null;
    response_json: string | null;
  }>();
  if (!row) return null;
  if (row.request_hash !== ctx.mutation.hash || row.resource !== ctx.mutation.resource) throw conflict();
  const value = row.response_key ? await readDocument(ctx, row.response_key) : JSON.parse(row.response_json!);
  if (ctx.adminWrite || ctx.adminProject) await requireActiveAdmin(ctx);
  return { value };
}
export async function checkD1Storage(env: D1Bindings): Promise<void> {
  if (!env?.DB?.prepare || !env?.ASSET_BUCKET?.head) throw new Error('D1/R2 bindings are missing');
  const names = [
    'd1_admin_meta',
    'd1_user_management',
    'd1_admin_audit',
    'd1_admin_checks',
    'd1_admin_project_assets',
    'd1_admin_project_versions',
    'd1_catalog_meta',
    'd1_catalog_options',
    'd1_material_subcategories',
    // 0012: the 위생도기 kinds an administrator manages.
    'd1_material_kinds',
    'd1_material_version_options',
    'd1_storage_meta',
    'd1_projects',
    'd1_assets',
    'd1_materials',
    'd1_material_versions',
    'd1_project_assets',
    'd1_project_versions',
    'd1_material_assets',
    'd1_material_list',
    'd1_material_list_facets',
    'd1_material_list_counts',
    'd1_cleanup_jobs',
    'd1_mutations',
    'd1_checks',
    'd1_maintenance',
  ];
  // 0010–0011: the list orders read these indexes by name (INDEXED BY) and these triggers keep them
  // right (a brand's 표시 순서 is its materials' priority).
  const ordered = [
    ...['lane', 'category', 'all', 'personal', 'facet'].flatMap((part) =>
      ['prio', 'name', 'new'].map((family) => `d1_list_${part}_${family}`),
    ),
    'd1_material_list_priority',
    'd1_material_list_created',
    'd1_material_list_brand_link',
    'd1_material_list_brand_unlink',
    'd1_material_list_brand_order',
    // 0012: an added 위생도기 kind's versions (checked before the kind is deleted).
    'd1_versions_added_kind',
  ];
  const rows = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')",
  ).all<{
    name: string;
  }>();
  const present = new Set(rows.results.map((row) => row.name));
  if ([...names, ...ordered].some((name) => !present.has(name)))
    throw new Error('D1 storage migrations are incomplete');
  const adminVersion = await env.DB.prepare('SELECT version FROM d1_admin_meta WHERE id=1').first<{
    version: number;
  }>();
  if (adminVersion?.version !== 1) throw new Error('Unsupported admin schema');
  const version = await env.DB.prepare('SELECT version FROM d1_storage_meta').first<{ version: number }>();
  if (version?.version !== 1) throw new Error('Unsupported D1 storage schema');
  const catalogVersion = await env.DB.prepare('SELECT version FROM d1_catalog_meta WHERE id=1').first<{
    version: number;
  }>();
  if (catalogVersion?.version !== 1) throw new Error('Unsupported catalog schema');
  await env.DB.batch([
    env.DB.prepare('SELECT user_id,status,revision,updated_at FROM d1_user_management LIMIT 0'),
    env.DB.prepare(
      'SELECT id,actor_id,action,target_user_id,project_id,project_revision,before_json,after_json,reason,request_id,created_at FROM d1_admin_audit LIMIT 0',
    ),
    env.DB.prepare(
      'SELECT id,access_ok,target_ok,revision_ok,last_admin_ok,self_ok FROM d1_admin_checks LIMIT 0',
    ),
    env.DB.prepare('SELECT project_id,asset_id,actor_id,created_at FROM d1_admin_project_assets LIMIT 0'),
    env.DB.prepare('SELECT project_id,version_id,actor_id,created_at FROM d1_admin_project_versions LIMIT 0'),
    env.DB.prepare(
      'SELECT id,owner_id,storage_revision,object_key,summary_json,byte_size FROM d1_projects LIMIT 0',
    ),
    env.DB.prepare(
      'SELECT id,owner_id,object_key,source_asset_id,metadata_json,content_hash,deleting FROM d1_assets LIMIT 0',
    ),
    env.DB.prepare('SELECT id,owner_id,scope,current_version_id,active FROM d1_materials LIMIT 0'),
    // 0011: 표시 순서 (empty for none).
    env.DB.prepare('SELECT id,kind,display_order FROM d1_catalog_options LIMIT 0'),
    env.DB.prepare('SELECT id,category_code,display_order FROM d1_material_subcategories LIMIT 0'),
    env.DB.prepare(
      'SELECT id,material_id,version,payload_json,category,view_count FROM d1_material_versions LIMIT 0',
    ),
    env.DB.prepare('SELECT project_id,asset_id FROM d1_project_assets LIMIT 0'),
    env.DB.prepare('SELECT project_id,version_id FROM d1_project_versions LIMIT 0'),
    env.DB.prepare('SELECT version_id,asset_id FROM d1_material_assets LIMIT 0'),
    // 0009 and 0010: the paged lists read these (no meta version: the migrations only add).
    env.DB.prepare(
      'SELECT version_id,material_id,owner_id,scope,purpose,active,updated_at,is_current,lane,category,code,class,search_catalog,search_picker,search_library,prio,name_key,created_at FROM d1_material_list LIMIT 0',
    ),
    env.DB.prepare(
      'SELECT version_id,facet,value,material_id,scope,active,is_current,updated_at,lane,category,class,prio,name_key,created_at FROM d1_material_list_facets LIMIT 0',
    ),
    env.DB.prepare('SELECT active,lane,category,class,facet,value,n FROM d1_material_list_counts LIMIT 0'),
    env.DB.prepare(
      'SELECT object_key,owner_id,asset_id,eligible_at,attempts,lease_token,lease_until,next_attempt_at FROM d1_cleanup_jobs LIMIT 0',
    ),
    env.DB.prepare(
      'SELECT owner_id,request_key,resource,request_hash,response_key,response_json,created_at FROM d1_mutations LIMIT 0',
    ),
    env.DB.prepare('SELECT id,conflict_ok,reference_ok FROM d1_checks LIMIT 0'),
    env.DB.prepare('SELECT owner_id,next_run_at FROM d1_maintenance LIMIT 0'),
  ]);
  // Missing sentinel is fine; a successful HEAD proves the bucket can be reached without writes.
  await env.ASSET_BUCKET.head('__sjn_readiness__');
}

/** Read-only preflight; committing batches still perform the same assertions atomically. */
export async function validateReferences(ctx: Context, assetIds: string, versionIds: string): Promise<void> {
  const assetsVisible = visibleAssetsQuery(ctx, assetIds),
    versionsVisible = visibleVersionsQuery(ctx, versionIds);
  const assets = await sql(
    ctx,
    `${assetsVisible.cte} SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(SELECT 1 FROM visible_assets a WHERE a.id=r.value)) AS valid`,
    ...assetsVisible.values,
    assetIds,
  ).first<{ valid: number }>();
  const versions = await sql(
    ctx,
    `${versionsVisible.cte} SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(SELECT 1 FROM visible_versions v WHERE v.id=r.value)) AS valid`,
    ...versionsVisible.values,
    versionIds,
  ).first<{ valid: number }>();
  if (!assets?.valid || !versions?.valid) throw invalid();
}
