import { assetMetadataSchema, identifierSchema } from '../storage/validation';
import {
  assetAssertion,
  dataOwnerId,
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
import { LIST_IMAGE_MAX_EDGE, LIST_IMAGE_OF, listImageOf } from './list-images';

export async function assets(ctx: Context, request: Request): Promise<Response> {
  if (request.method === 'GET') {
    const url = new URL(request.url),
      id = identifierSchema.parse(url.searchParams.get('id'));
    const size = url.searchParams.get('size');
    if (size !== null && (size !== 'list' || url.searchParams.get('raw') !== '1'))
      throw invalid('이미지 크기 요청을 확인해 주세요.');
    let row = await readableAsset(ctx, id);
    // A card's list image: the source is authorized above; its small copy is sent in its place.
    let listed = false;
    if (size === 'list') {
      const list = await listImageOf(ctx.env.DB, id);
      if (list) {
        row = { ...row, object_key: list.object_key, metadata_json: list.metadata_json };
        listed = true;
      }
    }
    const metadata = JSON.parse(row.metadata_json);
    if (url.searchParams.get('raw') !== '1')
      return json({
        asset: metadata,
        contentHash: row.content_hash,
        url: ctx.adminProject
          ? `/api/admin/project-assets?projectId=${encodeURIComponent(ctx.adminProject.id)}&id=${encodeURIComponent(id)}&raw=1`
          : `/api/d1/assets?id=${encodeURIComponent(id)}&raw=1`,
      });
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
        ...(size === 'list' ? { 'X-SJN-List-Image': listed ? '1' : '0' } : {}),
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
  // The 360° editor is gone: an older mesh asset is only read (docs/product3d-removal.md), never made.
  if (input.kind === 'product-mesh') throw invalid('360° 입체 형상은 더 이상 저장하지 않아요.');
  const listImage = 'derivation' in input && input.derivation === 'list';
  if (listImage && (input.kind !== 'thumbnail' || !input.sourceAssetId))
    throw invalid('목록 이미지는 원본 이미지에서 만든 썸네일이어야 해요.');
  const format = validateD1Image(bytes);
  if (listImage && Math.max(format.width, format.height) > LIST_IMAGE_MAX_EDGE)
    throw invalid('목록 이미지가 너무 커요.');
  // Metadata is server-derived. A claimed MIME never chooses the decoder or response Content-Type.
  const contentHash = await hash(bytes);
  const metadata = { ...input, ...format, ownerId: dataOwnerId(ctx), size: bytes.length, createdAt: stamp() };
  const existing = await sql(ctx, 'SELECT * FROM d1_assets WHERE id=?', input.id).first<AssetRow>();
  if (existing) {
    if (ctx.adminProject) await readableAsset(ctx, input.id);
    if (existing.owner_id !== dataOwnerId(ctx)) throw notFound();
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
  const key = `assets/${encodeURIComponent(dataOwnerId(ctx))}/${input.id}/${crypto.randomUUID()}`;
  await stageObject(ctx, key, bytes, format.mime, input.id);
  try {
    await batch(ctx, [
      assertion(ctx, 'conflict', 'NOT EXISTS(SELECT 1 FROM d1_assets WHERE id=?)', input.id),
      // One list image per source: a second one (another tab, a retried backfill) is a conflict.
      ...(listImage ? [assertion(ctx, 'conflict', `NOT EXISTS(${LIST_IMAGE_OF})`, input.sourceAssetId)] : []),
      assetAssertion(ctx, referenceJson(input.sourceAssetId ? [input.sourceAssetId] : [])),
      sql(
        ctx,
        `INSERT INTO d1_assets(id,owner_id,object_key,source_asset_id,metadata_json,content_hash,created_at)
        VALUES(?,?,?,?,?,?,?)`,
        input.id,
        dataOwnerId(ctx),
        key,
        input.sourceAssetId ?? null,
        JSON.stringify(metadata),
        contentHash,
        metadata.createdAt,
      ),
      ...(ctx.adminProject
        ? [
            sql(
              ctx,
              'INSERT INTO d1_admin_project_assets(project_id,asset_id,actor_id,created_at) VALUES(?,?,?,?)',
              ctx.adminProject.id,
              input.id,
              ctx.actor.id,
              stamp(),
            ),
          ]
        : []),
      committedObject(ctx, key),
    ]);
  } catch (error) {
    const committed = await sql(
      ctx,
      'SELECT * FROM d1_assets WHERE id=? AND owner_id=?',
      input.id,
      dataOwnerId(ctx),
    ).first<AssetRow>();
    if (committed && !committed.deleting && committed.content_hash === contentHash) {
      if (ctx.adminProject) await readableAsset(ctx, input.id);
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
