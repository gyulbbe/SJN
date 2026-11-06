/**
 * The direction-photo methods trial's arithmetic (no I/O, checked by tests/direction-photo-methods.test.ts):
 * what a call costs and whether it may go out.
 *
 * The user's budget (2026-11-05): "남은 거 확인하고 있는 거 다 써도 돼" — whatever is left. The admin
 * usage screen could not be read (no sign-in in the browser pane), so a UTC day's share is the free
 * 10,000 less a margin (9,000, as the export-photoreal trial used) counting every trial ledger of the
 * signed-in account that day; the trial as a whole stops at 90% of 25,000 against a runaway. Real
 * spending may be higher than the estimate (docs: 1.5–3× on some days): a 429 or a 3036 stops the run.
 */
import { callNeurons } from '../../src/lib/direction-photo/plan';

export const BUDGET = 25_000;
/**
 * A UTC day's share, estimated. 9,000 at first; on 2026-11-05 the account's free 10,000 ran out at
 * about 5,959 estimated (real cost about 1.7 times callNeurons), so from 11-06 the share is 5,000
 * (about 8,500 real), leaving the account some room for production's fallback. DIRECTION_TRIAL_DAILY
 * overrides it for one run when the user says to spend the rest of the day (2026-11-06: "끝까지 써도 돼").
 */
export const DAILY = Number(process.env.DIRECTION_TRIAL_DAILY) || 5_000;
export const BUDGET_SHARE = 0.9;
export const FLUX_4B = '@cf/black-forest-labs/flux-2-klein-4b';
export const CLEF_FLASH = '@cf/cloudflare/clef-flash';

/** klein 4B, as the app estimates it: the guide and each photo one tile, the answer twice the guide. */
export const fluxCost = (guide: { width: number; height: number }, photos: number) =>
  callNeurons(guide, photos);
/** Clef-flash bills input tokens only ($0.038 per M; 1,000 neurons = $0.011). */
export const clefCost = (inputTokens: number) => (inputTokens * 0.038) / 1e6 / (0.011 / 1000);

export type Row = { at: string; neurons?: number; status: number | string; engine?: string };
export const utcDay = (iso: string) => iso.slice(0, 10);
const spent = (rows: readonly Row[]) =>
  rows.filter((row) => row.status !== 'refused' && row.engine !== 'local');

/**
 * Whether a Cloudflare call estimated at `cost` may go out at `at`: refused past 90% of the trial's
 * budget (this trial's ledger) or past the day's share (this trial's and the other trials' ledgers of
 * the same account that UTC day).
 */
export function budgetCheck(
  own: readonly Row[],
  others: readonly Row[],
  call: { at: string; cost: number },
  limits = { budget: BUDGET, daily: DAILY },
): { ok: true } | { ok: false; reason: string } {
  const total = spent(own).reduce((sum, row) => sum + (row.neurons ?? 0), 0);
  if (total + call.cost > limits.budget * BUDGET_SHARE)
    return {
      ok: false,
      reason: `trial total ${Math.round(total + call.cost)} > ${BUDGET_SHARE * 100}% of ${limits.budget}`,
    };
  const day = utcDay(call.at);
  const today = spent([...own, ...others])
    .filter((row) => utcDay(row.at) === day)
    .reduce((sum, row) => sum + (row.neurons ?? 0), 0);
  if (today + call.cost > limits.daily)
    return {
      ok: false,
      reason: `UTC ${day}: ${Math.round(today + call.cost)} > daily share ${limits.daily}`,
    };
  return { ok: true };
}

/** An answer that ends the run: the account's limit or a refusal (no retry, no other account). */
export const endsRun = (status: number, error = '') =>
  status === 429 ||
  status === 401 ||
  status === 402 ||
  status === 403 ||
  /\b3036\b|daily|quota|limit/i.test(error);
