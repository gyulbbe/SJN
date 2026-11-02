/**
 * Scoring and bookkeeping for the catalog-match trial (docs/catalog-match-trials-20261102.md). Pure
 * functions: top-N hits (strict and same-pattern), pattern groups, box matching, wall / third / order
 * scores, neuron estimates and the budget check. Covered by tests/catalog-match.test.ts.
 */

// ---------- ranking ----------
/** 1-based rank of the first id in `ranked` that counts as right, or Infinity. */
export function rankOf(ranked: readonly string[], right: (id: string) => boolean): number {
  const at = ranked.findIndex(right);
  return at < 0 ? Infinity : at + 1;
}
export type TopN = { 1: number; 5: number; 20: number; n: number };
/** Share of queries whose right answer is within the first 1, 5 and 20. */
export function topN(ranks: readonly number[]): TopN {
  const n = ranks.length;
  const share = (k: number) => (n ? ranks.filter((rank) => rank <= k).length / n : 0);
  return { 1: share(1), 5: share(5), 20: share(20), n };
}

// ---------- same pattern ----------
/**
 * The tiles that count as the same pattern as each tile: itself and every tile whose photo is near
 * identical to it (the same pattern in another size, like ARE-ALMOND 600 and 800). Pairwise, never
 * chained: a chain of "near" pairs ends up joining different colours.
 */
export function patternNeighbours(
  ids: readonly string[],
  same: readonly [string, string][],
): Map<string, Set<string>> {
  const neighbours = new Map(ids.map((id) => [id, new Set([id])]));
  for (const [a, b] of same) {
    neighbours.get(a)?.add(b);
    neighbours.get(b)?.add(a);
  }
  return neighbours;
}

// ---------- boxes ----------
export type Box = { left: number; top: number; right: number; bottom: number };
export function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)),
    h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = w * h;
  const union = (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - inter;
  return union > 0 ? inter / union : 0;
}
/**
 * One-to-one matching of predicted to annotated boxes of the same kind at IoU ≥ `threshold`, greedy
 * by IoU. Returns the hits, the misses (annotated, unmatched) and the extras (predicted, unmatched).
 */
export function matchBoxes<T extends { kind: string; box: Box }, U extends { kind: string; box: Box }>(
  truth: readonly T[],
  predicted: readonly U[],
  threshold = 0.5,
): { hits: [T, U, number][]; misses: T[]; extras: U[] } {
  const pairs: [number, number, number][] = [];
  truth.forEach((t, i) =>
    predicted.forEach((p, j) => {
      if (t.kind !== p.kind) return;
      const value = iou(t.box, p.box);
      if (value >= threshold) pairs.push([i, j, value]);
    }),
  );
  pairs.sort((a, b) => b[2] - a[2]);
  const usedT = new Set<number>(),
    usedP = new Set<number>();
  const hits: [T, U, number][] = [];
  for (const [i, j, value] of pairs) {
    if (usedT.has(i) || usedP.has(j)) continue;
    usedT.add(i);
    usedP.add(j);
    hits.push([truth[i], predicted[j], value]);
  }
  return {
    hits,
    misses: truth.filter((_, i) => !usedT.has(i)),
    extras: predicted.filter((_, j) => !usedP.has(j)),
  };
}

/** Gemma's raw `bbox_2d` is [ymin, xmin, ymax, xmax] in 0–1000 (cloud-gemma-coordinates.ts). */
export function gemmaBox(raw: readonly number[]): Box {
  const [ymin, xmin, ymax, xmax] = raw;
  return { left: xmin / 1000, top: ymin / 1000, right: xmax / 1000, bottom: ymax / 1000 };
}

