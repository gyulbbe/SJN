// Where the "고칠 점" trial (docs/direction-photo-feedback-20261107.md) reads and writes: the main checkout's
// test-results (git-ignored), next to the sanitary-ware trial whose answers it sends back.
import { join } from 'node:path';
import { INPUTS } from '../direction-photo-methods/paths.mjs';
import {
  LEDGER as SANITARY_LEDGER,
  OTHER_LEDGERS as SANITARY_OTHERS,
  OUT as SANITARY,
  PREP as SANITARY_PREP,
} from '../sanitary-guides/paths.mjs';

/** The sanitary-ware trial: its prepared guides and photos, and its answers (read only). */
export { SANITARY, SANITARY_PREP };
/** This trial's answers, sheets and ledger. */
export const OUT = join(INPUTS, 'direction-photo-feedback-20261107');
export const LEDGER = join(OUT, 'ledger.jsonl');
/** The other trials' ledgers: their spend counts toward the same account's UTC day. */
export const OTHER_LEDGERS = [SANITARY_LEDGER, ...SANITARY_OTHERS];
