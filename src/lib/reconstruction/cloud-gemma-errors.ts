import type { CloudGemmaErrorCode } from './cloud-gemma-contract';

export class CloudGemmaError extends Error {
  constructor(
    message: string,
    readonly code: CloudGemmaErrorCode,
    readonly status: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CloudGemmaError';
  }
}
export function parseCloudRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : undefined;
}
/** Internal 3036 is daily quota, whereas 3040 is transient capacity. Never retry quota/auth/input. */
export function classifyCloudGemmaFailure(
  status: number,
  detail: unknown,
  retryAfter: string | null = null,
): CloudGemmaError {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? '');
  const retryAfterMs = parseCloudRetryAfter(retryAfter);
  if (
    /\b3036\b|daily.*(?:limit|allocation|quota)|quota.*(?:exhaust|exceed)|insufficient.*(?:credit|balance|quota)|billing[_ -].*limit|spend.*limit|credit.*exhaust/i.test(
      text,
    ) ||
    status === 402
  )
    return new CloudGemmaError(
      'Cloudflare AI 사용 한도를 모두 사용했어요. 한도가 갱신된 뒤 다시 시도해 주세요.',
      'quota_exhausted',
      429,
    );
  if ([401, 403].includes(status) || /\b(?:3023|3041|5016|5018|5035)\b/.test(text))
    return new CloudGemmaError(
      'Cloudflare AI 인증 또는 모델 사용 권한을 확인해야 해요.',
      'authentication_required',
      403,
    );
  if ([400, 404, 405, 413, 422].includes(status) || /\b(?:3003|3006|5004|5007)\b/.test(text))
    return new CloudGemmaError(
      'Cloudflare AI가 입력 형식이나 모델 설정을 허용하지 않았어요.',
      'invalid_input',
      400,
    );
  if (status === 429 || /\b3040\b/.test(text))
    return new CloudGemmaError(
      'Cloudflare AI가 잠시 혼잡해요. 잠시 뒤 이 단계부터 다시 시도해 주세요.',
      'rate_limited',
      429,
      true,
      retryAfterMs,
    );
  if (status === 503)
    return new CloudGemmaError(
      'Cloudflare AI가 잠시 응답하지 않아요.',
      'unavailable',
      503,
      true,
      retryAfterMs,
    );
  if ([408, 504].includes(status) || /\b3007\b/.test(text))
    return new CloudGemmaError('Cloudflare AI 응답 시간이 초과되었어요.', 'timeout', 504);
  return new CloudGemmaError(
    'Cloudflare AI 요청을 완료하지 못했어요. 이 단계부터 다시 시도해 주세요.',
    'unavailable',
    502,
  );
}
export function cloudGemmaErrorResponse(error: unknown, signal?: AbortSignal): Response {
  const failure = signal?.aborted
    ? new CloudGemmaError('설비 분석을 취소했어요.', 'cancelled', 499)
    : error instanceof CloudGemmaError
      ? error
      : new CloudGemmaError('설비 분석 요청을 처리하지 못했어요.', 'invalid_response', 502);
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (failure.retryAfterMs !== undefined)
    headers.set('Retry-After', String(Math.ceil(failure.retryAfterMs / 1000)));
  return Response.json(
    {
      error: failure.message,
      code: failure.code,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
      diagnostics: failure.diagnostics,
    },
    { status: failure.status, headers },
  );
}

function sanitizedProviderText(value: string, limit: number): string {
  return (
    value
      .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[image redacted]')
      // Consume a whole quoted credential or authentication scheme, not only "Basic"/"Bearer".
      .replace(
        /((?:api[_-]?(?:key|token)|access[_-]?token|oauth[_-]?token|(?:proxy[_-]?)?authorization|x[_-]auth[_-]?(?:key|token)|(?:client[_-]?)?secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Basic|Bearer)\s+[^\s"'&,;}]+|[^\s"'&,;}]+)/gi,
        '$1[redacted]',
      )
      // Unquoted cookie lists end before prose rather than consuming the rest of the error line.
      .replace(
        /((?:set[_-]?)?cookie["']?\s*[:=]\s*)(?:[^;\s"',}]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+(?:;\s*[A-Za-z0-9_.-]+=(?:[^;\s"',}]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*)*/gi,
        '$1[redacted]',
      )
      .replace(/Bearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}]+)/gi, 'Bearer [redacted]')
      .replace(/\bBasic\s+([A-Za-z0-9+/]+={0,2})/gi, (match, credential: string) => {
        // A standalone Basic scheme must decode to user:password; keep ordinary "Basic authentication" prose.
        try {
          return atob(credential).includes(':') ? 'Basic [redacted]' : match;
        } catch {
          return match;
        }
      })
      .slice(0, limit)
  );
}

/** Bounded provider exception diagnostics: never expose credentials or inline image bytes. */
export function cloudProviderException(error: unknown) {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  return {
    name: sanitizedProviderText(typeof value.name === 'string' ? value.name : 'Error', 100),
    message: sanitizedProviderText(
      typeof value.message === 'string' ? value.message : 'Unknown provider exception',
      2000,
    ),
    ...(typeof value.status === 'number' && Number.isFinite(value.status) ? { status: value.status } : {}),
  };
}