// ---------- position ----------
export type Wall = 'back' | 'left' | 'right';
/** Which third of its wall a product is in, from its u (0 = the wall's left end as seen from inside). */
export function thirdOf(u: number): 'left' | 'middle' | 'right' {
  return u < 1 / 3 ? 'left' : u > 2 / 3 ? 'right' : 'middle';
}
export type PlacedGuess = { id: string; wall: Wall; u: number };
export type PlacedTruth = { id: string; wall: Wall | 'unknown'; u?: number };
/**
 * Same-wall share, same-third share (when the truth has a u), and the share of product pairs on the
 * same wall whose left-right order agrees. Products with an unknown wall leave the denominators.
 */
export function positionScore(truth: readonly PlacedTruth[], guess: readonly PlacedGuess[]) {
  const byId = new Map(guess.map((g) => [g.id, g]));
  const known = truth.filter((t) => t.wall !== 'unknown');
  const sameWall = known.filter((t) => byId.get(t.id)?.wall === t.wall).length;
  const withU = known.filter((t) => t.u !== undefined && byId.get(t.id)?.wall === t.wall);
  const sameThird = withU.filter((t) => thirdOf(byId.get(t.id)!.u) === thirdOf(t.u!)).length;
  let pairs = 0,
    agree = 0;
  for (let i = 0; i < known.length; i++)
    for (let j = i + 1; j < known.length; j++) {
      const a = known[i],
        b = known[j];
      if (a.wall !== b.wall || a.u === undefined || b.u === undefined || a.u === b.u) continue;
      const ga = byId.get(a.id),
        gb = byId.get(b.id);
      if (!ga || !gb || ga.wall !== a.wall || gb.wall !== b.wall) continue;
      pairs++;
      if (Math.sign(a.u - b.u) === Math.sign(ga.u - gb.u)) agree++;
    }
  return {
    known: known.length,
    missing: known.filter((t) => !byId.has(t.id)).length,
    sameWall: known.length ? sameWall / known.length : 0,
    sameThird: withU.length ? sameThird / withU.length : undefined,
    orderPairs: pairs,
    order: pairs ? agree / pairs : undefined,
  };
}

// ---------- neurons and the budget ----------
/** Workers AI bills $0.011 per 1,000 neurons. */
export const USD_PER_NEURON = 0.011 / 1000;
export type Price = { inputPerM: number; outputPerM?: number };
/** Estimated neurons of one call from its tokens and the model's listed price. */
export function callNeurons(price: Price, inputTokens: number, outputTokens = 0): number {
  const usd = (inputTokens * price.inputPerM + outputTokens * (price.outputPerM ?? 0)) / 1e6;
  return usd / USD_PER_NEURON;
}
export type LedgerRow = { at: string; account: string; neurons?: number; status: number | string };
/** UTC day of an ISO time (the free allowance resets at 00:00 UTC). */
export const utcDay = (iso: string) => iso.slice(0, 10);
/**
 * Whether a call estimated at `cost` may go out: refused when the whole trial would pass 90% of
 * `budget`, or this account's spend for the UTC day would pass `accountDaily`. Refused rows (status
 * "refused") never count; failed calls do (they may be billed).
 */
export function budgetCheck(
  rows: readonly LedgerRow[],
  call: { account: string; at: string; cost: number },
  limits: { budget: number; accountDaily: number },
): { ok: true } | { ok: false; reason: string } {
  const spent = rows.filter((row) => row.status !== 'refused');
  const total = spent.reduce((sum, row) => sum + (row.neurons ?? 0), 0);
  if (total + call.cost > limits.budget * 0.9)
    return { ok: false, reason: `trial total ${Math.round(total + call.cost)} > 90% of ${limits.budget}` };
  const today = spent
    .filter((row) => row.account === call.account && utcDay(row.at) === utcDay(call.at))
    .reduce((sum, row) => sum + (row.neurons ?? 0), 0);
  if (today + call.cost > limits.accountDaily)
    return {
      ok: false,
      reason: `${call.account} ${utcDay(call.at)} ${Math.round(today + call.cost)} > ${limits.accountDaily}`,
    };
  return { ok: true };
}
