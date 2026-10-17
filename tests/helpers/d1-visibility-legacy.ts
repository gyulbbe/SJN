/**
 * Frozen copies of the visibility SQL that built the whole visible set for every check, as it was
 * before the request-scoped queries (docs/d1-query-efficiency-results-20261017.md). Only the
 * equivalence test and the read-cost measurement run them; the app never does.
 */
import type { Context } from '../../src/lib/d1/database';

export const LEGACY_ASSETS = `WITH RECURSIVE visible_assets(id,source_asset_id) AS (
  SELECT a.id,a.source_asset_id FROM d1_assets a WHERE a.deleting=0 AND (
    a.owner_id=? OR EXISTS(SELECT 1 FROM d1_material_assets r
      JOIN d1_material_versions v ON v.id=r.version_id JOIN d1_materials m ON m.id=v.material_id
      WHERE r.asset_id=a.id AND m.scope='shared'))
  UNION SELECT a.id,a.source_asset_id FROM d1_assets a JOIN visible_assets p ON p.source_asset_id=a.id WHERE a.deleting=0
)`;
export const LEGACY_VERSIONS = `WITH visible_versions(id) AS (SELECT v.id FROM d1_material_versions v JOIN d1_materials m ON m.id=v.material_id WHERE m.owner_id=? OR m.scope='shared')`;
export const LEGACY_ADMIN_VERSIONS = `WITH visible_versions(id) AS (
      SELECT version_id FROM d1_project_versions WHERE project_id=?
      UNION SELECT version_id FROM d1_admin_project_versions WHERE project_id=? AND actor_id=?
      UNION SELECT v.id FROM d1_material_versions v JOIN d1_materials m ON m.current_version_id=v.id
        WHERE m.scope='shared' AND m.active=1 AND m.purpose='catalog' AND json_extract(v.payload_json,'$.reconstruction') IS NULL
    )`;
export const LEGACY_ADMIN_ASSETS =
  LEGACY_ADMIN_VERSIONS.replace('WITH ', 'WITH RECURSIVE ') +
  `, visible_assets(id,source_asset_id) AS (
      SELECT a.id,a.source_asset_id FROM d1_assets a WHERE a.deleting=0 AND (
        EXISTS(SELECT 1 FROM d1_project_assets r WHERE r.project_id=? AND r.asset_id=a.id)
        OR EXISTS(SELECT 1 FROM d1_admin_project_assets r WHERE r.project_id=? AND r.actor_id=? AND r.asset_id=a.id)
        OR EXISTS(SELECT 1 FROM d1_material_assets r JOIN visible_versions v ON v.id=r.version_id WHERE r.asset_id=a.id)
      )
      UNION SELECT a.id,a.source_asset_id FROM d1_assets a JOIN visible_assets p ON p.source_asset_id=a.id WHERE a.deleting=0
    )`;
const LEGACY_PUBLIC_VISIBLE =
  "m.scope='shared' AND m.active=1 AND m.purpose='catalog' AND json_type(v.payload_json,'$.reconstruction') IS NULL";
const LEGACY_DIRECT_DISPLAY = `(
  (json_extract(v.payload_json,'$.category')='tile' AND EXISTS(SELECT 1 FROM json_each(v.payload_json,'$.textureAssetIds') j WHERE j.value=a.id)) OR
  (json_extract(v.payload_json,'$.category')<>'tile' AND EXISTS(SELECT 1 FROM json_each(v.payload_json,'$.views') j WHERE json_extract(j.value,'$.assetId')=a.id)) OR
  (CASE WHEN json_extract(v.payload_json,'$.category')='tile' THEN coalesce(json_array_length(v.payload_json,'$.textureAssetIds'),0) ELSE coalesce(json_array_length(v.payload_json,'$.views'),0) END = 0 AND
   (json_extract(v.payload_json,'$.coverAssetId')=a.id OR EXISTS(SELECT 1 FROM json_each(v.payload_json,'$.imageAssetIds') j WHERE j.value=a.id))) OR
  (json_extract(v.payload_json,'$.category')<>'tile' AND json_extract(v.payload_json,'$.coverAssetId')=a.id)
)`;
/** Every current public version's payload is scanned for asset `a`. */
export const LEGACY_PUBLICLY_DISPLAYED = `EXISTS(SELECT 1 FROM d1_materials m JOIN d1_material_versions v ON v.id=m.current_version_id WHERE ${LEGACY_PUBLIC_VISIBLE} AND ${LEGACY_DIRECT_DISPLAY})`;

/** `visible_assets(id,…)`: every asset the actor may read. */
export function legacyAssets(ctx: Context): { cte: string; values: unknown[] } {
  if (!ctx.adminProject) return { cte: LEGACY_ASSETS, values: [ctx.actor.id] };
  const scope = [ctx.adminProject.id, ctx.adminProject.id, ctx.actor.id];
  return { cte: LEGACY_ADMIN_ASSETS, values: [...scope, ...scope] };
}
/** `visible_versions(id)`: every version the actor may read. */
export function legacyVersions(ctx: Context): { cte: string; values: unknown[] } {
  return ctx.adminProject
    ? { cte: LEGACY_ADMIN_VERSIONS, values: [ctx.adminProject.id, ctx.adminProject.id, ctx.actor.id] }
    : { cte: LEGACY_VERSIONS, values: [ctx.actor.id] };
}
