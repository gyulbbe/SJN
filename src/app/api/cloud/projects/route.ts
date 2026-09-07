import { normalizeProjectDocument, projectWriteError } from '@/lib/comparison';
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
import { identifierSchema, projectSchema, storedProjectSchema } from '@/lib/supabase/validation';
import { duplicateProjectDocument } from '@/lib/designs';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const { client, user } = await authenticated(request);
    if (Number(request.headers.get('content-length') ?? 0) > 20 * 1024 * 1024)
      throw new HttpError(413, '프로젝트 문서가 너무 커요.');
    const body = await boundedJson(request);
    switch (body.operation) {
      case 'list': {
        const { data, error } = await client
          .from('projects')
          .select('id,name,updated_at,document')
          .order('updated_at', { ascending: false });
        databaseError(error);
        return NextResponse.json(
          (data ?? []).map((row) => {
            const project = normalizeProjectDocument(storedProjectSchema.parse(row.document));
            const active = project.designs.find((design) => design.id === project.activeDesignId);
            return {
              id: row.id,
              name: row.name,
              updatedAt: row.updated_at,
              thumbnailAssetId: project.thumbnailAssetId,
              previewAssetId: (active?.scene ?? project.shared.baseline).previewAssetId,
              activeDesignId: project.activeDesignId,
              activeDesignRevision: active?.renderRevision ?? active?.revision ?? 0,
              sharedRevision: project.shared.revision,
            };
          }),
        );
      }
      case 'load': {
        const id = identifierSchema.parse(body.id);
        const { data, error } = await client.from('projects').select('document').eq('id', id).maybeSingle();
        databaseError(error);
        if (!data) throw new HttpError(404, '프로젝트를 찾을 수 없어요.');
        return NextResponse.json(normalizeProjectDocument(storedProjectSchema.parse(data.document)));
      }
      case 'create':
      case 'save': {
        const document = normalizeProjectDocument(
          (body.operation === 'create' ? projectSchema : storedProjectSchema).parse(body.document),
        );
        if (body.operation === 'save') {
          const previous = await client
            .from('projects')
            .select('document')
            .eq('id', document.id)
            .maybeSingle();
          databaseError(previous.error);
          if (!previous.data) throw new HttpError(404, '프로젝트를 찾을 수 없어요.');
          const limitError = projectWriteError(
            document,
            normalizeProjectDocument(storedProjectSchema.parse(previous.data.document)),
          );
          if (limitError) throw new HttpError(400, limitError);
        }
        const expected =
          body.operation === 'create'
            ? null
            : z.number().int().nonnegative().parse(body.expectedStorageRevision);
        const { data, error } = await serviceClient().rpc('save_project', {
          actor_id: user.id,
          project_data: { ...document, ownerId: user.id },
          expected_revision: expected,
        });
        databaseError(error);
        return NextResponse.json(data);
      }
      case 'duplicate': {
        const id = identifierSchema.parse(body.id);
        const { data, error } = await client.from('projects').select('document').eq('id', id).maybeSingle();
        databaseError(error);
        if (!data) throw new HttpError(404, '프로젝트를 찾을 수 없어요.');
        const original = normalizeProjectDocument(storedProjectSchema.parse(data.document));
        const document = { ...duplicateProjectDocument(original), ownerId: user.id };
        const limitError = projectWriteError(document);
        if (limitError) throw new HttpError(400, limitError);
        const result = await serviceClient().rpc('save_project', {
          actor_id: user.id,
          project_data: document,
          expected_revision: null,
        });
        databaseError(result.error);
        return NextResponse.json(result.data);
      }
      case 'remove': {
        const id = identifierSchema.parse(body.id);
        const { error } = await serviceClient().rpc('delete_project', { actor_id: user.id, project_id: id });
        databaseError(error);
        return NextResponse.json(null);
      }
      default:
        throw new HttpError(400, '지원하지 않는 프로젝트 작업이에요.');
    }
  } catch (error) {
    return routeError(error);
  }
}
