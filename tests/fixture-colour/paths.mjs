// Where the fixture-colour trial (docs/fixture-colour-20261115.md) writes: the main checkout's
// test-results (git-ignored). Step 1 reads earlier trials' AI results and calls no AI.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'fixture-colour-20261115');
export const REVIEW = join(OUT, 'review');
