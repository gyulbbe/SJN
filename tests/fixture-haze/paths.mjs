// Where the fixture-haze trial (docs/fixture-haze-20261116.md) writes: the main checkout's
// test-results (git-ignored). The cut-out model is the local copy of the app's (tmp/background-model).
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'fixture-haze-20261116');
export const MODELS = join(ROOT, 'tmp', 'background-model');
