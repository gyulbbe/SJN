import { publicPlacementSchema, type PublicPlacement } from './placement-contract';
import { parsePageSearchParams, PAGE_SIZE, type MaterialPage } from './paging';
import { CLASSES, listPage, type ListedRow } from '@/lib/d1/material-list';
import { json, D1StorageError } from '@/lib/d1/http';
import type { D1Bindings } from '@/lib/d1/types';
import type { MaterialVersion } from '@/lib/types';
import { getMaterialImageAssetId } from '@/lib/material-images';
import { isRetiredDirection, readMaterialViews } from '@/lib/product-direction';
import { identifierSchema } from '@/lib/storage/validation';
import { z } from 'zod';
export type PublicMaterial = {
  id: string;
  name: string;
  brand: string;
  category: MaterialVersion['category'];
  subcategoryName: string;
  color: string;
  composition: string;
  finish: string;
  description: string;
  code: string;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  images: { url: string; label: string }[];
};
const visible =
  "m.scope='shared' AND m.active=1 AND m.purpose='catalog' AND json_type(v.payload_json,'$.reconstruction') IS NULL";
/**
 * Every image a public version points at, the preferred one first. A retired 위·아래 photo is still
 * listed (flagged `retired`) because the placement projection must keep the photo numbers; the
 * public list leaves it out. A product's 대표 이미지 is one of them.
 */
export function displayImages(v: MaterialVersion) {
  const images: { id: string; label: string; retired?: boolean }[] =
    v.category === 'tile'
      ? v.textureAssetIds.map((id) => ({ id, label: '타일 텍스처' }))
      : v.views.map((view) => ({
          id: view.assetId,
          label: view.direction,
          ...(isRetiredDirection(view.direction) ? { retired: true } : {}),
        }));
  // (A material with no photo at all keeps the old cover-only listing below.)
  if (
    v.category !== 'tile' &&
    v.coverAssetId &&
    images.length &&
    !images.some((image) => image.id === v.coverAssetId)
  )
    images.push({ id: v.coverAssetId, label: '대표 이미지' });
  const preferred = getMaterialImageAssetId(v);
  if (!images.length)
    for (const id of [v.coverAssetId, ...(v.imageAssetIds ?? [])])
      if (id && !images.some((image) => image.id === id)) images.push({ id, label: '제품 이미지' });
  return images.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
}
const directDisplay = `(
  (json_extract(v.payload_json,'$.category')='tile' AND EXISTS(SELECT 1 FROM json_each(v.payload_json,'$.textureAssetIds') j WHERE j.value=a.id)) OR
  (json_extract(v.payload_json,'$.category')<>'tile' AND EXISTS(SELECT 1 FROM json_each(v.payload_json,'$.views') j WHERE json_extract(j.value,'$.assetId')=a.id)) OR
  (CASE WHEN json_extract(v.payload_json,'$.category')='tile' THEN coalesce(json_array_length(v.payload_json,'$.textureAssetIds'),0) ELSE coalesce(json_array_length(v.payload_json,'$.views'),0) END = 0 AND
   (json_extract(v.payload_json,'$.coverAssetId')=a.id OR EXISTS(SELECT 1 FROM json_each(v.payload_json,'$.imageAssetIds') j WHERE j.value=a.id))) OR
  (json_extract(v.payload_json,'$.category')<>'tile' AND json_extract(v.payload_json,'$.coverAssetId')=a.id)
)`;
/**
 * A current public version displays asset `a` directly. Starts from the versions that reference the
 * asset (`d1_material_assets` holds every image a version shows) instead of reading every public
 * payload, so one image check does not grow with the catalog. CROSS JOIN keeps that order: SQLite
 * would otherwise start from the public-materials index and read every public version.
 */
export const publiclyDisplayed = `EXISTS(SELECT 1 FROM d1_material_assets r
  CROSS JOIN d1_material_versions v CROSS JOIN d1_materials m
  WHERE r.asset_id=a.id AND v.id=r.version_id AND m.id=v.material_id AND m.current_version_id=v.id
  AND ${visible} AND ${directDisplay})`;
