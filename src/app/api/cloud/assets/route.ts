import { NextResponse } from 'next/server';
import sharp, { type Metadata } from 'sharp';
import {
  authenticated,
  boundedBody,
  databaseError,
  HttpError,
  routeError,
  serviceClient,
} from '@/lib/supabase/server';
import { assetMetadataSchema, identifierSchema } from '@/lib/supabase/validation';
const BUCKET = 'scene-assets';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const { client } = await authenticated(request);
    const id = identifierSchema.parse(new URL(request.url).searchParams.get('id'));
    const { data, error } = await client
      .from('assets')
      .select('metadata,object_path')
      .eq('id', id)
      .eq('deleting', false)
      .maybeSingle();
    databaseError(error);
    if (!data) throw new HttpError(404, '이미지를 찾을 수 없어요.');
    const signed = await client.storage.from(BUCKET).createSignedUrl(data.object_path, 120);
    databaseError(signed.error);
    return NextResponse.json(
      { asset: data.metadata, url: signed.data?.signedUrl },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return routeError(error);
  }
}
export async function POST(request: Request) {
  try {
    const { user } = await authenticated(request);
    if (Number(request.headers.get('content-length') ?? 0) > 26 * 1024 * 1024)
      throw new HttpError(413, '파일은 25MB 이하여야 해요.');
    const body = await boundedBody(request, 26 * 1024 * 1024);
    const form = await new Response(body, {
      headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
    }).formData();
    const file = form.get('file');
    if (!(file instanceof File) || !file.size || file.size > 25 * 1024 * 1024)
      throw new HttpError(413, '파일은 25MB 이하여야 해요.');
    const input = assetMetadataSchema.parse(JSON.parse(String(form.get('metadata'))));
    const bytes = Buffer.from(await file.arrayBuffer());
    let metadata: Metadata;
    try {
      metadata = await sharp(bytes, {
        limitInputPixels: 40_000_000,
        failOn: 'warning',
        animated: false,
      }).metadata();
    } catch {
      throw new HttpError(400, '손상되었거나 너무 큰 이미지예요.');
    }
    const formats: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const mime = formats[metadata.format ?? ''];
    if (
      !mime ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 40_000_000 ||
      (metadata.pages ?? 1) > 1
    )
      throw new HttpError(400, '정지 JPG·PNG·WebP 이미지만 지원해요 (최대 4천만 화소).');
    // A complete decode rejects truncated files and image headers hiding invalid pixel data.
    try {
      await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' }).stats();
    } catch {
      throw new HttpError(400, '이미지 픽셀을 읽지 못했어요.');
    }
    const admin = serviceClient();
    const path = `${user.id}/${input.id}`;
    const existing = await admin.from('assets').select('id').eq('id', input.id).maybeSingle();
    databaseError(existing.error);
    if (existing.data)
      throw new HttpError(409, '이미 등록된 이미지 식별자예요. 새 파일로 다시 등록해 주세요.');
    const swapped = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
    const asset = {
      ...input,
      ownerId: user.id,
      mime,
      size: bytes.length,
      width: swapped ? metadata.height : metadata.width,
      height: swapped ? metadata.width : metadata.height,
      createdAt: new Date().toISOString(),
    };
    // Record cleanup intent before uploading. A process crash still leaves a retryable job.
    const job = await admin
      .from('cleanup_jobs')
      .insert({ owner_id: user.id, object_path: path, asset_id: input.id, reason: 'uncommitted-upload' })
      .select('id')
      .single();
    databaseError(job.error);
    const uploaded = await admin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: false });
    if (uploaded.error) {
      // Preserve intent on an uncertain upload result. Cleanup checks whether a
      // registered, live object exists before removing anything at this path.
      throw new HttpError(409, '업로드하지 못했어요. 연결이나 중복 파일을 확인해 주세요.');
    }
    const committed = await admin.rpc('register_asset', {
      actor_id: user.id,
      asset_data: asset,
      path,
      job_id: job.data!.id,
    });
    databaseError(committed.error);
    return NextResponse.json(null);
  } catch (error) {
    return routeError(error);
  }
}
