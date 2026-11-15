// Where the photo-product trial (docs/photo-products-20261115.md) writes: the main checkout's
// test-results (git-ignored).
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';
import { OUT as EXTRA_OUT } from '../extra-ai/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'photo-products-20261115');
export const REVIEW = join(OUT, 'review');
/** The added-objects trial's photo scene (drawn 2026-11-14) and its results: today's method there. */
export const PHOTOS_SCENE = join(EXTRA_OUT, 'scenes', 'photos');
export const PHOTOS_RESULTS = join(EXTRA_OUT, 'results', 'cf');
