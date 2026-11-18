// Where the fixture-shadows trial (docs/fixture-shadows-20261118.md) writes: the main checkout's
// test-results (git-ignored). It reads the fixture-streaks pictures and the fixture-haze layers.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'fixture-shadows-20261118');
export const STREAKS = join(ROOT, 'test-results', 'fixture-streaks-20261117');
