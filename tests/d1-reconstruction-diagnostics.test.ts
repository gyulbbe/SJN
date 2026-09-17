import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { diagnosticArchiveRequest } from '../src/lib/reconstruction/diagnostic-archive-server';
import {
  DIAGNOSTIC_RETENTION,
  type DiagnosticArchiveEntry,
} from '../src/lib/reconstruction/diagnostic-archive-contract';
import type { Context } from '../src/lib/d1/database';
import type { D1Bindings, R2BucketLike } from '../src/lib/d1/types';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
let mf: Miniflare;
let env: D1Bindings;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("test")}}',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'diagnostics-isolated' },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
  env = {
    DB: await mf.getD1Database('DB'),
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
  } as unknown as D1Bindings;
  await applyD1Migrations(env.DB, allD1Migrations);
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
async function account(): Promise<Context> {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
  )
    .bind(id, '진단 회원', id + '@example.test', 1, now, now)
    .run();
  return { env, actor: { id, isAdmin: false } };
}
function entry(index = 0): DiagnosticArchiveEntry {
  return {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    startedAt: new Date(Date.UTC(2026, 8, 17, 0, 0, index)).toISOString(),
    status: 'complete',
    input: { name: '현장.jpg', bytes: 1000, mime: 'image/jpeg' },
    engine: 'cloud-browser-v1',
    projectAnalysis: { summary: { candidates: ['basin', 'toilet'] } },
  };
}
function req(ctx: Context, value?: unknown, headers: Record<string, string> = {}, query = '') {
  return new Request('https://sjn.test/api/reconstruction/diagnostics' + query, {
    method: value === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://sjn.test',
      'X-SJN-User-Id': ctx.actor.id,
      ...headers,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
const save = (ctx: Context, value: unknown) => diagnosticArchiveRequest(ctx, req(ctx, value));
async function read(ctx: Context) {
  const result = await diagnosticArchiveRequest(ctx, req(ctx));
  expect(result.status, await result.clone().text()).toBe(200);
  return (await result.json()).runs as DiagnosticArchiveEntry[];
}
async function row(runId: string) {
  return env.DB.prepare('SELECT * FROM d1_reconstruction_diagnostics WHERE run_id=?')
    .bind(runId)
    .first<{ object_key: string; byte_length: number; owner_id: string }>();
}
function bucketWith(overrides: Partial<R2BucketLike>): R2BucketLike {
  return {
    get: (key) => env.ASSET_BUCKET.get(key),
    head: (key) => env.ASSET_BUCKET.head(key),
    put: (...args) => env.ASSET_BUCKET.put(...args),
    delete: (key) => env.ASSET_BUCKET.delete(key),
    ...overrides,
  };
}
describe('D1/private R2 reconstruction diagnostics', () => {
  it('stores successful and failed JSON in R2 with only metadata in D1 and restores them', async () => {
    const ctx = await account(),
      complete = entry(),
      failed = {
        ...entry(1),
        status: 'failed' as const,
        projectAnalysis: undefined,
        failure: { error: { message: 'invalid model output' } },
      };
    expect((await save(ctx, complete)).status).toBe(200);
    expect((await save(ctx, failed)).status).toBe(200);
    expect(await read(ctx)).toEqual([complete, JSON.parse(JSON.stringify(failed))]);
    const stored = await row(complete.runId);
    expect(stored!.owner_id).toBe(ctx.actor.id);
    expect(stored!.object_key).toMatch(new RegExp('^reconstruction-diagnostics/v1/' + ctx.actor.id + '/'));
    expect(await (await env.ASSET_BUCKET.get(stored!.object_key))!.text()).toBe(JSON.stringify(complete));
  });
  it('never exposes another account archive, even to an administrator', async () => {
    const owner = await account(),
      other = await account();
    other.actor.isAdmin = true;
    const value = entry();
    await save(owner, value);
    expect(await read(other)).toEqual([]);
    expect(
      (await diagnosticArchiveRequest(other, req(other, undefined, {}, '?runId=' + value.runId))).status,
    ).toBe(404);
    expect(
      (await diagnosticArchiveRequest(other, req(other, undefined, {}, '?ownerId=' + owner.actor.id))).status,
    ).toBe(400);
    expect((await save(other, value)).status).toBe(409);
    expect((await row(value.runId))!.owner_id).toBe(owner.actor.id);
  });
  it('requires matching account headers and same-origin mutation requests', async () => {
    const ctx = await account(),
      value = entry();
    expect((await diagnosticArchiveRequest(ctx, req(ctx, value, { 'X-SJN-User-Id': 'other' }))).status).toBe(
      401,
    );
    expect(
      (await diagnosticArchiveRequest(ctx, req(ctx, value, { Origin: 'https://hostile.test' }))).status,
    ).toBe(403);
    const noOrigin = req(ctx, value);
    noOrigin.headers.delete('origin');
    expect((await diagnosticArchiveRequest(ctx, noOrigin)).status).toBe(403);
    expect(await row(value.runId)).toBeNull();
  });
  it('replays identical run IDs without new uploads and rejects conflicting content', async () => {
    const ctx = await account(),
      value = entry();
    expect((await save(ctx, value)).status).toBe(200);
    const initial = await row(value.runId);
    const put = vi.fn<R2BucketLike['put']>();
    const repeat = { ...ctx, env: { ...env, ASSET_BUCKET: bucketWith({ put }) } };
    expect((await save(repeat, value)).status).toBe(200);
    expect(put).not.toHaveBeenCalled();
    expect((await save(ctx, { ...value, status: 'failed', failure: { reason: 'different' } })).status).toBe(
      409,
    );
    expect(await row(value.runId)).toEqual(initial);
  });
  it('serializes concurrent retries to one diagnostic without replacing its object', async () => {
    const ctx = await account(),
      value = entry();
    const results = await Promise.all([save(ctx, value), save(ctx, value), save(ctx, value)]);
    expect(results.map((v) => v.status)).toEqual([200, 200, 200]);
    expect(await read(ctx)).toEqual([value]);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_diagnostic_cleanup WHERE owner_id=?')
        .bind(ctx.actor.id)
        .first(),
    ).toEqual({ n: 0 });
  });
  it('retains 20 per account and keeps a slow newly completed run', async () => {
    const ctx = await account(),
      other = await account(),
      otherValue = entry();
    await save(other, otherValue);
    const values = Array.from({ length: 21 }, (_, i) => entry(i + 1));
    for (const value of values) expect((await save(ctx, value)).status).toBe(200);
    expect((await read(ctx)).map((v) => v.runId)).toEqual(values.slice(1).map((v) => v.runId));
    expect(await row(values[0].runId)).toBeNull();
    const slow = entry();
    expect((await save(ctx, slow)).status).toBe(200);
    const ids = (await read(ctx)).map((v) => v.runId);
    expect(ids).toHaveLength(20);
    expect(ids).toContain(slow.runId);
    expect(ids).not.toContain(values[1].runId);
    expect(await read(other)).toEqual([otherValue]);
  }, 30000);
  it('atomically enforces the 25 MiB UTF-8 budget and removes retired R2 objects', async () => {
    const ctx = await account();
    const evidence = Array.from({ length: 300 }, () => '한'.repeat(16000));
    const first = { ...entry(), projectAnalysis: { evidence } },
      second = { ...entry(1), projectAnalysis: { evidence } };
    expect((await save(ctx, first)).status).toBe(200);
    const key = (await row(first.runId))!.object_key;
    expect((await save(ctx, second)).status).toBe(200);
    expect((await read(ctx)).map((v) => v.runId)).toEqual([second.runId]);
    expect(await env.ASSET_BUCKET.head(key)).toBeNull();
    const total = await env.DB.prepare(
      'SELECT SUM(byte_length) AS bytes FROM d1_reconstruction_diagnostics WHERE owner_id=?',
    )
      .bind(ctx.actor.id)
      .first<{ bytes: number }>();
    expect(total!.bytes).toBeLessThanOrEqual(DIAGNOSTIC_RETENTION.bytes);
  }, 30000);
  it('rejects oversized requests, arbitrary metadata, photos, credentials and deep fields before R2 writes', async () => {
    const ctx = await account(),
      value = entry();
    for (const changed of [
      { ...value, ownerId: 'other' },
      { ...value, failure: { photo: 'data:image/png;base64,AAAA' } },
      { ...value, failure: { accessToken: 'secret' } },
      { ...value, failure: { text: 'x'.repeat(65537) } },
    ])
      expect((await save(ctx, changed)).status).toBe(400);
    const oversized = req(ctx, value, { 'content-length': String(DIAGNOSTIC_RETENTION.bytes + 1) });
    expect((await diagnosticArchiveRequest(ctx, oversized)).status).toBe(413);
    expect(await read(ctx)).toEqual([]);
  });
  it('rejects suspension that occurs after upload but before the atomic D1 commit', async () => {
    const ctx = await account(),
      value = entry();
    const suspended = {
      ...ctx,
      env: {
        ...env,
        ASSET_BUCKET: bucketWith({
          put: async (...args) => {
            const uploaded = await env.ASSET_BUCKET.put(...args);
            await env.DB.prepare("UPDATE d1_user_management SET status='suspended' WHERE user_id=?")
              .bind(ctx.actor.id)
              .run();
            return uploaded;
          },
        }),
      },
    };
    expect((await save(suspended, value)).status).toBe(403);
    expect(await row(value.runId)).toBeNull();
    expect((await diagnosticArchiveRequest(ctx, req(ctx))).status).toBe(403);
  });
  it('preserves existing records when R2 upload or D1 commit fails', async () => {
    const ctx = await account(),
      prior = entry();
    await save(ctx, prior);
    const uploadFailure = {
      ...ctx,
      env: {
        ...env,
        ASSET_BUCKET: bucketWith({
          put: async () => {
            throw new Error('R2 unavailable');
          },
        }),
      },
    };
    expect((await save(uploadFailure, entry(1))).status).toBe(503);
    const databaseFailure = {
      ...ctx,
      env: {
        ...env,
        DB: {
          prepare: (query: string) => env.DB.prepare(query),
          batch: async () => {
            throw new Error('D1 batch rollback');
          },
        },
      },
    };
    expect((await save(databaseFailure, entry(2))).status).toBe(503);
    expect(await read(ctx)).toEqual([prior]);
  });
  it('retries failed cleanup without deleting an unrelated R2 object or a live diagnostic', async () => {
    const ctx = await account(),
      value = entry();
    await save(ctx, value);
    const live = (await row(value.runId))!.object_key;
    const retired = 'reconstruction-diagnostics/v1/' + ctx.actor.id + '/' + crypto.randomUUID() + '.json';
    const unrelated = 'projects/' + ctx.actor.id + '/keep.json';
    for (const key of [retired, unrelated]) await env.ASSET_BUCKET.put(key, 'preserve');
    for (const key of [retired, unrelated, live])
      await env.DB.prepare('INSERT INTO d1_diagnostic_cleanup(object_key,owner_id,eligible_at) VALUES(?,?,?)')
        .bind(key, ctx.actor.id, '2000-01-01')
        .run();
    const broken = {
      ...ctx,
      env: {
        ...env,
        ASSET_BUCKET: bucketWith({
          delete: async () => {
            throw new Error('R2 delete failed');
          },
        }),
      },
    };
    expect(await read(broken)).toEqual([value]);
    expect(await env.ASSET_BUCKET.head(retired)).not.toBeNull();
    expect(await read(ctx)).toEqual([value]);
    expect(await env.ASSET_BUCKET.head(retired)).toBeNull();
    expect(await env.ASSET_BUCKET.head(unrelated)).not.toBeNull();
    expect(await env.ASSET_BUCKET.head(live)).not.toBeNull();
  });
  it('bounds cleanup to six objects per request and resumes the remaining queue next time', async () => {
    const ctx = await account();
    const keys = Array.from(
      { length: 8 },
      () => 'reconstruction-diagnostics/v1/' + ctx.actor.id + '/' + crypto.randomUUID() + '.json',
    );
    for (const key of keys) {
      await env.ASSET_BUCKET.put(key, 'retired diagnostic');
      await env.DB.prepare('INSERT INTO d1_diagnostic_cleanup(object_key,owner_id,eligible_at) VALUES(?,?,?)')
        .bind(key, ctx.actor.id, '2000-01-01')
        .run();
    }
    const remove = vi.fn<R2BucketLike['delete']>((key) => env.ASSET_BUCKET.delete(key));
    const limited = { ...ctx, env: { ...env, ASSET_BUCKET: bucketWith({ delete: remove }) } };
    expect(await read(limited)).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(6);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_diagnostic_cleanup WHERE owner_id=?')
        .bind(ctx.actor.id)
        .first(),
    ).toEqual({ n: 2 });
    expect(await read(limited)).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(8);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_diagnostic_cleanup WHERE owner_id=?')
        .bind(ctx.actor.id)
        .first(),
    ).toEqual({ n: 0 });
  });
  it('reports damaged JSON rather than silently returning or rewriting it', async () => {
    const ctx = await account(),
      value = entry();
    await save(ctx, value);
    const key = (await row(value.runId))!.object_key;
    await env.ASSET_BUCKET.put(key, 'damaged');
    expect((await diagnosticArchiveRequest(ctx, req(ctx))).status).toBe(503);
    expect(await row(value.runId)).not.toBeNull();
  });
});