function pageQuery(params: URLSearchParams) {
  try {
    return parsePageSearchParams(params);
  } catch {
    throw new D1StorageError(400, '목록 조건을 확인해 주세요.');
  }
}
/** Public cards for listed rows: the display images that are still public, preferred first. */
async function publicItems(env: D1Bindings, rows: ListedRow[]): Promise<PublicMaterial[]> {
  const versions = rows.map((row) => ({
    id: row.material_id,
    v: readMaterialViews(JSON.parse(row.payload_json) as MaterialVersion),
  }));
  const ids = [...new Set(versions.flatMap(({ v }) => displayImages(v).map((image) => image.id)))];
  const imageRows = ids.length
    ? await env.DB.prepare(
        `SELECT id FROM d1_assets WHERE deleting=0 AND json_extract(metadata_json,'$.kind') IN ('texture','product','preview') AND id IN(SELECT value FROM json_each(?))`,
      )
        .bind(JSON.stringify(ids))
        .all<{ id: string }>()
    : { results: [] };
  const allowedImages = new Set(imageRows.results.map((row) => row.id));
  return versions.map(({ id, v }) => ({
    id,
    name: v.name,
    brand: v.brand,
    category: v.category,
    subcategoryName: v.subcategoryName ?? '',
    color: v.color,
    composition: v.composition ?? '',
    finish: v.finish,
    description: v.description,
    code: v.code,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
    depthMm: v.depthMm,
    images: displayImages(v)
      .filter((ref) => !ref.retired && allowedImages.has(ref.id))
      .map((ref) => ({ url: '/api/catalog/images?id=' + encodeURIComponent(ref.id), label: ref.label })),
  }));
}
/**
 * GET /api/catalog/materials: one page of the public catalogue (category, search, facets; the first
 * page also counts the matches and, with options=1, lists the facet options).
 */
