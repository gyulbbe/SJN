// Where the catalog-match trial reads and writes (docs/catalog-match-trials-20261102.md). Results and
// downloaded models live in the main checkout, so they outlive a worktree; both are git-ignored.
// CATALOG_MATCH_ROOT overrides the main checkout.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

function mainCheckout() {
  if (process.env.CATALOG_MATCH_ROOT) return resolve(process.env.CATALOG_MATCH_ROOT);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return dirname(common);
}

export const ROOT = mainCheckout();
/** The earlier runs' data, read only. */
export const INPUTS = join(ROOT, 'test-results');
/** This trial's results. */
export const OUT = join(ROOT, 'test-results', 'catalog-match');
export const MODELS = join(ROOT, 'tmp', 'catalog-match', 'models');
export const SNAPSHOT = join(OUT, 'snapshot');
export const LEDGER = join(OUT, 'ledger.jsonl');

/** The saved 2026-09-16 full run of the fifteen photos (v9). */
export const FIFTEEN_RUN = join(
  INPUTS,
  'reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/full15-ui-v9-01/attempts/2026-09-16T06-40-14-972Z-1d92020a',
);
export const FIFTEEN_START = join(INPUTS, 'reconstruction-fifteen-rebuild/20260915-start');
export const CORPUS_INPUTS = join(INPUTS, 'reconstruction-corpus/inputs');
export const CORPUS_RUN = join(INPUTS, 'reconstruction-corpus-final');
