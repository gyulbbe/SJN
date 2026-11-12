/**
 * The ledge AI trial's spending rule, free of I/O (docs/ledge-ai-trials-20261111.md, section 3): the
 * user's 20,000 neurons for the whole trial, and each Cloudflare account's share of one UTC day.
 */
export const BUDGET = 20_000;
/** The tool refuses before a call would pass this share of the budget. */
export const BUDGET_SHARE = 0.9;
/** One account's share of a UTC day, under its free 10,000. */
export const DAILY = 9_000;
export const ACCOUNTS = ['second', 'third'] as const;
export type Account = (typeof ACCOUNTS)[number];
export type LedgerRow = {
  at: string;
  account: Account;
  model: string;
  /** The price-list estimate: a FLUX answer carries no usage, and a failed call may be billed too. */
  neurons: number;
  status: number | string;
  round?: string;
  method?: string;
  scene?: string;
  seed?: number;
  ms?: number;
  error?: string;
};
const utcDay = (iso: string) => iso.slice(0, 10);
export const spent = (rows: readonly LedgerRow[]) =>
  rows.filter((row) => row.status !== 'refused').reduce((sum, row) => sum + row.neurons, 0);

/** Whether a call estimated at `cost` may go out on an account at a time. */
export function admit(
  rows: readonly LedgerRow[],
  call: { at: string; account: Account; cost: number },
): { ok: true } | { ok: false; reason: string } {
  const total = spent(rows) + call.cost;
  if (total > BUDGET * BUDGET_SHARE)
    return { ok: false, reason: `trial total ${Math.round(total)} > ${BUDGET * BUDGET_SHARE}` };
  const today =
    spent(rows.filter((row) => row.account === call.account && utcDay(row.at) === utcDay(call.at))) +
    call.cost;
  if (today > DAILY)
    return { ok: false, reason: `${call.account} ${utcDay(call.at)} ${Math.round(today)} > ${DAILY}` };
  return { ok: true };
}
/** A status that ends the run at once: a rate or quota limit is never retried. */
export const isLimit = (status: number | string, error?: string) =>
  status === 429 || /\b(429|quota|limit|capacity|neuron)/i.test(error ?? '');
