import { resolveCatalogInput, catalogStatements } from '../catalog/server';
import { z } from 'zod';
import { stripLegacyMaterialImages } from '../material-images';
import { materialReferences } from '../repositories/references';
import { identifierSchema, materialInputSchema } from '../storage/validation';
import type { AssetRecord, Material, MaterialInput, MaterialVersion } from '../types';
import {
  assetAssertion,
  dataOwnerId,
  visibleAssetsQuery,
  visibleVersionsQuery,
  assertion,
  batch,
  mutationStatement,
  referenceJson,
  sql,
  stamp,
  type Context,
} from './database';
import { boundedDocument, conflict, D1StorageError, invalid, notFound } from './http';

interface MaterialRow {
  id: string;
  owner_id: string;
  scope: 'personal' | 'shared';
  purpose: 'catalog' | 'project';
  current_version_id: string;
  active: number;
  updated_at: string;
  created_at: string;
}
interface VersionRow {
  id: string;
  payload_json: string;
  version: number;
}
const forbidden = () => new D1StorageError(403, '공용 자재는 관리자만 변경할 수 있어요.', 'FORBIDDEN');
async function materialFor(ctx: Context, id: string): Promise<MaterialRow> {
  const row = await sql(
    ctx,
    `SELECT * FROM d1_materials WHERE id=? AND (owner_id=? OR scope='shared')`,
    id,
    ctx.actor.id,
  ).first<MaterialRow>();
  if (!row) throw notFound();
  return row;
}
async function versionFor(ctx: Context, id: string): Promise<VersionRow> {
  const visible = visibleVersionsQuery(ctx);
  const row = await sql(
    ctx,
    `${visible.cte} SELECT v.* FROM d1_material_versions v JOIN visible_versions p ON p.id=v.id WHERE v.id=?`,
    ...visible.values,
    id,
  ).first<VersionRow>();
  if (!row) throw notFound();
  return row;
}
function canChange(ctx: Context, row: MaterialRow): void {
  if (!ctx.actor.isAdmin || row.purpose === 'project') throw forbidden();
}
async function checkMaterialAssets(ctx: Context, input: MaterialInput): Promise<string> {
  const refs = materialReferences(input),
    refsJson = referenceJson(refs);
  const assets = new Map<string, Omit<AssetRecord, 'blob'>>();
  const visible = visibleAssetsQuery(ctx);
  const rows = await sql(
    ctx,
    `${visible.cte} SELECT a.id,a.metadata_json FROM d1_assets a JOIN visible_assets v ON v.id=a.id JOIN json_each(?) r ON r.value=a.id`,
    ...visible.values,
    refsJson,
  ).all<{ id: string; metadata_json: string }>();
  if (rows.results.length !== refs.length) throw invalid('접근할 수 없는 자산이 포함되어 있어요.');
  for (const row of rows.results) assets.set(row.id, JSON.parse(row.metadata_json));
  const images = [
    input.coverAssetId,
    ...(input.imageAssetIds ?? []),
    ...input.textureAssetIds,
    ...input.views.map((view) => view.assetId),
  ].filter(Boolean) as string[];
  if (images.some((id) => assets.get(id)?.kind === 'product-mesh'))
    throw invalid('제품 사진에는 이미지가 필요해요.');
  for (const view of input.views)
    if (view.product3d) {
      const mesh = assets.get(view.product3d.meshAssetId),
        source = assets.get(view.product3d.inputAssetId);
      if (
        mesh?.kind !== 'product-mesh' ||
        !source ||
        source.kind === 'product-mesh' ||
        mesh.sourceAssetId !== view.product3d.inputAssetId
      )
        throw invalid('입체 데이터와 입력 이미지의 연결을 확인해 주세요.');
    }
  return refsJson;
}
export async function materials(
  ctx: Context,
  body: Record<string, unknown>,
  projectResource = false,
): Promise<unknown> {
  if (ctx.adminProject && !['list', 'getVersion', 'create'].includes(String(body.operation)))
    throw forbidden();
  if (ctx.adminProject && body.operation === 'create' && !projectResource) throw forbidden();
  switch (body.operation) {
    case 'list': {
      const visible = visibleVersionsQuery(ctx);
      const rows = ctx.adminProject
        ? await sql(
            ctx,
            `${visible.cte} SELECT m.*,v.payload_json FROM d1_materials m JOIN d1_material_versions v ON v.material_id=m.id JOIN visible_versions p ON p.id=v.id ORDER BY (v.id=m.current_version_id) DESC,m.updated_at DESC`,
            ...visible.values,
          ).all<MaterialRow & { payload_json: string }>()
        : await sql(
            ctx,
            `SELECT m.*,v.payload_json FROM d1_materials m JOIN d1_material_versions v ON v.id=m.current_version_id WHERE m.owner_id=? OR m.scope='shared' ORDER BY m.updated_at DESC`,
            ctx.actor.id,
          ).all<MaterialRow & { payload_json: string }>();
      const result: { material: Material; version: MaterialVersion }[] = [];
      for (const row of rows.results) {
        if (ctx.adminProject && result.some((entry) => entry.material.id === row.id)) continue;
        result.push({
          material: {
            id: row.id,
            ownerId: row.owner_id,
            currentVersionId: ctx.adminProject ? JSON.parse(row.payload_json).id : row.current_version_id,
            active: !!row.active,
            scope: row.scope,
            updatedAt: row.updated_at,
          },
          version: JSON.parse(row.payload_json) as MaterialVersion,
        });
      }
      return result;
    }
    case 'getVersion':
      return JSON.parse((await versionFor(ctx, identifierSchema.parse(body.id))).payload_json);
    case 'create':
    case 'update': {
      if (!projectResource && !ctx.actor.isAdmin) throw forbidden();
      const input = stripLegacyMaterialImages(materialInputSchema.parse(body.input));
      if (projectResource) {
        if (
          body.operation !== 'create' ||
          input.scope !== 'personal' ||
          input.catalog ||
          input.brand ||
          input.pricing?.unitPrice
        )
          throw forbidden();
        if (input.reconstruction && input.reconstruction.kind !== input.category)
          throw invalid('프로젝트 모형 분류가 달라요.');
        if (!input.reconstruction) {
          if (input.views.length !== 1 || input.textureAssetIds.length)
            throw invalid('프로젝트 추출 모형 형식이 올바르지 않아요.');
          const asset = await sql(
            ctx,
            'SELECT source_asset_id FROM d1_assets WHERE id=? AND owner_id=? AND deleting=0',
            input.views[0].assetId,
            dataOwnerId(ctx),
          ).first<{ source_asset_id: string | null }>();
          if (!asset?.source_asset_id) throw invalid('사진에서 추출한 본인 프로젝트 이미지가 필요해요.');
        }
      } else if (input.reconstruction) throw invalid('프로젝트 모형은 공용 자재로 등록할 수 없어요.');
      const selection = projectResource ? undefined : await resolveCatalogInput(ctx, input);
      const existing =
        body.operation === 'update' ? await materialFor(ctx, identifierSchema.parse(body.id)) : null;
      if (existing) canChange(ctx, existing);
      else if (input.scope === 'shared' && !ctx.actor.isAdmin) throw forbidden();
      const expected = existing ? identifierSchema.parse(body.expectedVersionId) : null;
      if (existing && existing.current_version_id !== expected) throw conflict();
      const previous = existing ? await versionFor(ctx, expected!) : null;
      input.scope = projectResource ? 'personal' : (existing?.scope ?? 'shared');
      const refs = await checkMaterialAssets(ctx, input);
      const id = existing?.id ?? crypto.randomUUID();
      const value: MaterialVersion = {
        ...input,
        id: crypto.randomUUID(),
        materialId: id,
        version: (previous?.version ?? 0) + 1,
        createdAt: stamp(),
      };
      const payload = boundedDocument(value);
      if (new TextEncoder().encode(payload).length > 512 * 1024)
        throw invalid('자재 정보는 512KB 이하여야 해요.');
      const statements = existing
        ? [
            assertion(
              ctx,
              'conflict',
              `EXISTS(SELECT 1 FROM d1_materials WHERE id=? AND current_version_id=? AND
            ((scope='personal' AND owner_id=?) OR (scope='shared' AND ?=1)))`,
              id,
              expected,
              ctx.actor.id,
              Number(ctx.actor.isAdmin),
            ),
            sql(
              ctx,
              'UPDATE d1_materials SET current_version_id=?,updated_at=? WHERE id=?',
              value.id,
              value.createdAt,
              id,
            ),
          ]
        : [
            sql(
              ctx,
              `INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES(?,?,?,?,?,?,?)`,
              id,
              dataOwnerId(ctx),
              input.scope,
              value.id,
              value.createdAt,
              value.createdAt,
              projectResource ? 'project' : 'catalog',
            ),
          ];
      await batch(ctx, [
        assetAssertion(ctx, refs),
        ...statements,
        sql(
          ctx,
          'INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at,subcategory_id) VALUES(?,?,?,?,?,?,?,?)',
          value.id,
          id,
          value.version,
          payload,
          value.category,
          value.views.length,
          value.createdAt,
          selection?.catalog.subcategoryId ?? null,
        ),
        sql(
          ctx,
          'INSERT INTO d1_material_assets(version_id,asset_id) SELECT ?,value FROM json_each(?)',
          value.id,
          refs,
        ),
        ...(ctx.adminProject
          ? [
              sql(
                ctx,
                'INSERT INTO d1_admin_project_versions(project_id,version_id,actor_id,created_at) VALUES(?,?,?,?)',
                ctx.adminProject.id,
                value.id,
                ctx.actor.id,
                value.createdAt,
              ),
            ]
          : []),
        ...(selection ? catalogStatements(ctx, value.id, selection) : []),
        ...mutationStatement(ctx, { value }),
      ]);
      return value;
    }
    case 'setActive': {
      const row = await materialFor(ctx, identifierSchema.parse(body.id));
      canChange(ctx, row);
      const active = z.boolean().parse(body.active);
      await batch(ctx, [
        sql(
          ctx,
          `UPDATE d1_materials SET active=?,updated_at=? WHERE id=? AND
        ((scope='personal' AND owner_id=?) OR (scope='shared' AND ?=1))`,
          Number(active),
          stamp(),
          row.id,
          ctx.actor.id,
          Number(ctx.actor.isAdmin),
        ),
        ...mutationStatement(ctx, { value: null }),
      ]);
      return null;
    }
    default:
      throw invalid('지원하지 않는 자재 작업이에요.');
  }
}
