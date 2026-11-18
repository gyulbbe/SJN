// Where the fixture-material trial (docs/fixture-material-20261118.md) writes: the main checkout's
// test-results (git-ignored). It reads the fixture-shadows and fixture-streaks pictures.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'fixture-material-20261118');
export const SHADOWS = join(ROOT, 'test-results', 'fixture-shadows-20261118');
export const STREAKS = join(ROOT, 'test-results', 'fixture-streaks-20261117');
