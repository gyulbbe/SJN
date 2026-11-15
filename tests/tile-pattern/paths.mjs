// Where the tile-pattern trial (docs/tile-pattern-trials-20261115.md) reads and writes. It makes no AI
// call: it reads the results of two earlier trials (git-ignored, in the main checkout's test-results)
// and writes its own pictures and reviews next to them.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'tile-pattern-20261115');
export const REVIEW = join(OUT, 'review');
/** The 11-13 tile trial: its scenes (joints widened in capture-grout.png) and the current method's results. */
export const TILE = join(ROOT, 'test-results', 'tile-ai-20261113');
/** The 11-14 added-objects trial: its scenes and the end-sentence results (what the app sends now). */
export const EXTRA = join(ROOT, 'test-results', 'extra-ai-20261114');
