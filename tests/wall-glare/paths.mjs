// Where the wall-glare trial (docs/wall-glare-20261121.md) writes: the main checkout's test-results
// (git-ignored). Its review pictures go beside the fixture-glare ones (one review screen), and it reads
// the softer 3D captures drawn there (fixture-glare section 7, soft-scenes).
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'wall-glare-20261121');
export const GLARE = join(ROOT, 'test-results', 'fixture-glare-20261119');
