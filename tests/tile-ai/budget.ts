/**
 * The tile AI trial's spending rule, free of I/O (docs/tile-ai-trials-20261113.md, section 3): the
 * user's 11,500 neurons for the whole trial (what was left of the ledge trial's 20,000), and each
 * Cloudflare account's share of one UTC day, where the same account's calls of other trials count.
 */
import type { Account, LedgerRow } from '../ledge-ai/budget';

export { isLimit, spent, type Account, type LedgerRow } from '../ledge-ai/budget';
export const BUDGET = 11_500;
/** The tool refuses before a call would pass this. */
export const BUDGET_STOP = 10_500;
/** One account's share of a UTC day, under its free 10,000. */
export const DAILY = 9_000;

const utcDay = (iso: string) => iso.slice(0, 10);
const sum = (rows: readonly LedgerRow[]) =>
  rows.filter((row) => row.status !== 'refused').reduce((total, row) => total + row.neurons, 0);

/**
 * Whether a call estimated at `cost` may go out on an account at a time. `rows` is this trial's
 * ledger; `others` are other trials' rows, which count only against the account's day.
 */
export function admit(
  rows: readonly LedgerRow[],
  call: { at: string; account: Account; cost: number },
  others: readonly LedgerRow[] = [],
): { ok: true } | { ok: false; reason: string } {
  const total = sum(rows) + call.cost;
  if (total > BUDGET_STOP) return { ok: false, reason: `trial total ${Math.round(total)} > ${BUDGET_STOP}` };
  const sameDay = (row: LedgerRow) => row.account === call.account && utcDay(row.at) === utcDay(call.at);
  const today = sum([...rows, ...others].filter(sameDay)) + call.cost;
  if (today > DAILY)
    return { ok: false, reason: `${call.account} ${utcDay(call.at)} ${Math.round(today)} > ${DAILY}` };
  return { ok: true };
}
