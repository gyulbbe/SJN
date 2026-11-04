// Where the direction-photo methods trial reads and writes (docs/direction-photo-methods-results-20261105.md).
// Results live in the main checkout's test-results (git-ignored) so they outlive a worktree; the earlier
// trials' data there is read only. DIRECTION_METHODS_ROOT overrides the main checkout.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

function mainCheckout() {
  if (process.env.DIRECTION_METHODS_ROOT) return resolve(process.env.DIRECTION_METHODS_ROOT);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  return dirname(common);
}

export const ROOT = mainCheckout();
/** The earlier runs' data, read only. */
export const INPUTS = join(ROOT, 'test-results');
/** This trial's results. */
export const OUT = join(INPUTS, 'direction-photo-methods');
/** Originals fetched from the public catalogue API (covers and full-size views). */
export const ORIGINALS = join(OUT, 'originals');
export const LEDGER = join(OUT, 'ledger.jsonl');
/** The public catalogue snapshot of 2026-11-02 (catalog-match), read only. */
export const SNAPSHOT = join(INPUTS, 'catalog-match', 'snapshot');
/** Earlier direction-photo inputs and human grades, read only. */
export const PRODUCT_REAL = join(INPUTS, 'product-representation', 'real', 'input');
export const TOILET_SIDE = join(INPUTS, 'toilet-side');
export const EXPLORE = join(INPUTS, 'direction-photo-explore');
/** Ledgers of other trials on the same signed-in account: their spend counts toward a UTC day. */
export const OTHER_LEDGERS = [
  join(INPUTS, 'export-photoreal', 'ledger.jsonl'),
  join(INPUTS, 'catalog-match', 'ledger.jsonl'),
];
/** The app's cached BiRefNet, MoGe-2 and the catalog-match image models (read only). */
export const BACKGROUND_MODEL = join(ROOT, 'tmp', 'background-model');
export const MOGE_MODEL = join(ROOT, 'tmp', 'moge2-onnx', 'model.onnx');
export const EMBED_MODELS = join(ROOT, 'tmp', 'catalog-match', 'models');