export async function publicMaterials(env: D1Bindings, request: Request): Promise<Response> {
  const query = pageQuery(new URL(request.url).searchParams);
  const page = await listPage(env.DB, query, 'catalog', [[{ kind: 'shared', classes: CLASSES.public }]]);
  const result: MaterialPage<PublicMaterial> = { ...page, items: await publicItems(env, page.items) };
  return json(result);
}
export async function publicImage(env: D1Bindings, request: Request): Promise<Response> {
  const parsed = identifierSchema.safeParse(new URL(request.url).searchParams.get('id'));
  if (!parsed.success) throw new D1StorageError(404, '공개 이미지를 찾지 못했어요.');
  const id = parsed.data;
  // Only directly displayed images on the current published version; never follow source_asset_id.
  const row = await env.DB.prepare(
    `SELECT a.object_key,a.metadata_json FROM d1_assets a WHERE a.id=? AND a.deleting=0
 AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview') AND ${publiclyDisplayed}`,
  )
    .bind(id)
    .first<{ object_key: string; metadata_json: string }>();
  if (!row) throw new D1StorageError(404, '공개 이미지를 찾지 못했어요.');
  const file = await env.ASSET_BUCKET.get(row.object_key);
  if (!file) throw new D1StorageError(404, '이미지를 찾지 못했어요.');
  const mime = JSON.parse(row.metadata_json).mime;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime))
    throw new D1StorageError(404, '이미지를 찾지 못했어요.');
  return new Response(file.body, {
    headers: { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export type PublicVersionRow = {
  id: string;
  version_id: string;
  version: number;
  payload_json: string;
};

/**
 * GET /api/catalog/placement. Current active catalog projections only; older versions stay behind the
 * member API. `materialId` reads one; `ids` (comma separated, up to a page) reads the ones still
 * placeable; otherwise one page of the guest drawer (the public list without the bundled samples, the
 * editor's search; a material whose display images are not all public is left out, so a page can be
 * shorter than its limit).
 */
export async function publicPlacement(env: D1Bindings, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (params.has('materialId')) {
    if ([...params.keys()].some((key) => key !== 'materialId') || params.getAll('materialId').length > 1)
      throw new D1StorageError(400, '공용 자재 요청을 확인해 주세요.');
    const parsed = identifierSchema.safeParse(params.get('materialId'));
    if (!parsed.success) throw new D1StorageError(404, '배치할 공용 자재를 찾지 못했어요.');
    const [placement] = await placementsOf(env, await currentPublic(env, [parsed.data]));
    if (!placement) throw new D1StorageError(404, '배치할 공용 자재를 찾지 못했어요.');
    return json(placement);
  }
  if (params.has('ids')) {
    if ([...params.keys()].some((key) => key !== 'ids') || params.getAll('ids').length > 1)
      throw new D1StorageError(400, '공용 자재 요청을 확인해 주세요.');
    const ids = z.array(identifierSchema).min(1).max(PAGE_SIZE).safeParse(params.get('ids')!.split(','));
    if (!ids.success) throw new D1StorageError(400, '공용 자재 요청을 확인해 주세요.');
    return json({ placements: await placementsOf(env, await currentPublic(env, [...new Set(ids.data)])) });
  }
  const page = await listPage(env.DB, pageQuery(params), 'picker', [
    [{ kind: 'shared', classes: CLASSES.publicListed }],
  ]);
  const { items, ...rest } = page;
  const placements = await placementsOf(
    env,
    items.map((row) => ({
      id: row.material_id,
      version_id: row.version_id,
      version: row.version,
      payload_json: row.payload_json,
    })),
  );
  return json({ ...rest, placements });
}
/** The current public versions of these materials (the old list's condition, by id). */
async function currentPublic(env: D1Bindings, materialIds: string[]): Promise<PublicVersionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT m.id,v.id AS version_id,v.version,v.payload_json FROM json_each(?) q CROSS JOIN d1_materials m
     CROSS JOIN d1_material_versions v WHERE m.id=q.value AND v.id=m.current_version_id AND ${visible}
     ORDER BY m.updated_at DESC`,
  )
    .bind(JSON.stringify(materialIds))
    .all<PublicVersionRow>();
  return rows.results;
}
/** Placement projections of public versions whose display images are all public (others are left out). */
export async function placementsOf(env: D1Bindings, rows: PublicVersionRow[]): Promise<PublicPlacement[]> {
  if (!rows.length) return [];
  const versions = rows.map((row) => ({
    row,
    v: readMaterialViews(JSON.parse(row.payload_json) as MaterialVersion),
  }));
  const ids = [...new Set(versions.flatMap(({ v }) => displayImages(v).map((ref) => ref.id)))];
  const imageRows = await env.DB.prepare(
    `SELECT a.id,a.metadata_json FROM d1_assets a WHERE a.deleting=0
     AND a.id IN(SELECT value FROM json_each(?))
     AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview')
     AND json_extract(a.metadata_json,'$.mime') IN ('image/png','image/jpeg','image/webp')
     AND ${publiclyDisplayed}`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; metadata_json: string }>();
  const images = new Map(
    imageRows.results.map((row) => {
      const metadata = JSON.parse(row.metadata_json);
      return [
        row.id,
        {
          id: row.id,
          url: '/api/catalog/images?id=' + encodeURIComponent(row.id),
          width: metadata.width,
          height: metadata.height,
          mime: metadata.mime,
          size: metadata.size,
          kind: metadata.kind,
        },
      ] as const;
    }),
  );
  const placements: PublicPlacement[] = [];
  for (const { row, v } of versions) {
    const displayed = [...new Set(displayImages(v).map((ref) => ref.id))];
    const refs = displayed.filter((id) => images.has(id));
    // Preserve saved view/texture indices when the guest draft becomes a member project.
    // A partial projection could make the same viewIndex select different bytes after login.
    if (!refs.length || refs.length !== displayed.length) continue;
    const allowed = new Set(refs);
    const textureAssetIds = v.category === 'tile' ? v.textureAssetIds.filter((id) => allowed.has(id)) : [];
    const views =
      v.category === 'tile'
        ? []
        : v.views
            .filter((view) => allowed.has(view.assetId))
            .map((view) => ({
              assetId: view.assetId,
              direction: view.direction,
              anchor: { x: view.anchor.x, y: view.anchor.y },
            }));
    const legacy = v.category === 'tile' ? !v.textureAssetIds.length : !v.views.length;
    placements.push(
      publicPlacementSchema.parse({
        materialId: row.id,
        versionId: row.version_id,
        version: row.version,
        name: v.name,
        brand: v.brand,
        code: v.code,
        category: v.category,
        description: v.description,
        color: v.color,
        finish: v.finish,
        composition: v.composition,
        subcategoryName: v.subcategoryName,
        pricing: v.pricing,
        widthMm: v.widthMm,
        heightMm: v.heightMm,
        depthMm: v.depthMm,
        usage: v.usage,
        installation: v.installation,
        textureAssetIds,
        views,
        ...(v.category !== 'tile' && v.coverAssetId && allowed.has(v.coverAssetId)
          ? { coverAssetId: v.coverAssetId }
          : legacy && v.coverAssetId && allowed.has(v.coverAssetId)
            ? { coverAssetId: v.coverAssetId }
            : {}),
        ...(legacy && v.imageAssetIds
          ? { imageAssetIds: v.imageAssetIds.filter((id) => allowed.has(id)) }
          : {}),
        defaultGroutWidth: v.defaultGroutWidth,
        defaultGroutColor: v.defaultGroutColor,
        defaultPattern: v.defaultPattern,
        images: refs.map((id) => images.get(id)!),
      }),
    );
  }
  return placements;
}
