import { readCatalog } from './server';
import { publicPlacementSchema, type PublicPlacement } from './placement-contract';
import { json, D1StorageError } from '@/lib/d1/http';
import type { D1Bindings } from '@/lib/d1/types';
import type { MaterialVersion } from '@/lib/types';
import { getMaterialImageAssetId } from '@/lib/material-images';
import { identifierSchema } from '@/lib/storage/validation';
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
  pricing: MaterialVersion['pricing'];
  images: { url: string; label: string }[];
};
const visible =
  "m.scope='shared' AND m.active=1 AND m.purpose='catalog' AND json_type(v.payload_json,'$.reconstruction') IS NULL";
function displayImages(v: MaterialVersion) {
  const images =
    v.category === 'tile'
      ? v.textureAssetIds.map((id) => ({ id, label: '타일 텍스처' }))
      : v.views.map((view) => ({ id: view.assetId, label: view.direction }));
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
   (json_extract(v.payload_json,'$.coverAssetId')=a.id OR EXISTS(SELECT 1 FROM json_each(v.payload_json,'$.imageAssetIds') j WHERE j.value=a.id)))
)`;
export async function publicMaterials(env: D1Bindings): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT m.id,v.payload_json FROM d1_materials m JOIN d1_material_versions v ON v.id=m.current_version_id WHERE ${visible} ORDER BY m.updated_at DESC`,
  ).all<{ id: string; payload_json: string }>();
  const versions = rows.results.map((row) => ({
    id: row.id,
    v: JSON.parse(row.payload_json) as MaterialVersion,
  }));
  const ids = [...new Set(versions.flatMap(({ v }) => displayImages(v).map((image) => image.id)))];
  const imageRows = await env.DB.prepare(
    `SELECT id FROM d1_assets WHERE deleting=0 AND json_extract(metadata_json,'$.kind') IN ('texture','product','preview') AND id IN(SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  const allowedImages = new Set(imageRows.results.map((row) => row.id));
  const materials: PublicMaterial[] = versions.map(({ id, v }) => ({
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
    pricing: v.pricing,
    images: displayImages(v)
      .filter((ref) => allowedImages.has(ref.id))
      .map((ref) => ({ url: '/api/catalog/images?id=' + encodeURIComponent(ref.id), label: ref.label })),
  }));
  return json({ materials, catalog: await readCatalog(env.DB) });
}
export async function publicImage(env: D1Bindings, request: Request): Promise<Response> {
  const parsed = identifierSchema.safeParse(new URL(request.url).searchParams.get('id'));
  if (!parsed.success) throw new D1StorageError(404, '공개 이미지를 찾지 못했어요.');
  const id = parsed.data;
  // Only directly displayed images on the current published version; never follow source_asset_id.
  const row = await env.DB.prepare(
    `SELECT a.object_key,a.metadata_json FROM d1_assets a WHERE a.id=? AND a.deleting=0
 AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview') AND EXISTS(
 SELECT 1 FROM d1_materials m JOIN d1_material_versions v ON v.id=m.current_version_id WHERE ${visible} AND ${directDisplay})`,
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

type PublicVersionRow = {
  id: string;
  version_id: string;
  version: number;
  payload_json: string;
};

/** Current active catalog projections only; older versions stay behind the member API. */
export async function publicPlacement(env: D1Bindings, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'materialId') || params.getAll('materialId').length > 1)
    throw new D1StorageError(400, '공용 자재 요청을 확인해 주세요.');
  const requested = params.has('materialId');
  const parsed = identifierSchema.safeParse(params.get('materialId'));
  if (requested && !parsed.success) throw new D1StorageError(404, '배치할 공용 자재를 찾지 못했어요.');
  const statement = env.DB.prepare(
    `SELECT m.id,v.id AS version_id,v.version,v.payload_json FROM d1_materials m
     JOIN d1_material_versions v ON v.id=m.current_version_id
     WHERE ${visible}${requested ? ' AND m.id=?' : ''} ORDER BY m.updated_at DESC`,
  );
  const rows = await (requested ? statement.bind(parsed.data) : statement).all<PublicVersionRow>();
  const versions = rows.results.map((row) => ({ row, v: JSON.parse(row.payload_json) as MaterialVersion }));
  const ids = [...new Set(versions.flatMap(({ v }) => displayImages(v).map((ref) => ref.id)))];
  const imageRows = await env.DB.prepare(
    `SELECT a.id,a.metadata_json FROM d1_assets a WHERE a.deleting=0
     AND a.id IN(SELECT value FROM json_each(?))
     AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview')
     AND json_extract(a.metadata_json,'$.mime') IN ('image/png','image/jpeg','image/webp')
     AND EXISTS(SELECT 1 FROM d1_materials m JOIN d1_material_versions v ON v.id=m.current_version_id
       WHERE ${visible} AND ${directDisplay})`,
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
        widthMm: v.widthMm,
        heightMm: v.heightMm,
        depthMm: v.depthMm,
        usage: v.usage,
        installation: v.installation,
        textureAssetIds,
        views,
        ...(legacy && v.coverAssetId && allowed.has(v.coverAssetId) ? { coverAssetId: v.coverAssetId } : {}),
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
  if (requested) {
    if (!placements[0]) throw new D1StorageError(404, '배치할 공용 자재를 찾지 못했어요.');
    return json(placements[0]);
  }
  return json({ placements });
}
