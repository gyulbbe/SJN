// Where the side-tile AI trial (step 1: the 3D light change 6e0ca52 → 3037c8e seen through the AI) reads and
// writes: THIS checkout's test-results (git-ignored), never the main checkout or another worktree.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const ROOT = resolve(
  execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
);
export const OUT = join(ROOT, 'test-results', 'side-tile-ai-20261121');
/** The public catalogue records and list images of the scenes' materials only (catalog.mjs). */
export const CATALOG = join(OUT, 'catalog');
/** The app's cut-out model (BiRefNet lite fp16, the pinned file the app itself downloads). */
export const BACKGROUND_MODEL = join(ROOT, 'tmp', 'background-model');
/** The two renderers compared: before (6e0ca52) and after (3037c8e) the 3D light change. */
export const REVISIONS = { before: '6e0ca52', after: '3037c8e' };
export const SEEDS = [424242, 777001];
