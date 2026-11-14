// Where the added-objects trial (docs/extra-ai-trials-20261114.md) reads and writes: the main checkout's
// test-results (git-ignored), so results outlive a worktree. The catalogue snapshot is read only.
import { join } from 'node:path';
import { ROOT, SNAPSHOT } from '../export-photoreal/paths.mjs';

export { ROOT, SNAPSHOT };
export { ACCOUNT_FILES } from '../ledge-ai/paths.mjs';
export const OUT = join(ROOT, 'test-results', 'extra-ai-20261114');
/** The 11-04 trial's eight development scenes and its two held-out ones (opened only with --holdout). */
export const SCENES = join(OUT, 'scenes');
export const HOLDOUT = join(OUT, 'holdout');
export const RESULTS = join(OUT, 'results');
export const REVIEW = join(OUT, 'review');
export const LEDGER = join(OUT, 'ledger.jsonl');
/** Other trials' ledgers: the same account's calls of a UTC day count against that day here too. */
export const OTHER_LEDGERS = [
  join(ROOT, 'test-results', 'tile-ai-20261113', 'ledger.jsonl'),
  join(ROOT, 'test-results', 'ledge-ai-20261111', 'ledger.jsonl'),
];
