import { readCatalog } from './server';
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
