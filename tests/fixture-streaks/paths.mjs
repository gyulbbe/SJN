// Where the fixture-streaks trial (docs/fixture-streaks-20261117.md) writes: the main checkout's
// test-results (git-ignored). It reads the fixture-haze trial's cut-outs and empty-room layers.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'fixture-streaks-20261117');
