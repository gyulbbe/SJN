// Where the glossy-tile trial (docs/glossy-tile-20261121.md) writes: the main checkout's test-results
// (git-ignored). Its review pictures go beside the fixture-glare ones (one review screen).
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'glossy-tile-20261121');
export const GLARE = join(ROOT, 'test-results', 'fixture-glare-20261119');
