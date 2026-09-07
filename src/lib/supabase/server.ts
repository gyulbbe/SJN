import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function boundedBody(
  request: Request,
  limit = 20 * 1024 * 1024,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, '요청이 너무 커요.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function boundedJson(request: Request) {
  return JSON.parse(new TextDecoder().decode(await boundedBody(request)));
}
export async function authenticated(request: Request) {
  if (process.env.NEXT_PUBLIC_STORAGE_MODE !== 'supabase')
    throw new HttpError(503, '서버 저장 모드가 꺼져 있어요.');
  const origin = request.headers.get('origin');
  if (request.method !== 'GET' && origin && origin !== new URL(request.url).origin)
    throw new HttpError(403, '허용되지 않은 요청 출처예요.');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new HttpError(503, '서버 저장 설정이 완료되지 않았어요.');
  const cookieStore = await cookies();
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        for (const { name, value, options } of values) cookieStore.set(name, value, options);
      },
    },
  });
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) throw new HttpError(401, '로그인이 필요해요.');
  return { client, user };
}
export function serviceClient() {
  // This module is imported exclusively by Node route handlers. Never import it from a client component.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new HttpError(503, '서버 전용 Supabase key가 설정되지 않았어요.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
export function databaseError(error: { code?: string; message: string } | null) {
  if (!error) return;
  if (error.code === '40001' || error.code === '23505')
    throw new HttpError(409, '저장된 버전이 변경되었어요. 현재 작업을 보존한 뒤 새로 열어 주세요.');
  if (error.code === '42501') throw new HttpError(403, '이 자료를 변경할 권한이 없어요.');
  if (error.code === 'P0002') throw new HttpError(404, '자료를 찾을 수 없어요.');
  if (error.code === '23503' || error.code === '23514' || error.code === '22023')
    throw new HttpError(400, '참조한 자재나 이미지가 없거나 사용할 수 없어요.');
  throw new HttpError(500, '서버 저장에 실패했어요. 현재 작업을 보존하고 다시 시도해 주세요.');
}
export function routeError(error: unknown) {
  if (error instanceof ZodError)
    return NextResponse.json({ error: '입력 형식이나 범위를 확인해 주세요.' }, { status: 400 });
  if (error instanceof HttpError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError)
    return NextResponse.json({ error: '잘못된 요청 형식이에요.' }, { status: 400 });
  return NextResponse.json(
    { error: '요청을 처리하지 못했어요. 현재 작업을 보존하고 다시 시도해 주세요.' },
    { status: 500 },
  );
}
