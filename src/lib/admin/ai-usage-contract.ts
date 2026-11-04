/** Workers AI free allocation per account per UTC day (Workers Free and Paid alike). */
export const DAILY_FREE_NEURONS = 10_000;
/** Workers Paid rate for neurons beyond the daily free allocation. */
export const NEURON_USD_PER_THOUSAND = 0.011;

/** D1 free allowance per account per UTC day (Workers Free): rows written and rows read. */
export const DAILY_FREE_D1_WRITES = 100_000;
export const DAILY_FREE_D1_READS = 5_000_000;
/** The account's D1 rows today (every database of the account counts against one allowance). */
export type D1UsageSummary = {
  rowsWritten: number;
  rowsRead: number;
  freeWrites: number;
  freeReads: number;
  remainingWrites: number;
  remainingReads: number;
  writeQueries: number;
  readQueries: number;
};

export type AiUsageModel = { modelId: string; neurons: number; requests: number };
export type AiUsageDay = { date: string; neurons: number; requests: number };

/** Account-wide Workers AI usage from Cloudflare's sampled analytics, never the app's own guess. */
export type AiUsageSummary = {
  checkedAt: string;
  /** Current UTC day window; the allocation resets at resetAt (09:00 KST). */
  dayStart: string;
  resetAt: string;
  freeNeurons: number;
  usedNeurons: number;
  remainingNeurons: number;
  requests: number;
  overageNeurons: number;
  overageUsd: number;
  models: AiUsageModel[];
  /** Oldest first, today last. Null when Cloudflare did not return the seven-day range. */
  days: AiUsageDay[] | null;
  /** Today's D1 rows from the same analytics (no D1 read); null with the reason when that part failed. */
  database: D1UsageSummary | null;
  databaseError?: string;
};
