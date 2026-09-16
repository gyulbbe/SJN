import { batch, sql, stamp, type Context } from './database';
import type { D1Actor, D1Bindings } from './types';
import { GRACE_MS, invalid } from './http';

interface CleanupJob {
  object_key: string;
  owner_id: string;
  asset_id: string | null;
  attempts: number;
}
const noAssetReferences = `NOT EXISTS(SELECT 1 FROM d1_project_assets r WHERE r.asset_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM d1_material_assets r WHERE r.asset_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM d1_assets child WHERE child.source_asset_id=a.id)`;
/** Bounded, owner-scoped sweep. Immutable material versions and all their assets are retained. */
export async function cleanup(ctx: Context, body: Record<string, unknown>): Promise<number> {
  if (body.operation !== 'run') throw invalid('지원하지 않는 정리 작업이에요.');
  const cutoff = new Date(Date.now() - GRACE_MS).toISOString();
  await sql(
    ctx,
    'DELETE FROM d1_mutations WHERE rowid IN (SELECT rowid FROM d1_mutations WHERE owner_id=? AND created_at<? LIMIT 200)',
    ctx.actor.id,
    cutoff,
  ).run();
  const candidates = await sql(
    ctx,
    `SELECT a.id FROM d1_assets a WHERE a.owner_id=? AND a.deleting=0
    AND a.created_at<? AND ${noAssetReferences} LIMIT 4`,
    ctx.actor.id,
    cutoff,
  ).all<{ id: string }>();
  for (const { id } of candidates.results) {
    const now = stamp();
    await batch(ctx, [
      sql(
        ctx,
        `UPDATE d1_assets AS a SET deleting=1 WHERE a.id=? AND a.owner_id=?
      AND a.created_at<? AND ${noAssetReferences}`,
        id,
        ctx.actor.id,
        cutoff,
      ),
      sql(
        ctx,
        `INSERT OR IGNORE INTO d1_cleanup_jobs(object_key,owner_id,asset_id,eligible_at,next_attempt_at)
      SELECT object_key,owner_id,id,?,? FROM d1_assets WHERE id=? AND owner_id=? AND deleting=1`,
        now,
        now,
        id,
        ctx.actor.id,
      ),
    ]);
  }
  return sweepJobs(ctx);
}

async function sweepJobs(ctx: Context): Promise<number> {
  const now = stamp();
  const jobs = await sql(
    ctx,
    `SELECT object_key,owner_id,asset_id,attempts FROM d1_cleanup_jobs
    WHERE owner_id=? AND eligible_at<=? AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<?)
    ORDER BY next_attempt_at LIMIT 3`,
    ctx.actor.id,
    now,
    now,
    now,
  ).all<CleanupJob>();
  let removed = 0;
  for (const job of jobs.results) {
    const token = crypto.randomUUID();
    const claimed = await sql(
      ctx,
      `UPDATE d1_cleanup_jobs SET lease_token=?,lease_until=?
      WHERE object_key=? AND owner_id=? AND (lease_until IS NULL OR lease_until<?)`,
      token,
      new Date(Date.now() + 60_000).toISOString(),
      job.object_key,
      ctx.actor.id,
      stamp(),
    ).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      const live = await sql(
        ctx,
        `SELECT 1 AS live WHERE
        EXISTS(SELECT 1 FROM d1_projects WHERE object_key=?) OR
        EXISTS(SELECT 1 FROM d1_material_versions WHERE object_key=?) OR
        EXISTS(SELECT 1 FROM d1_assets WHERE object_key=? AND deleting=0)`,
        job.object_key,
        job.object_key,
        job.object_key,
      ).first();
      if (live) {
        await sql(
          ctx,
          'DELETE FROM d1_cleanup_jobs WHERE object_key=? AND lease_token=?',
          job.object_key,
          token,
        ).run();
        continue;
      }
      const replayed = await sql(
        ctx,
        'SELECT 1 FROM d1_mutations WHERE response_key=? LIMIT 1',
        job.object_key,
      ).first();
      if (replayed) {
        const next = new Date(Date.now() + 60_000).toISOString();
        await sql(
          ctx,
          'UPDATE d1_cleanup_jobs SET next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE object_key=? AND lease_token=?',
          next,
          job.object_key,
          token,
        ).run();
        continue;
      }
      await ctx.env.ASSET_BUCKET.delete(job.object_key);
      await batch(ctx, [
        sql(
          ctx,
          `DELETE FROM d1_assets WHERE id=? AND owner_id=? AND object_key=? AND deleting=1`,
          job.asset_id,
          ctx.actor.id,
          job.object_key,
        ),
        sql(ctx, 'DELETE FROM d1_cleanup_jobs WHERE object_key=? AND lease_token=?', job.object_key, token),
      ]);
      removed++;
    } catch {
      await sql(
        ctx,
        `UPDATE d1_cleanup_jobs SET attempts=attempts+1,lease_token=NULL,lease_until=NULL,next_attempt_at=?
        WHERE object_key=? AND lease_token=?`,
        new Date(Date.now() + Math.min(GRACE_MS, 60_000 * 2 ** Math.min(job.attempts, 10))).toISOString(),
        job.object_key,
        token,
      ).run();
    }
  }
  return removed;
}

/** Schedule with waitUntil after writes. A 15s lease and three jobs leave room for the
 * originating save and authentication within Workers Free's 50 D1 queries/request.
 * No asset reachability scan runs here. */
export async function runD1Maintenance(env: D1Bindings, actor: D1Actor): Promise<void> {
  if (!actor.id) return;
  const ctx: Context = { env, actor };
  try {
    const claimed = await sql(
      ctx,
      `INSERT INTO d1_maintenance(owner_id,next_run_at) VALUES(?,?)
      ON CONFLICT(owner_id) DO UPDATE SET next_run_at=excluded.next_run_at WHERE d1_maintenance.next_run_at<=?`,
      actor.id,
      new Date(Date.now() + 15_000).toISOString(),
      stamp(),
    ).run();
    if (claimed.meta.changes !== 1) return;
    await sql(
      ctx,
      'DELETE FROM d1_mutations WHERE rowid IN (SELECT rowid FROM d1_mutations WHERE owner_id=? AND created_at<? LIMIT 200)',
      actor.id,
      new Date(Date.now() - GRACE_MS).toISOString(),
    ).run();
    await sweepJobs(ctx);
  } catch {
    // Storage maintenance must never invalidate a successfully committed user save.
    // Existing durable jobs are retried on the next maintenance lease or explicit cleanup.
  }
}
