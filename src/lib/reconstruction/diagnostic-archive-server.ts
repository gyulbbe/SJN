import type { Context } from '../d1/database';
import { sql } from '../d1/database';
import { boundedBytes, D1StorageError, errorResponse, hash, invalid, json } from '../d1/http';
import {
  DIAGNOSTIC_RETENTION,
  parseDiagnosticArchive,
  type DiagnosticArchiveEntry,
} from './diagnostic-archive-contract';

type Row = {
  run_id: string;
  owner_id: string;
  object_key: string;
  content_hash: string;
  byte_length: number;
  started_at: string;
};
const prefix = (owner: string) => 'reconstruction-diagnostics/v1/' + owner + '/';
function safeKey(owner: string, key: string) {
  return key.startsWith(prefix(owner)) && /^[0-9a-f-]{36}\.json$/.test(key.slice(prefix(owner).length));
}
async function requireActive(ctx: Context) {
  const row = await sql(ctx, 'SELECT status FROM d1_user_management WHERE user_id=?', ctx.actor.id).first<{
    status: string;
  }>();
  if (row?.status !== 'active')
    throw new D1StorageError(
      403,
      '활성 로그인 계정에서만 진단 기록을 사용할 수 있어요.',
      'account_suspended',
    );
}
async function cleanup(ctx: Context) {
  // Bound per-request D1/R2 work; the durable queue continues on later account requests.
  const rows = await sql(
    ctx,
    'SELECT object_key FROM d1_diagnostic_cleanup WHERE owner_id=? AND eligible_at<=? LIMIT 6',
    ctx.actor.id,
    new Date().toISOString(),
  ).all<{ object_key: string }>();
  for (const row of rows.results) {
    if (!safeKey(ctx.actor.id, row.object_key)) continue;
    const referenced = await sql(
      ctx,
      'SELECT run_id FROM d1_reconstruction_diagnostics WHERE object_key=?',
      row.object_key,
    ).first();
    if (referenced) continue;
    try {
      await ctx.env.ASSET_BUCKET.delete(row.object_key);
      await sql(
        ctx,
        'DELETE FROM d1_diagnostic_cleanup WHERE owner_id=? AND object_key=?',
        ctx.actor.id,
        row.object_key,
      ).run();
    } catch {
      /* Durable queue retries on the account's next archive request. */
    }
  }
}
async function bestEffortCleanup(ctx: Context) {
  try {
    await cleanup(ctx);
  } catch {
    /* A maintenance failure never undoes the confirmed archive. */
  }
}
async function readEntry(ctx: Context, row: Row): Promise<DiagnosticArchiveEntry> {
  if (!safeKey(ctx.actor.id, row.object_key)) throw new Error('Invalid diagnostic object key');
  const object = await ctx.env.ASSET_BUCKET.get(row.object_key);
  if (!object || object.size !== row.byte_length || object.size > DIAGNOSTIC_RETENTION.bytes)
    throw new Error('Diagnostic body unavailable');
  const text = await object.text();
  if ((await hash(text)) !== row.content_hash) throw new Error('Diagnostic body damaged');
  const entry = parseDiagnosticArchive(JSON.parse(text));
  if (entry.runId !== row.run_id) throw new Error('Diagnostic identity mismatch');
  return entry;
}
async function list(ctx: Context, request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== 'runId')) throw invalid('진단 조회 조건을 확인해 주세요.');
  const runId = params.get('runId');
  if (runId && !/^[0-9a-f-]{36}$/i.test(runId)) throw invalid('진단 실행 ID를 확인해 주세요.');
  const rows = await sql(
    ctx,
    'SELECT * FROM d1_reconstruction_diagnostics WHERE owner_id=?' +
      (runId ? ' AND run_id=?' : '') +
      ' ORDER BY started_at,run_id LIMIT 20',
    ctx.actor.id,
    ...(runId ? [runId] : []),
  ).all<Row>();
  if (runId && !rows.results.length) throw new D1StorageError(404, '해당 진단 기록을 찾지 못했어요.');
  const runs: DiagnosticArchiveEntry[] = [];
  let bytes = 0;
  for (const row of rows.results) {
    bytes += row.byte_length;
    if (bytes > DIAGNOSTIC_RETENTION.bytes) throw new Error('Diagnostic quota is inconsistent');
    runs.push(await readEntry(ctx, row));
  }
  await bestEffortCleanup(ctx);
  return json({ runs });
}
async function save(ctx: Context, request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw invalid('JSON 진단 기록을 보내 주세요.');
  let entry: DiagnosticArchiveEntry;
  const bytes = await boundedBytes(request, DIAGNOSTIC_RETENTION.bytes);
  try {
    entry = parseDiagnosticArchive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw invalid('진단 형식·항목 길이를 확인해 주세요. 사진 본문이나 인증 정보는 보관할 수 없어요.');
  }
  const text = JSON.stringify(entry),
    length = new TextEncoder().encode(text).byteLength;
  if (length > DIAGNOSTIC_RETENTION.bytes) throw new D1StorageError(413, '진단 기록은 25MB 이하여야 해요.');
  const digest = await hash(text);
  const previous = await sql(
    ctx,
    'SELECT * FROM d1_reconstruction_diagnostics WHERE run_id=?',
    entry.runId,
  ).first<Row>();
  if (previous) {
    if (previous.owner_id !== ctx.actor.id || previous.content_hash !== digest)
      throw new D1StorageError(409, '이미 저장된 실행 ID예요. 기존 진단 기록은 보존했어요.');
    await readEntry(ctx, previous);
    await bestEffortCleanup(ctx);
    return json({ stored: true });
  }
  const key = prefix(ctx.actor.id) + crypto.randomUUID() + '.json';
  const now = new Date().toISOString();
  // A crash during R2 upload/DB commit leaves only a scoped, retryable cleanup record.
  await sql(
    ctx,
    'INSERT INTO d1_diagnostic_cleanup(object_key,owner_id,eligible_at) VALUES(?,?,?)',
    key,
    ctx.actor.id,
    new Date(Date.now() + 3600000).toISOString(),
  ).run();
  await ctx.env.ASSET_BUCKET.put(key, text, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  const retired = `WITH ranked AS (
    SELECT run_id,object_key,ROW_NUMBER() OVER(ORDER BY CASE WHEN run_id=? THEN 0 ELSE 1 END,started_at DESC,run_id) AS n,
    SUM(byte_length) OVER(ORDER BY CASE WHEN run_id=? THEN 0 ELSE 1 END,started_at DESC,run_id ROWS UNBOUNDED PRECEDING) AS bytes
    FROM d1_reconstruction_diagnostics WHERE owner_id=?
  ) SELECT object_key FROM ranked WHERE n>? OR bytes>?`;
  const retiredValues = [
    entry.runId,
    entry.runId,
    ctx.actor.id,
    DIAGNOSTIC_RETENTION.runs,
    DIAGNOSTIC_RETENTION.bytes,
  ];
  await ctx.env.DB.batch([
    sql(
      ctx,
      "INSERT INTO d1_diagnostic_checks(id,active_ok,conflict_ok) SELECT ?,EXISTS(SELECT 1 FROM d1_user_management WHERE user_id=? AND status='active'),NOT EXISTS(SELECT 1 FROM d1_reconstruction_diagnostics WHERE run_id=? AND (owner_id<>? OR content_hash<>?))",
      crypto.randomUUID(),
      ctx.actor.id,
      entry.runId,
      ctx.actor.id,
      digest,
    ),
    sql(
      ctx,
      'INSERT OR IGNORE INTO d1_reconstruction_diagnostics(run_id,owner_id,object_key,content_hash,byte_length,started_at,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      entry.runId,
      ctx.actor.id,
      key,
      digest,
      length,
      entry.startedAt,
      entry.status,
      now,
    ),
    sql(
      ctx,
      'INSERT OR IGNORE INTO d1_diagnostic_cleanup(object_key,owner_id,eligible_at) SELECT object_key,?,? FROM (' +
        retired +
        ')',
      ctx.actor.id,
      now,
      ...retiredValues,
    ),
    sql(
      ctx,
      'DELETE FROM d1_reconstruction_diagnostics WHERE object_key IN (' + retired + ')',
      ...retiredValues,
    ),
    sql(
      ctx,
      'DELETE FROM d1_diagnostic_cleanup WHERE owner_id=? AND object_key IN (SELECT object_key FROM d1_reconstruction_diagnostics WHERE owner_id=?)',
      ctx.actor.id,
      ctx.actor.id,
    ),
    sql(ctx, 'DELETE FROM d1_diagnostic_checks'),
  ]);
  // A concurrent identical retry may have committed another unique object first.
  await sql(
    ctx,
    'UPDATE d1_diagnostic_cleanup SET eligible_at=? WHERE owner_id=? AND object_key=?',
    now,
    ctx.actor.id,
    key,
  )
    .run()
    .catch(() => {});
  await bestEffortCleanup(ctx);
  return json({ stored: true });
}

/** The route supplies a verified actor; all rows/objects stay scoped to that account. */
export async function diagnosticArchiveRequest(ctx: Context, request: Request): Promise<Response> {
  try {
    if (!ctx.actor.id) throw new D1StorageError(401, '로그인이 필요해요.');
    if (request.headers.get('X-SJN-User-Id') !== ctx.actor.id)
      throw new D1StorageError(401, '분석을 시작한 계정과 현재 계정이 달라요.', 'ACCOUNT_CHANGED');
    if (
      request.method === 'POST' &&
      (request.headers.get('origin') !== new URL(request.url).origin ||
        request.headers.get('sec-fetch-site') === 'cross-site')
    )
      throw new D1StorageError(403, '허용되지 않은 요청 출처예요.');
    await requireActive(ctx);
    if (request.method === 'GET') return await list(ctx, request);
    if (request.method === 'POST') return await save(ctx, request);
    throw new D1StorageError(405, '지원하지 않는 요청 방식이에요.');
  } catch (error) {
    if (error instanceof Error && error.message.includes('diagnostic_active'))
      return errorResponse(
        new D1StorageError(403, '이용 정지된 계정은 기록을 저장할 수 없어요.', 'account_suspended'),
      );
    if (error instanceof Error && error.message.includes('diagnostic_conflict'))
      return errorResponse(new D1StorageError(409, '실행 ID가 다른 기록에서 이미 사용됐어요.'));
    return errorResponse(error);
  }
}
