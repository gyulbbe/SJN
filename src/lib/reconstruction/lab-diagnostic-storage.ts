import { getRepositoryUserId } from '../repositories';
import {
  DIAGNOSTIC_RETENTION,
  type DiagnosticArchiveEntry,
  type DiagnosticStorageStatus,
} from './diagnostic-archive-contract';
export {
  DIAGNOSTIC_RETENTION,
  type DiagnosticArchiveEntry,
  type DiagnosticStorageStatus,
} from './diagnostic-archive-contract';

const endpoint = '/api/reconstruction/diagnostics';
function accountHeaders(userId: string) {
  if (!userId) throw new Error('로그인 계정을 확인한 뒤 진단 기록을 보관해 주세요.');
  return { 'Content-Type': 'application/json', 'X-SJN-User-Id': userId };
}
async function responseValue(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '진단 보관함에 연결하지 못했어요.');
  return value;
}

/** D1 metadata and private R2 JSON; old browser diagnostic databases are never opened or migrated. */
export async function saveDiagnosticArchive(
  entry: DiagnosticArchiveEntry,
  userId = getRepositoryUserId(),
): Promise<DiagnosticStorageStatus> {
  try {
    const headers = accountHeaders(userId);
    const body = JSON.stringify(entry);
    if (new TextEncoder().encode(body).byteLength > DIAGNOSTIC_RETENTION.bytes)
      throw new Error('단일 진단이 25MB를 넘어 자동 보관하지 못했어요. 현재 전체 보고서를 내려받아 주세요.');
    await responseValue(
      await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
      }),
    );
    return { stored: true };
  } catch (error) {
    return { stored: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
export async function readDiagnosticArchive(
  userId = getRepositoryUserId(),
): Promise<DiagnosticArchiveEntry[]> {
  const headers = accountHeaders(userId);
  const value = await responseValue(
    await fetch(endpoint, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      signal: AbortSignal.timeout(30_000),
    }),
  );
  if (!Array.isArray(value.runs)) throw new Error('진단 보관함 응답을 읽지 못했어요.');
  return value.runs;
}
