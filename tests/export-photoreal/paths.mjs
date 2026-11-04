// Where the export-photoreal trial reads and writes (docs/export-photoreal-trials-20261104.md). Results
// and downloaded models live in the main checkout, so they outlive a worktree; both are git-ignored.
// EXPORT_PHOTOREAL_ROOT overrides the main checkout.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

function mainCheckout() {
  if (process.env.EXPORT_PHOTOREAL_ROOT) return resolve(process.env.EXPORT_PHOTOREAL_ROOT);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return dirname(common);
}

export const ROOT = mainCheckout();
/** The earlier runs' data, read only. */
export const INPUTS = join(ROOT, 'test-results');
/** This trial's results. */
export const OUT = join(ROOT, 'test-results', 'export-photoreal');
/** The development scenes and the two held-out ones (read only with --holdout). */
export const SCENES = join(OUT, 'scenes');
export const HOLDOUT = join(OUT, 'holdout');
export const RESULTS = join(OUT, 'results');
export const LEDGER = join(OUT, 'ledger.jsonl');
export const MODELS = join(ROOT, 'tmp', 'export-photoreal', 'models');
/** The public catalogue snapshot of 2026-11-02 (catalog-match), read only. */
export const SNAPSHOT = join(INPUTS, 'catalog-match', 'snapshot');
/** The app's cached BiRefNet (tests/export-background-model.mjs). */
export const BACKGROUND_MODEL = join(ROOT, 'tmp', 'background-model');
