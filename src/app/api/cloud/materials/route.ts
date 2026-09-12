import { stripLegacyMaterialImages } from '@/lib/material-images';
import { materialReferences } from '@/lib/repositories/references';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  authenticated,
  boundedJson,
  databaseError,
  HttpError,
  routeError,
  serviceClient,
} from '@/lib/supabase/server';
import { identifierSchema, materialInputSchema } from '@/lib/supabase/validation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const { client, user } = await authenticated(request);
    const body = await boundedJson(request);
    switch (body.operation) {
      case 'list': {
        const { data, error } = await client
          .from('materials')
          .select('id,owner_id,current_version_id,active,scope,updated_at')
          .order('updated_at', { ascending: false });
        databaseError(error);
        const ids = (data ?? []).map((row) => row.current_version_id);
        if (!ids.length) return NextResponse.json([]);
        const versions = await client.from('material_versions').select('id,payload').in('id', ids);
        databaseError(versions.error);
        return NextResponse.json(
          (data ?? [])
            .map((row) => ({
              material: {
                id: row.id,
                ownerId: row.owner_id,
                currentVersionId: row.current_version_id,
                active: row.active,
                scope: row.scope,
                updatedAt: row.updated_at,
              },
              version: versions.data?.find((v) => v.id === row.current_version_id)?.payload,
            }))
            .filter((row) => row.version),
        );
      }
      case 'getVersion': {
        const id = identifierSchema.parse(body.id);
        const { data, error } = await client
          .from('material_versions')
          .select('payload')
          .eq('id', id)
          .maybeSingle();
        databaseError(error);
        if (!data) throw new HttpError(404, '자재 버전을 찾을 수 없어요.');
        return NextResponse.json(data.payload);
      }
      case 'create':
      case 'update': {
        const input = stripLegacyMaterialImages(materialInputSchema.parse(body.input));
        const assetIds = materialReferences(input);
        const assets = await client
          .from('assets')
          .select('id,metadata,source_asset_id')
          .in('id', assetIds)
          .eq('deleting', false);
        databaseError(assets.error);
        const byId = new Map((assets.data ?? []).map((asset) => [asset.id, asset]));
        if (assetIds.some((id) => !byId.has(id)))
          throw new HttpError(400, '접근할 수 없는 자산이 포함되어 있어요.');
        const imageIds = [
          input.coverAssetId,
          ...(input.imageAssetIds ?? []),
          ...input.textureAssetIds,
          ...input.views.map((view) => view.assetId),
        ].filter((id): id is string => !!id);
        if (imageIds.some((id) => byId.get(id)?.metadata.kind === 'product-mesh'))
          throw new HttpError(400, '제품 사진에는 이미지 자산이 필요해요.');
        for (const view of input.views)
          if (view.product3d) {
            const mesh = byId.get(view.product3d.meshAssetId);
            const source = byId.get(view.product3d.inputAssetId);
            if (
              mesh?.metadata.kind !== 'product-mesh' ||
              !source ||
              source.metadata.kind === 'product-mesh' ||
              mesh.source_asset_id !== source.id
            )
              throw new HttpError(400, '입체 데이터와 입력 이미지의 연결을 확인해 주세요.');
          }
        const id = body.operation === 'create' ? crypto.randomUUID() : identifierSchema.parse(body.id);
        const expected = body.operation === 'create' ? null : identifierSchema.parse(body.expectedVersionId);
        const { data, error } = await serviceClient().rpc('save_material', {
          actor_id: user.id,
          material_id: id,
          material_data: input,
          expected_version_id: expected,
        });
        databaseError(error);
        return NextResponse.json(data);
      }
      case 'setActive': {
        const id = identifierSchema.parse(body.id);
        const active = z.boolean().parse(body.active);
        const { error } = await serviceClient().rpc('set_material_active', {
          actor_id: user.id,
          material_id: id,
          is_active: active,
        });
        databaseError(error);
        return NextResponse.json(null);
      }
      default:
        throw new HttpError(400, '지원하지 않는 자재 작업이에요.');
    }
  } catch (error) {
    return routeError(error);
  }
}
