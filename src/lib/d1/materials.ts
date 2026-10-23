import { resolveCatalogInput, catalogStatements } from '../catalog/server';
import { materialCard } from '../catalog/cards';
import { materialPageQuerySchema } from '../catalog/paging';
import { matchesReconstruction } from '../repositories/batches';
import { z } from 'zod';
import { stripLegacyMaterialImages } from '../material-images';
import { materialReferences } from '../repositories/references';
import { identifierSchema, materialInputSchema } from '../storage/validation';
import { readMaterialViews } from '../product-direction';
import type { AssetRecord, Material, MaterialInput, MaterialVersion } from '../types';
import {
  adminVisibleVersionsSet,
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
import { CLASSES, libraryCounts, listPage, type ListedRow, type ListGroup } from './material-list';

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
  const visible = visibleVersionsQuery(ctx, JSON.stringify([id]));
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
  const visible = visibleAssetsQuery(ctx, refsJson);
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
  // 읽기 전용 호환: 옛 360° 자재를 다시 저장해도 메시·입력 사진 참조가 올바른지만 본다(docs/product3d-removal.md).
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
/** A list row as the old full list returned it (the version is the material's current one). */
function listedMaterial(
  row: Pick<ListedRow, 'material_id' | 'version_id' | 'owner_id' | 'scope' | 'active' | 'updated_at'>,
): Material {
  return {
    id: row.material_id,
    ownerId: row.owner_id,
    currentVersionId: row.version_id,
    active: !!row.active,
    scope: row.scope as Material['scope'],
    updatedAt: row.updated_at,
  };
}
const readVersion = (payload: string) => readMaterialViews(JSON.parse(payload) as MaterialVersion);
const pageRequestSchema = z
  .object({
    view: z.enum(['picker', 'library']).default('picker'),
    scope: z.enum(['all', 'personal', 'shared']).default('all'),
    active: z.boolean().default(true),
  })
  .strict();
const findSchema = z
  .object({
    code: z.string().min(1).max(200),
    reconstruction: z.union([
      z.object({ version: z.union([z.literal(1), z.literal(2)]) }).strict(),
      z.object({ kind: z.literal('tile') }).strict(),
    ]),
  })
  .strict();
type ProjectRow = {
  version_id: string;
  material_id: string;
  version: number;
  is_current: number;
  scope: string;
  active: number;
  class: number;
  code: string;
  updated_at: string;
  current_id: string | null;
  current_scope: string | null;
  current_active: number | null;
  current_class: number | null;
  current_in_project: number;
};
const adminPublic = (row: {
  is_current: number;
  scope: string | null;
  active: number | null;
  class: number | null;
}) =>
  !!row.is_current &&
  row.scope === 'shared' &&
  row.active === 1 &&
  (CLASSES.adminPublic as readonly number[]).includes(row.class ?? -1);
/**
 * What an administrator project's full list added to the public catalogue, from the project's and this
 * administrator's references (the cost follows them): current versions that are not public, and for a
 * material whose current version the scope cannot read, one older referenced version (the highest).
 */
async function adminProjectEntries(ctx: Context) {
  const project = ctx.adminProject!;
  const rows = await sql(
    ctx,
    `WITH proj(version_id) AS (SELECT version_id FROM d1_project_versions WHERE project_id=?
       UNION SELECT version_id FROM d1_admin_project_versions WHERE project_id=? AND actor_id=?)
     SELECT l.version_id,l.material_id,l.version,l.is_current,l.scope,l.active,l.class,l.code,l.updated_at,
       c.version_id AS current_id,c.scope AS current_scope,c.active AS current_active,c.class AS current_class,
       EXISTS(SELECT 1 FROM proj q WHERE q.version_id=c.version_id) AS current_in_project
     FROM proj p CROSS JOIN d1_material_list l
     LEFT JOIN d1_material_list c ON c.material_id=l.material_id AND c.is_current=1
     WHERE l.version_id=p.version_id`,
    project.id,
    project.id,
    ctx.actor.id,
  ).all<ProjectRow>();
  const current: ProjectRow[] = [];
  const older = new Map<string, ProjectRow>();
  for (const row of rows.results) {
    if (row.is_current) {
      if (!adminPublic(row)) current.push(row);
      continue;
    }
    const readable =
      row.current_id !== null &&
      (!!row.current_in_project ||
        adminPublic({
          is_current: 1,
          scope: row.current_scope,
          active: row.current_active,
          class: row.current_class,
        }));
    const kept = older.get(row.material_id);
    if (!readable && (!kept || row.version > kept.version)) older.set(row.material_id, row);
  }
  return { current, older: [...older.values()] };
}
/** The administrator project drawer: public current materials and the project's own, then older ones. */
async function adminProjectGroups(ctx: Context): Promise<ListGroup[]> {
  const { current, older } = await adminProjectEntries(ctx);
  return [
    [
      { kind: 'shared', classes: CLASSES.adminListed },
      { kind: 'ids', ids: current.map((row) => row.version_id), classes: CLASSES.listed },
    ],
    [{ kind: 'ids', ids: older.map((row) => row.version_id), classes: CLASSES.listed }],
  ];
}
/** Versions by id (visible as for getVersion); `withCurrent` adds each material as the old list showed it. */
async function versionsById(ctx: Context, ids: string[], withCurrent: boolean) {
  const visible = visibleVersionsQuery(ctx, referenceJson(ids));
  const rows = await sql(
    ctx,
    `${visible.cte} SELECT v.id,v.material_id,v.payload_json FROM visible_versions p CROSS JOIN d1_material_versions v WHERE v.id=p.id`,
    ...visible.values,
  ).all<{ id: string; material_id: string; payload_json: string }>();
  const byId = new Map(rows.results.map((row) => [row.id, readVersion(row.payload_json)]));
  const versions = [...new Set(ids)].filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  if (!withCurrent || !versions.length) return { versions, current: [] };
  const materialRows = await sql(
    ctx,
    `SELECT m.* FROM json_each(?) q CROSS JOIN d1_materials m
     WHERE m.id=q.value${ctx.adminProject ? '' : ' AND (m.owner_id=? OR m.scope=?)'}`,
    JSON.stringify([...new Set(versions.map((version) => version.materialId))]),
    ...(ctx.adminProject ? [] : [ctx.actor.id, 'shared']),
  ).all<MaterialRow>();
  const readable = visibleVersionsQuery(
    ctx,
    JSON.stringify(materialRows.results.map((row) => row.current_version_id)),
  );
  const currentRows = materialRows.results.length
    ? await sql(
        ctx,
        `${readable.cte} SELECT v.id,v.payload_json FROM visible_versions p CROSS JOIN d1_material_versions v WHERE v.id=p.id`,
        ...readable.values,
      ).all<{ id: string; payload_json: string }>()
    : { results: [] };
  const latest = new Map(currentRows.results.map((row) => [row.id, readVersion(row.payload_json)]));
  const current: { material: Material; version: MaterialVersion }[] = [];
  for (const row of materialRows.results) {
    // The administrator scope listed an older referenced version when it could not read the current one.
    const version = latest.get(row.current_version_id) ?? versions.find((item) => item.materialId === row.id);
    if (!version) continue;
    current.push({
      material: {
        id: row.id,
        ownerId: row.owner_id,
        currentVersionId: ctx.adminProject ? version.id : row.current_version_id,
        active: !!row.active,
        scope: row.scope,
        updatedAt: row.updated_at,
      },
      version,
    });
  }
  return { versions, current };
}
/** The material version the old full list's `.find` would have returned for a reconstruction code. */
async function findByCode(ctx: Context, match: z.infer<typeof findSchema>): Promise<MaterialVersion | null> {
  const matches = (version: MaterialVersion) => matchesReconstruction(version, match);
  if (!ctx.adminProject) {
    const rows = await sql(
      ctx,
      `SELECT v.payload_json FROM d1_material_list l INDEXED BY d1_list_code CROSS JOIN d1_material_versions v
       WHERE l.code=? AND l.is_current=1 AND (l.owner_id=? OR l.scope='shared') AND v.id=l.version_id
       ORDER BY l.updated_at DESC,l.material_id DESC`,
      match.code,
      ctx.actor.id,
    ).all<{ payload_json: string }>();
    return rows.results.map((row) => readVersion(row.payload_json)).find(matches) ?? null;
  }
  const { current, older } = await adminProjectEntries(ctx);
  const publicRows = await sql(
    ctx,
    `SELECT l.version_id,l.updated_at,l.material_id FROM d1_material_list l INDEXED BY d1_list_code
     WHERE l.code=? AND l.is_current=1 AND l.scope='shared' AND l.active=1 AND l.class IN (${CLASSES.adminPublic.join(',')})`,
    match.code,
  ).all<{ version_id: string; updated_at: string; material_id: string }>();
  type Entry = { version_id: string; updated_at: string; material_id: string };
  const newest = (a: Entry, b: Entry) =>
    a.updated_at === b.updated_at
      ? b.material_id.localeCompare(a.material_id)
      : b.updated_at.localeCompare(a.updated_at);
  const entries: Entry[] = [
    ...[...publicRows.results, ...current.filter((row) => row.code === match.code)].sort(newest),
    ...older.filter((row) => row.code === match.code).sort(newest),
  ];
  if (!entries.length) return null;
  const payloads = await sql(
    ctx,
    'SELECT v.id,v.payload_json FROM json_each(?) q CROSS JOIN d1_material_versions v WHERE v.id=q.value',
    JSON.stringify(entries.map((row) => row.version_id)),
  ).all<{ id: string; payload_json: string }>();
  const byId = new Map(payloads.results.map((row) => [row.id, readVersion(row.payload_json)]));
  return (
    entries.map((row) => byId.get(row.version_id)).find((version) => !!version && matches(version)) ?? null
  );
}
export async function materials(
  ctx: Context,
  body: Record<string, unknown>,
  projectResource = false,
): Promise<unknown> {
  if (
    ctx.adminProject &&
    !['list', 'getVersion', 'create', 'page', 'getVersions', 'find'].includes(String(body.operation))
  )
    throw forbidden();
  if (ctx.adminProject && body.operation === 'create' && !projectResource) throw forbidden();
  switch (body.operation) {
    // The whole list. No screen asks for it since the paged lists (2026-10-22); it answers tabs opened
    // before that deploy and goes after 2026-11-05 (docs/material-paging-results-20261022.md).
    case 'list': {
      const visible = ctx.adminProject && adminVisibleVersionsSet(ctx.adminProject, ctx.actor.id);
      const rows = visible
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
          // Older angle names are read as the current list's names; saving writes the strict list.
          version: readMaterialViews(JSON.parse(row.payload_json) as MaterialVersion),
        });
      }
      return result;
    }
    case 'page': {
      const query = materialPageQuerySchema.parse(body.query ?? {});
      const request = pageRequestSchema.parse({ view: body.view, scope: body.scope, active: body.active });
      if (ctx.adminProject && (request.view !== 'picker' || request.scope !== 'all' || !request.active))
        throw forbidden();
      const groups: ListGroup[] = ctx.adminProject
        ? await adminProjectGroups(ctx)
        : [
            [
              ...(request.scope === 'personal' ? [] : [{ kind: 'shared' as const, classes: CLASSES.listed }]),
              ...(request.scope === 'shared'
                ? []
                : [{ kind: 'personal' as const, owner: ctx.actor.id, classes: CLASSES.listed }]),
            ],
          ];
      const page = await listPage(ctx.env.DB, query, request.view, groups, {
        active: request.active,
        key: [request.scope, ctx.adminProject?.id ?? ''],
      });
      return {
        ...page,
        items: page.items.map((row) => materialCard(listedMaterial(row), readVersion(row.payload_json))),
        ...(request.view === 'library' && !query.cursor
          ? { counts: await libraryCounts(ctx.env.DB, ctx.actor.id, request.active) }
          : {}),
      };
    }
    case 'getVersions':
      return versionsById(
        ctx,
        z.array(identifierSchema).min(1).max(100).parse(body.ids),
        z.boolean().default(false).parse(body.withCurrent),
      );
    case 'find':
      return findByCode(ctx, findSchema.parse(body.match));
    case 'getVersion':
      return readMaterialViews(
        JSON.parse((await versionFor(ctx, identifierSchema.parse(body.id))).payload_json) as MaterialVersion,
      );
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
