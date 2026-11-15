// Where the side-wall trial (docs/side-wall-tiles-20261115.md) writes: the main checkout's
// test-results (git-ignored). It reads the catalogue snapshot only and calls no AI.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'side-wall-20261115');
