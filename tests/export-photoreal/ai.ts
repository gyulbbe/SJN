/**
 * Every AI call of the export-photoreal trial goes through here (node): the ledger refuses before a
 * call would pass 90% of the budget, the day's share, or a second call of an image model whose cost the
 * account has not shown (budgetCheck); the call goes to the local temporary Worker (the signed-in
 * account), and one ledger row is written whatever happens. A daily limit (429 / 3036) stops the run;
 * any other refusal is recorded with Cloudflare's code and stops that model. Nothing is retried,
 * nothing moves to another account, no secret or account id is written anywhere.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { budgetCheck, PRICES, tokenNeurons, UNPRICED, type LedgerRow } from './budget';
import { LEDGER, OUT } from './paths.mjs';

export const WORKER_URL = process.env.EXPORT_PHOTOREAL_AI_URL ?? 'http://127.0.0.1:8805';
export class StopRun extends Error {}
const stoppedModels = new Map<string, string>();

export type Row = LedgerRow & Record<string, unknown>;
export function ledgerRows(): Row[] {
  if (!existsSync(LEDGER as string)) return [];
  return readFileSync(LEDGER as string, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
/** Models whose one-call cost the account's analytics confirmed (usage/confirmed.json, by hand). */
function confirmedModels(): Set<string> {
  const file = join(OUT as string, 'usage', 'confirmed.json');
  return new Set(existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : []);
}
export const spent = () =>
  ledgerRows()
    .filter((row) => row.status !== 'refused')
    .reduce((sum, row) => sum + (row.neurons ?? 0), 0);

export type Call = {
  round: string;
  method: string;
  scene?: string;
  seed?: number;
  model: string;
  /** Checked against the budget before sending (neurons). */
  estimate: number;
  /** Sizes only, for the ledger. */
  sizes?: Record<string, unknown>;
};
function write(row: Record<string, unknown>) {
  mkdirSync(dirname(LEDGER as string), { recursive: true });
  appendFileSync(LEDGER as string, JSON.stringify(row) + '\n');
}
function admit(call: Call) {
  const at = new Date().toISOString();
  const base = {
    at,
    round: call.round,
    method: call.method,
    scene: call.scene,
    seed: call.seed,
    model: call.model,
    ...(call.sizes ?? {}),
  };
  if (stoppedModels.has(call.model))
    throw new StopRun(`${call.model} stopped: ${stoppedModels.get(call.model)}`);
  const check = budgetCheck(ledgerRows(), { at, model: call.model, cost: call.estimate }, confirmedModels());
  if (!check.ok) {
    write({ ...base, status: 'refused', reason: check.reason, estimate: call.estimate });
    throw new StopRun(`refused: ${check.reason}`);
  }
  return base;
}
function settle(
  call: Call,
  base: Record<string, unknown>,
  outcome: {
    status: number | string;
    ms: number;
    error?: string;
    neurons: number;
    from: string;
    tokens?: unknown;
  },
) {
  write({
    ...base,
    status: outcome.error ? outcome.status || 'error' : outcome.status,
    neurons: Number(outcome.neurons.toFixed(2)),
    neuronsFrom: outcome.from,
    estimate: call.estimate,
    ms: outcome.ms,
    ...(outcome.tokens ? { tokens: outcome.tokens } : {}),
    ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
  });
  if (outcome.error) {
    const code = outcome.error.match(/\b(\d{4})\b/)?.[1];
    if (outcome.status === 429 || code === '3036')
      throw new StopRun(`daily limit (${code ?? outcome.status}): stopping, results kept`);
    stoppedModels.set(call.model, `${outcome.status} ${code ?? ''} ${outcome.error.slice(0, 200)}`);
    throw new StopRun(`${call.model} refused (${outcome.status} ${code ?? ''}); that model is stopped`);
  }
}

/** One FLUX call: the model's own multipart fields, as the app's route sends them. */
export async function fluxCall(
  call: Call,
  fields: { images: Buffer[]; prompt: string; width: number; height: number; seed: number },
): Promise<{ image: Buffer; ms: number }> {
  const base = admit(call);
  const form = new FormData();
  form.set('model', call.model);
  fields.images.forEach((png, i) =>
    form.set(`input_image_${i}`, new Blob([new Uint8Array(png)], { type: 'image/png' }), `image-${i}.png`),
  );
  form.set('prompt', fields.prompt);
  form.set('width', String(fields.width));
  form.set('height', String(fields.height));
  form.set('seed', String(fields.seed));
  const started = Date.now();
  let status: number | string = 0,
    image: string | undefined,
    error: string | undefined;
  try {
    const response = await fetch(`${WORKER_URL}/flux`, { method: 'POST', body: form });
    status = response.status;
    const body = (await response.json()) as { ok: boolean; image?: string; error?: string };
    if (body.ok) image = body.image;
    else error = body.error ?? 'failed';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - started;
  // FLUX answers carry no usage: the price-list estimate counts (a failure may be billed too).
  settle(call, base, { status, ms, error, neurons: call.estimate, from: 'estimate' });
  return { image: Buffer.from(image!, 'base64'), ms };
}

/** Tokens of an answer, wherever the model puts them. */
function usageOf(result: unknown): { input?: number; output?: number } {
  const r = result as Record<string, unknown> | undefined;
  const usage = (r?.usage ?? (r?.result as Record<string, unknown> | undefined)?.usage) as
    Record<string, number> | undefined;
  if (!usage) return {};
  return {
    input: usage.prompt_tokens ?? usage.input_tokens,
    output: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

/** One JSON call (Gemma, Clef, a Stable Diffusion model); an image model's PNG comes back as `image`. */
export async function jsonCall(
  call: Call,
  input: unknown,
): Promise<{ result?: unknown; image?: Buffer; neurons: number; ms: number }> {
  const base = admit(call);
  const started = Date.now();
  let status: number | string = 0,
    result: unknown,
    image: string | undefined,
    error: string | undefined;
  try {
    const response = await fetch(`${WORKER_URL}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: call.model, input }),
    });
    status = response.status;
    const body = (await response.json()) as { ok: boolean; result?: unknown; image?: string; error?: string };
    if (body.ok) {
      result = body.result;
      image = body.image;
    } else error = body.error ?? 'failed';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - started;
  const usage = usageOf(result);
  const price = PRICES[call.model];
  const measured = !!price && usage.input !== undefined;
  const neurons = measured ? tokenNeurons(price, usage.input!, usage.output ?? 0) : call.estimate;
  settle(call, base, {
    status,
    ms,
    error,
    neurons,
    from: measured ? 'usage' : UNPRICED.has(call.model) ? 'assumed (price unknown)' : 'estimate',
    tokens: measured ? usage : undefined,
  });
  return { result, image: image ? Buffer.from(image, 'base64') : undefined, neurons, ms };
}
