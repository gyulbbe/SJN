import { assetMetadataSchema, identifierSchema } from '../supabase/validation';
import { decodeProductMesh, PRODUCT_MESH_MIME } from '../product3d/codec';
import {
  assetAssertion,
  assertion,
  batch,
  committedObject,
  readableAsset,
  referenceJson,
  sql,
  stageObject,
  stamp,
  type AssetRow,
  type Context,
} from './database';
import {
  boundedBytes,
  conflict,
  D1StorageError,
  hash,
  invalid,
  json,
  MAX_ASSET_BYTES,
  notFound,
} from './http';
import { validateD1Image } from './images';

export async function assets(ctx: Context, request: Request): Promise<Response> {
  if (request.method === 'GET') {
    const url = new URL(request.url),
      id = identifierSchema.parse(url.searchParams.get('id'));
    const row = await readableAsset(ctx, id);
    const metadata = JSON.parse(row.metadata_json);
    if (url.searchParams.get('raw') !== '1')
      return json({ asset: metadata, url: `/api/d1/assets?id=${encodeURIComponent(id)}&raw=1` });
    const object = await ctx.env.ASSET_BUCKET.get(row.object_key);
    if (!object)
      throw new D1StorageError(
        503,
        '이미지 파일을 읽지 못했어요. 다시 시도해 주세요.',
        'STORAGE_UNAVAILABLE',
      );
    return new Response(object.body, {
      headers: {
        'Content-Type': metadata.mime,
        'Content-Length': String(object.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      },
    });
  }
  if (request.method !== 'POST')
    throw new D1StorageError(405, '지원하지 않는 요청 방식이에요.', 'METHOD_NOT_ALLOWED');
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;'))
    throw invalid('업로드 형식을 확인해 주세요.');
  const form = await new Response(await boundedBytes(request, MAX_ASSET_BYTES + 1024 * 1024), {
    headers: { 'Content-Type': contentType },
  }).formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size || file.size > MAX_ASSET_BYTES)
    throw new D1StorageError(413, '파일은 25MB 이하여야 해요.', 'TOO_LARGE');
  const metadataValue = form.get('metadata');
  if (typeof metadataValue !== 'string' || metadataValue.length > 16000) throw invalid();
  const input = assetMetadataSchema.parse(JSON.parse(metadataValue));
  if (input.sourceAssetId === input.id) throw invalid('원본 이미지 연결이 순환해요.');
  if (input.sourceAssetId) {
    const source = JSON.parse((await readableAsset(ctx, input.sourceAssetId)).metadata_json);
    if (source.kind === 'product-mesh') throw invalid('파생 자산의 원본은 이미지여야 해요.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let format: { mime: string; width?: number; height?: number };
  if (input.kind === 'product-mesh') {
    try {
      await decodeProductMesh(new Blob([bytes], { type: PRODUCT_MESH_MIME }));
    } catch {
      throw invalid('입체 데이터가 손상됐거나 지원하지 않는 형식이에요.');
    }
    format = { mime: PRODUCT_MESH_MIME };
  } else format = validateD1Image(bytes);
  // Metadata is server-derived. A claimed MIME never chooses the decoder or response Content-Type.
  const contentHash = await hash(bytes);
  const metadata = { ...input, ...format, ownerId: ctx.actor.id, size: bytes.length, createdAt: stamp() };
  const existing = await sql(ctx, 'SELECT * FROM d1_assets WHERE id=?', input.id).first<AssetRow>();
  if (existing) {
    if (existing.owner_id !== ctx.actor.id) throw notFound();
    const old = JSON.parse(existing.metadata_json);
    if (
      existing.deleting ||
      existing.content_hash !== contentHash ||
      old.kind !== input.kind ||
      old.name !== input.name ||
      old.sourceAssetId !== input.sourceAssetId ||
      old.derivation !== ('derivation' in input ? input.derivation : undefined)
    )
      throw conflict();
    return json(null);
  }
  const key = `assets/${encodeURIComponent(ctx.actor.id)}/${input.id}/${crypto.randomUUID()}`;
  await stageObject(ctx, key, bytes, format.mime, input.id);
  try {
    await batch(ctx, [
      assertion(ctx, 'conflict', 'NOT EXISTS(SELECT 1 FROM d1_assets WHERE id=?)', input.id),
      assetAssertion(ctx, referenceJson(input.sourceAssetId ? [input.sourceAssetId] : [])),
      sql(
        ctx,
        `INSERT INTO d1_assets(id,owner_id,object_key,source_asset_id,metadata_json,content_hash,created_at)
        VALUES(?,?,?,?,?,?,?)`,
        input.id,
        ctx.actor.id,
        key,
        input.sourceAssetId ?? null,
        JSON.stringify(metadata),
        contentHash,
        metadata.createdAt,
      ),
      committedObject(ctx, key),
    ]);
  } catch (error) {
    const committed = await sql(
      ctx,
      'SELECT * FROM d1_assets WHERE id=? AND owner_id=?',
      input.id,
      ctx.actor.id,
    ).first<AssetRow>();
    if (committed && !committed.deleting && committed.content_hash === contentHash) {
      const old = JSON.parse(committed.metadata_json);
      if (
        old.name === input.name &&
        old.kind === input.kind &&
        old.sourceAssetId === input.sourceAssetId &&
        old.derivation === ('derivation' in input ? input.derivation : undefined)
      )
        return json(null);
    }
    throw error;
  }
  return json(null);
}
