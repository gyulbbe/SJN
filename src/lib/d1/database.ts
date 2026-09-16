import type { D1Actor, D1Bindings, D1Statement } from './types';
import { boundedDocument, conflict, GRACE_MS, invalid, notFound } from './http';

export interface Context {
  env: D1Bindings;
  actor: D1Actor;
  mutation?: Mutation;
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
export const visibleAssets = `WITH RECURSIVE visible_assets(id,source_asset_id) AS (
  SELECT a.id,a.source_asset_id FROM d1_assets a WHERE a.deleting=0 AND (
    a.owner_id=? OR EXISTS(SELECT 1 FROM d1_material_assets r
      JOIN d1_material_versions v ON v.id=r.version_id JOIN d1_materials m ON m.id=v.material_id
      WHERE r.asset_id=a.id AND m.scope='shared'))
  UNION SELECT a.id,a.source_asset_id FROM d1_assets a JOIN visible_assets p ON p.source_asset_id=a.id WHERE a.deleting=0
)`;
export async function readableAsset(ctx: Context, id: string): Promise<AssetRow> {
  const row = await sql(
    ctx,
    `${visibleAssets} SELECT a.* FROM d1_assets a JOIN visible_assets v ON v.id=a.id WHERE a.id=?`,
    ctx.actor.id,
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
  return assertion(
    ctx,
    'reference',
    `${visibleAssets} SELECT NOT EXISTS(
    SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(SELECT 1 FROM visible_assets a WHERE a.id=r.value))`,
    ctx.actor.id,
    refs,
  );
}
export function versionAssertion(ctx: Context, refs: string): D1Statement {
  return assertion(
    ctx,
    'reference',
    `SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(
    SELECT 1 FROM d1_material_versions v JOIN d1_materials m ON m.id=v.material_id
    WHERE v.id=r.value AND (m.owner_id=? OR m.scope='shared')))`,
    refs,
    ctx.actor.id,
  );
}
export async function batch(ctx: Context, statements: D1Statement[]): Promise<void> {
  // Checks only live inside this atomic D1 transaction. D1 serializes concurrent batches.
  await ctx.env.DB.batch([...statements, sql(ctx, 'DELETE FROM d1_checks')]);
}
export function queueObject(ctx: Context, key: string, assetId: string | null = null): D1Statement {
  const due = later();
  return sql(
    ctx,
    `INSERT OR IGNORE INTO d1_cleanup_jobs(object_key,owner_id,asset_id,eligible_at,next_attempt_at)
    VALUES(?,?,?,?,?)`,
    key,
    ctx.actor.id,
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
  return {
    value: row.response_key ? await readDocument(ctx, row.response_key) : JSON.parse(row.response_json!),
  };
}
export async function checkD1Storage(env: D1Bindings): Promise<void> {
  if (!env?.DB?.prepare || !env?.ASSET_BUCKET?.head) throw new Error('D1/R2 bindings are missing');
  const names = [
    'd1_catalog_meta',
    'd1_catalog_options',
    'd1_material_subcategories',
    'd1_material_version_options',
    'd1_storage_meta',
    'd1_projects',
    'd1_assets',
    'd1_materials',
    'd1_material_versions',
    'd1_project_assets',
    'd1_project_versions',
    'd1_material_assets',
    'd1_cleanup_jobs',
    'd1_mutations',
    'd1_checks',
    'd1_maintenance',
  ];
  const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{
    name: string;
  }>();
  const present = new Set(rows.results.map((row) => row.name));
  if (names.some((name) => !present.has(name))) throw new Error('D1 storage migrations are incomplete');
  const version = await env.DB.prepare('SELECT version FROM d1_storage_meta').first<{ version: number }>();
  if (version?.version !== 1) throw new Error('Unsupported D1 storage schema');
  const catalogVersion = await env.DB.prepare('SELECT version FROM d1_catalog_meta WHERE id=1').first<{
    version: number;
  }>();
  if (catalogVersion?.version !== 1) throw new Error('Unsupported catalog schema');
  await env.DB.batch([
    env.DB.prepare(
      'SELECT id,owner_id,storage_revision,object_key,summary_json,byte_size FROM d1_projects LIMIT 0',
    ),
    env.DB.prepare(
      'SELECT id,owner_id,object_key,source_asset_id,metadata_json,content_hash,deleting FROM d1_assets LIMIT 0',
    ),
    env.DB.prepare('SELECT id,owner_id,scope,current_version_id,active FROM d1_materials LIMIT 0'),
    env.DB.prepare(
      'SELECT id,material_id,version,payload_json,category,view_count FROM d1_material_versions LIMIT 0',
    ),
    env.DB.prepare('SELECT project_id,asset_id FROM d1_project_assets LIMIT 0'),
    env.DB.prepare('SELECT project_id,version_id FROM d1_project_versions LIMIT 0'),
    env.DB.prepare('SELECT version_id,asset_id FROM d1_material_assets LIMIT 0'),
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
  const assets = await sql(
    ctx,
    `${visibleAssets} SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r
    WHERE NOT EXISTS(SELECT 1 FROM visible_assets a WHERE a.id=r.value)) AS valid`,
    ctx.actor.id,
    assetIds,
  ).first<{ valid: number }>();
  const versions = await sql(
    ctx,
    `SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(
    SELECT 1 FROM d1_material_versions v JOIN d1_materials m ON m.id=v.material_id
    WHERE v.id=r.value AND (m.owner_id=? OR m.scope='shared'))) AS valid`,
    versionIds,
    ctx.actor.id,
  ).first<{ valid: number }>();
  if (!assets?.valid || !versions?.valid) throw invalid();
}
