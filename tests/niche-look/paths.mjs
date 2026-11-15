// Where the niche-look trial (docs/niche-look-20261115.md) writes: the main checkout's test-results
// (git-ignored). Step 0 draws the app's pictures only and calls no AI.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'niche-look-20261115');
