/**
 * Workers AI over several accounts (docs/ai-account-pool-results-20261025.md): the extra account
 * first, through the REST API with its own token, then this Worker's own `AI` binding. Only a used-up
 * daily allocation (3036, `quota_exhausted`) or a refused token (401·403) moves on to the next
 * account; every other answer is the request's answer, as before (no retry). With no extra account
 * configured the binding is called exactly as it was.
 *
 * The extra account's ID and token stay in this module: never in a response, diagnostics or message.
 */
import { classifyCloudGemmaFailure, CloudGemmaError } from '@/lib/reconstruction/cloud-gemma-errors';
import { nextResetAt } from '@/lib/platform/service-limit';

type Environment = Record<string, unknown>;
type Multipart = { multipart: { body: ReadableStream; contentType: string } };
type RunOptions = { gateway?: unknown; returnRawResponse: true; signal: AbortSignal };
export type AiBinding = { run: (model: string, input: never, options: never) => Promise<Response> };
/** Which account answered: a number, never the account itself. */
export type AiAccountLabel = 'extra-1' | 'own';

type ExtraAccount = { label: 'extra-1'; accountId: string; token: string; gateway?: string };
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const GATEWAY = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The configured extra account (`AI_EXTRA_1_*`), or none when a value is missing or malformed. */
export function extraAccounts(environment: Environment): ExtraAccount[] {
  const accountId = text(environment.AI_EXTRA_1_ACCOUNT_ID),
    token = text(environment.AI_EXTRA_1_TOKEN),
    gateway = text(environment.AI_EXTRA_1_GATEWAY);
  if (!ACCOUNT_ID.test(accountId) || !token) return [];
  return [{ label: 'extra-1', accountId, token, ...(GATEWAY.test(gateway) ? { gateway } : {}) }];
}

/** Accounts whose day is used up, until their next 00:00 UTC (this instance only; nothing stored). */
const exhausted = new Map<string, number>();
const isExhausted = (label: string, now: number) => {
  const until = exhausted.get(label);
  if (until === undefined) return false;
  if (now < until) return true;
  exhausted.delete(label);
  return false;
};
/** Tests only: forget what this instance remembers. */
export function resetAiPoolMemory() {
  exhausted.clear();
}

const isMultipart = (input: unknown): input is Multipart =>
  !!input && typeof input === 'object' && 'multipart' in input;

/**
 * A binding-shaped caller over the extra account and this Worker's binding (either may be absent;
 * `undefined` when both are). `account` and `skipped` say afterwards who answered and who was passed
 * over, by number only.
 */
export function pooledBinding<T extends object>(
  environment: Environment,
  own: T | undefined,
  now: () => number = Date.now,
): (T & { account?: AiAccountLabel; skipped: string[] }) | undefined {
  const extras = extraAccounts(environment);
  if (!extras.length) {
    if (!own) return undefined;
    // Unchanged: the binding itself, called as before.
    const plain = Object.create(own) as T & { account?: AiAccountLabel; skipped: string[] };
    plain.skipped = [];
    const run = (own as unknown as AiBinding).run.bind(own);
    Object.assign(plain, {
      run: (...args: Parameters<AiBinding['run']>) => {
        plain.account = 'own';
        return run(...args);
      },
    });
    return plain;
  }
  const state: { account?: AiAccountLabel; skipped: string[] } = { skipped: [] };
  const run = async (model: string, input: unknown, options: RunOptions): Promise<Response> => {
    state.skipped = [];
    state.account = undefined;
    // A multipart stream is read once; each account gets its own copy of the same bytes.
    const multipart = isMultipart(input)
      ? {
          bytes: await new Response(input.multipart.body).arrayBuffer(),
          contentType: input.multipart.contentType,
        }
      : undefined;
    const fresh = () =>
      multipart
        ? { multipart: { body: new Response(multipart.bytes).body!, contentType: multipart.contentType } }
        : input;
    let last: Response | undefined;
    for (const account of extras) {
      if (isExhausted(account.label, now())) {
        state.skipped.push(`${account.label}:quota`);
        continue;
      }
      options.signal.throwIfAborted();
      const headers: Record<string, string> = { Authorization: `Bearer ${account.token}` };
      // The extra account's own gateway when it has one; otherwise straight to Workers AI.
      if (options.gateway && account.gateway) headers['cf-aig-gateway-id'] = account.gateway;
      let body: BodyInit;
      if (multipart) {
        headers['Content-Type'] = multipart.contentType;
        body = multipart.bytes;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(input);
      }
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/run/${model}`,
        { method: 'POST', headers, body, signal: options.signal },
      );
      if (response.ok) {
        state.account = account.label;
        return response;
      }
      const detail = await response.text();
      const failure = classifyCloudGemmaFailure(response.status, detail);
      if (failure.code === 'quota_exhausted') {
        exhausted.set(account.label, Date.parse(nextResetAt(new Date(now()))));
        state.skipped.push(`${account.label}:quota`);
        last = new Response(detail, { status: response.status, headers: response.headers });
        continue;
      }
      if ([401, 403].includes(response.status)) {
        // A withdrawn or narrowed token: the next account answers (the number only, for diagnostics).
        state.skipped.push(`${account.label}:auth`);
        continue;
      }
      state.account = account.label;
      return new Response(detail, { status: response.status, headers: response.headers });
    }
    if (own) {
      state.account = 'own';
      return (own as unknown as AiBinding).run(model, fresh() as never, options as never);
    }
    if (last) return last;
    throw new CloudGemmaError(
      'Cloudflare AI 인증 또는 모델 사용 권한을 확인해야 해요.',
      'authentication_required',
      403,
    );
  };
  const pooled = { run } as unknown as T & { account?: AiAccountLabel; skipped: string[] };
  Object.defineProperties(pooled, {
    account: { get: () => state.account },
    skipped: { get: () => state.skipped },
  });
  return pooled;
}
