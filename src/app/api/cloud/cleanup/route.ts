import { NextResponse } from 'next/server';
import {
  authenticated,
  boundedJson,
  databaseError,
  HttpError,
  routeError,
  serviceClient,
} from '@/lib/supabase/server';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const { user } = await authenticated(request);
    const body = await boundedJson(request);
    if (body.operation !== 'run') throw new HttpError(400, '지원하지 않는 정리 작업이에요.');
    const admin = serviceClient();
    const prepared = await admin.rpc('prepare_asset_cleanup', { actor_id: user.id });
    databaseError(prepared.error);
    const jobs = await admin.rpc('claim_asset_cleanup', { actor_id: user.id });
    databaseError(jobs.error);
    let removed = 0;
    for (const job of (jobs.data ?? []) as {
      id: string;
      object_path: string;
      asset_id: string;
      attempts: number;
    }[]) {
      // A successful upload may have committed just before retry; only deleting/unregistered objects qualify.
      const asset = await admin
        .from('assets')
        .select('deleting')
        .eq('id', job.asset_id)
        .eq('owner_id', user.id)
        .eq('object_path', job.object_path)
        .maybeSingle();
      databaseError(asset.error);
      if (asset.data && !asset.data.deleting) {
        await admin.from('cleanup_jobs').delete().eq('id', job.id);
        continue;
      }
      const result = await admin.storage.from('scene-assets').remove([job.object_path]);
      if (result.error) {
        await admin
          .from('cleanup_jobs')
          .update({
            attempts: job.attempts + 1,
            next_attempt_at: new Date(
              Date.now() + Math.min(86400, 60 * 2 ** Math.min(job.attempts, 10)) * 1000,
            ).toISOString(),
          })
          .eq('id', job.id);
        continue;
      }
      const finalized = await admin.rpc('finish_asset_cleanup', { actor_id: user.id, job_id: job.id });
      databaseError(finalized.error);
      removed++;
    }
    return NextResponse.json(removed);
  } catch (error) {
    return routeError(error);
  }
}
