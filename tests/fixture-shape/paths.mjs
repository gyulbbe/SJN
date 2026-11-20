// Where the fixture-shape trial (docs/fixture-shape-20261120.md) writes: the main checkout's
// test-results (git-ignored). It reads the fixture-glare, fixture-material and fixture-haze pictures.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'fixture-shape-20261120');
export const GLARE = join(ROOT, 'test-results', 'fixture-glare-20261119');
