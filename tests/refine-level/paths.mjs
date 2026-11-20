// Where the refine-level trial (docs/refine-level-20261120.md) writes: the main checkout's
// test-results (git-ignored). Its review pictures go beside the fixture-glare ones (one review screen).
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'refine-level-20261120');
export const GLARE = join(ROOT, 'test-results', 'fixture-glare-20261119');
export const PHOTO_PRODUCTS = join(ROOT, 'test-results', 'photo-products-20261115');
