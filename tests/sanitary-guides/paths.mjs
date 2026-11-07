// Where the sanitary-ware AI direction-photo trial (docs/sanitary-direction-photos-20261107.md) reads and
// writes: the main checkout's test-results (git-ignored), as the direction-photo methods trial does.
import { join } from 'node:path';
import {
  ROOT,
  INPUTS,
  LEDGER as METHODS_LEDGER,
  OTHER_LEDGERS as METHODS_OTHERS,
} from '../direction-photo-methods/paths.mjs';

/** The collection of 2026-11-06 (목록.csv and the photos), read only. */
export const PHOTOS = join(INPUTS, '위생도기-화신-20261106');
/** The class guides of 2026-11-06, read only. */
export const GUIDES = join(INPUTS, '위생도기-가이드-20261106');
/** This trial's results. */
export const OUT = join(INPUTS, '위생도기-방향사진-20261107');
export const PREP = join(OUT, 'prep');
export const LEDGER = join(OUT, 'ledger.jsonl');
/** The other trials' ledgers on the same signed-in account: their spend counts toward a UTC day. */
export const OTHER_LEDGERS = [METHODS_LEDGER, ...METHODS_OTHERS];
/**
 * The user's second Cloudflare account (2026-11-07), git-ignored in the main checkout: CLOUDFLARE_ACCOUNT_ID
 * and CLOUDFLARE_API_TOKEN for run.ts with CF_ACCOUNT=second. Its calls count only toward its own day.
 */
export const SECOND_ACCOUNT_FILE = join(ROOT, '.env.cf-second');
