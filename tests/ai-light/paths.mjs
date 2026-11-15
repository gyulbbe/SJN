// Where the AI-light trial (docs/ai-light-20261115.md) writes: the main checkout's test-results
// (git-ignored). It reads earlier trials' AI results and calls no AI.
import { join } from 'node:path';
import { ROOT } from '../export-photoreal/paths.mjs';

export { ROOT };
export const OUT = join(ROOT, 'test-results', 'ai-light-20261115');
export const REVIEW = join(OUT, 'review');
