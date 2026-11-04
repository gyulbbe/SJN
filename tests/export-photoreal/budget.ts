/**
 * The export-photoreal trial's arithmetic, kept free of I/O so tests/export-photoreal.test.ts can check
 * it: neurons of a call, whether a call may go out, and the rank agreement between an automatic score
 * and the human ratings.
 */

/** 1,000 neurons cost $0.011. */
export const USD_PER_NEURON = 0.011 / 1000;
/** The user's budget for this trial (2026-11-04) and the trial's share of one UTC day. */
export const BUDGET = 10_000;
export const DAILY = 6_000;
/** The tool refuses before a call would pass this share of the budget. */
export const BUDGET_SHARE = 0.9;

/**
 * FLUX.2 klein 4B, Cloudflare's price list of 2026-10-20 in neurons: each 512 × 512 tile of an input
 * image (a reference counts as one more input) and of the output. 9B and dev are not in this trial.
 */
export const FLUX_4B = { inputTile: 5.37, outputTile: 26.05 };
const tiles = (width: number, height: number) => Math.ceil(width / 512) * Math.ceil(height / 512);
export function fluxNeurons(
  inputs: readonly { width: number; height: number }[],
  output: { width: number; height: number },
  price = FLUX_4B,
): number {
  const input = inputs.reduce((sum, image) => sum + tiles(image.width, image.height), 0);
  return input * price.inputTile + tiles(output.width, output.height) * price.outputTile;
}

export type Price = { inputPerM: number; outputPerM?: number };
/** Token models from `wrangler ai models list --json` (2026-11-04). */
export const PRICES: Record<string, Price> = {
  '@cf/google/gemma-4-26b-a4b-it': { inputPerM: 0.1, outputPerM: 0.3 },
  '@cf/cloudflare/clef-flash': { inputPerM: 0.038 },
};
export function tokenNeurons(price: Price, inputTokens: number, outputTokens = 0): number {
  return (inputTokens * price.inputPerM + outputTokens * (price.outputPerM ?? 0)) / 1e6 / USD_PER_NEURON;
}

/**
 * Image models without a known price: the list says "beta, $0 per step", which is not trusted until
 * the account's own analytics show what one call cost. Until then only one call of each goes out.
 */
export const UNPRICED = new Set([
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/lykon/dreamshaper-8-lcm',
  '@cf/bytedance/stable-diffusion-xl-lightning',
  '@cf/runwayml/stable-diffusion-v1-5-inpainting',
]);

export type LedgerRow = {
  at: string;
  model: string;
  neurons?: number;
  status: number | string;
};
/** UTC day of an ISO time (the free allowance resets at 00:00 UTC). */
export const utcDay = (iso: string) => iso.slice(0, 10);

/**
 * Whether a call estimated at `cost` may go out: refused when the trial would pass 90% of the budget,
 * when this UTC day's calls would pass the daily share, or when an unpriced model already made a call
 * whose cost the account's analytics have not confirmed (`confirmed` holds those models).
 */
export function budgetCheck(
  rows: readonly LedgerRow[],
  call: { at: string; model: string; cost: number },
  confirmed: ReadonlySet<string> = new Set(),
  limits = { budget: BUDGET, daily: DAILY },
): { ok: true } | { ok: false; reason: string } {
  const spent = rows.filter((row) => row.status !== 'refused');
  const total = spent.reduce((sum, row) => sum + (row.neurons ?? 0), 0);
  if (total + call.cost > limits.budget * BUDGET_SHARE)
    return {
      ok: false,
      reason: `trial total ${Math.round(total + call.cost)} > ${BUDGET_SHARE * 100}% of ${limits.budget}`,
    };
  const today = spent
    .filter((row) => utcDay(row.at) === utcDay(call.at))
    .reduce((sum, row) => sum + (row.neurons ?? 0), 0);
  if (today + call.cost > limits.daily)
    return { ok: false, reason: `${utcDay(call.at)} ${Math.round(today + call.cost)} > ${limits.daily}` };
  if (UNPRICED.has(call.model) && !confirmed.has(call.model) && spent.some((row) => row.model === call.model))
    return { ok: false, reason: `${call.model}: one call made, its cost not yet read from the account` };
  return { ok: true };
}

/** Ranks with ties averaged (1-based). */
function ranks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    for (let k = i; k <= j; k++) result[order[k].index] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return result;
}
/** Spearman's rank correlation; NaN when either side has no spread or fewer than three pairs. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length < 3) return Number.NaN;
  const ra = ranks(a),
    rb = ranks(b);
  const mean = (ra.length + 1) / 2;
  let num = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - mean) * (rb[i] - mean);
    da += (ra[i] - mean) ** 2;
    db += (rb[i] - mean) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : Number.NaN;
}
/** An automatic score is used for choosing only when it ranks results like people do. */
export const MIN_AGREEMENT = 0.5;
