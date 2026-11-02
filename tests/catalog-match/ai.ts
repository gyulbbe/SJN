/**
 * Every AI call of the catalog-match trial goes through `callAi` (node): it refuses before sending when
 * the call would pass 90% of the trial budget or the account's daily share (budgetCheck), sends it
 * through the local temporary Worker (the signed-in account, "own") or REST (the extra account, only
 * when the user has put AI_EXTRA_1_ACCOUNT_ID and AI_EXTRA_1_TOKEN in .dev.vars), and writes one ledger
 * row whatever happens. A daily limit (429 / 3036) stops the run; any other refusal is recorded with
 * Cloudflare's code and stops that model. Nothing is retried, nothing moves to another account, no
 * secret or account id is written anywhere.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetCheck, callNeurons, type LedgerRow, type Price } from './score';
import { LEDGER, ROOT } from './paths.mjs';

export const BUDGET = 15_000;
export const ACCOUNT_DAILY = 7_500;
export const WORKER_URL = process.env.CATALOG_MATCH_AI_URL ?? 'http://127.0.0.1:8799';

/** USD per million tokens, from `wrangler ai models list --json` on 2026-11-02. */
export const PRICES: Record<string, Price> = {
  '@cf/google/gemma-4-26b-a4b-it': { inputPerM: 0.1, outputPerM: 0.3 },
  '@cf/cloudflare/clef-flash': { inputPerM: 0.038 },
  '@cf/cloudflare/clef': { inputPerM: 0.24 },
  '@cf/meta/llama-3.2-11b-vision-instruct': { inputPerM: 0.0485, outputPerM: 0.676 },
  '@cf/moondream/moondream3.1-9B-A2B': { inputPerM: 0.3, outputPerM: 1 },
};

export type Account = 'own' | 'extra-1';
export class StopRun extends Error {}
const stoppedModels = new Map<string, string>();

function ledgerRows(): (LedgerRow & Record<string, unknown>)[] {
  if (!existsSync(LEDGER as string)) return [];
  return readFileSync(LEDGER as string, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export const spent = () =>
  ledgerRows()
    .filter((row) => row.status !== 'refused')
    .reduce((sum, row) => sum + (row.neurons ?? 0), 0);

/** The extra account from .dev.vars, read for the call only and never logged. */
function extraAccount(): { id: string; token: string } | undefined {
  const file = join(ROOT as string, '.dev.vars');
  if (!existsSync(file)) return;
  const values = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m![1], m![2].replace(/^"|"$/g, '')]),
  );
  const id = values.AI_EXTRA_1_ACCOUNT_ID,
    token = values.AI_EXTRA_1_TOKEN;
  return id && token ? { id, token } : undefined;
}
export const extraAvailable = () => !!extraAccount();

/** Tokens of an answer, wherever the model puts them. */
function usageOf(result: unknown): { input?: number; output?: number } {
  const r = result as Record<string, unknown> | undefined;
  const usage = (r?.usage ?? r?.metrics ?? (r?.result as Record<string, unknown> | undefined)?.usage) as
    Record<string, number> | undefined;
  if (!usage) return {};
  return {
    input: usage.prompt_tokens ?? usage.input_tokens,
    output: usage.completion_tokens ?? usage.output_tokens ?? 0,
  };
}

export type AiCall = {
  round: string;
  task: string;
  photo?: string;
  model: string;
  input: unknown;
  /** The estimate checked against the budget before sending (neurons). */
  estimate: number;
  account?: Account;
};
export async function callAi(call: AiCall): Promise<{ result: unknown; neurons: number; ms: number }> {
  const account = call.account ?? 'own';
  const at = new Date().toISOString();
  const base = { at, round: call.round, task: call.task, photo: call.photo, model: call.model, account };
  if (stoppedModels.has(call.model))
    throw new StopRun(`${call.model} stopped: ${stoppedModels.get(call.model)}`);
  const check = budgetCheck(
    ledgerRows(),
    { account, at, cost: call.estimate },
    { budget: BUDGET, accountDaily: ACCOUNT_DAILY },
  );
  if (!check.ok) {
    appendFileSync(
      LEDGER as string,
      JSON.stringify({ ...base, status: 'refused', reason: check.reason, estimate: call.estimate }) + '\n',
    );
    throw new StopRun(`refused: ${check.reason}`);
  }
  const started = Date.now();
  let status: number | string = 0,
    result: unknown,
    error: string | undefined;
  try {
    if (account === 'own') {
      const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: call.model, input: call.input }),
      });
      status = response.status;
      const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
      if (body.ok) result = body.result;
      else error = body.error;
    } else {
      const extra = extraAccount();
      if (!extra) throw new StopRun('the extra account is not in .dev.vars');
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${extra.id}/ai/run/${call.model}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${extra.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(call.input),
        },
      );
      status = response.status;
      const body = (await response.json()) as {
        success: boolean;
        result?: unknown;
        errors?: { code: number; message: string }[];
      };
      if (body.success) result = body.result;
      else error = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
    }
  } catch (e) {
    if (e instanceof StopRun) throw e;
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - started;
  const usage = usageOf(result);
  const measured = usage.input !== undefined;
  const neurons = measured
    ? callNeurons(PRICES[call.model], usage.input!, usage.output ?? 0)
    : // No usage in the answer (or a failure): the estimate counts, a failure may be billed.
      call.estimate;
  appendFileSync(
    LEDGER as string,
    JSON.stringify({
      ...base,
      status: error ? status || 'error' : status,
      inputTokens: usage.input ?? null,
      outputTokens: usage.output ?? null,
      neurons: Number(neurons.toFixed(2)),
      neuronsFrom: measured ? 'usage' : 'estimate',
      ms,
      ...(error ? { error: error.slice(0, 500) } : {}),
    }) + '\n',
  );
  if (error) {
    const code = error.match(/\b(\d{4})\b/)?.[1];
    if (status === 429 || code === '3036')
      throw new StopRun(`daily limit (${code ?? status}): stopping, results kept`);
    stoppedModels.set(call.model, `${status} ${code ?? ''} ${error.slice(0, 200)}`);
    throw new StopRun(`${call.model} refused (${status} ${code ?? ''}); that model is stopped`);
  }
  return { result, neurons, ms };
}
