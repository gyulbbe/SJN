import { ZodError } from 'zod';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const GRACE_MS = 24 * 60 * 60 * 1000;
export class D1StorageError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'STORAGE_ERROR',
  ) {
    super(message);
  }
}
export const conflict = () =>
  new D1StorageError(409, '저장된 버전이 변경됐어요. 현재 작업을 보존한 뒤 다시 열어 주세요.', 'CONFLICT');
export const notFound = () => new D1StorageError(404, '자료를 찾을 수 없어요.', 'NOT_FOUND');
export const invalid = (message = '자료 형식이나 연결된 자산을 확인해 주세요.') =>
  new D1StorageError(400, message, 'INVALID_INPUT');
export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof D1StorageError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError)
    return json({ error: '입력 형식이나 범위를 확인해 주세요.', code: 'INVALID_INPUT' }, 400);
  const detail = error instanceof Error ? error.message : '';
  if (/d1_conflict|UNIQUE constraint failed/.test(detail)) return errorResponse(conflict());
  if (/d1_reference|FOREIGN KEY constraint failed/.test(detail)) return errorResponse(invalid());
  return json(
    {
      error: '서버 저장에 실패했어요. 현재 작업을 보존하고 다시 시도해 주세요.',
      code: 'STORAGE_UNAVAILABLE',
    },
    503,
  );
}
export async function boundedBytes(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit)
    throw new D1StorageError(413, '요청이 너무 커요.', 'TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new D1StorageError(413, '요청이 너무 커요.', 'TOO_LARGE');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
export async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(request, MAX_DOCUMENT_BYTES)),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export async function hash(bytes: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
export function boundedDocument(value: unknown): string {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_DOCUMENT_BYTES)
    throw new D1StorageError(413, '프로젝트 문서는 20MB 이하여야 해요.', 'TOO_LARGE');
  return text;
}
