/**
 * `--dir <name>`: scenes drawn by a later renderer go to their own folder next to the trial's, and their
 * results to `<group>-<name>` (2026-11-14: `scenes-light` after the light tuning, so the rated trial's
 * inputs and results stay as they were).
 */
import { dirname, join } from 'node:path';

const named = (() => {
  const i = process.argv.indexOf('--dir');
  const value = i > 0 ? process.argv[i + 1] : '';
  if (value && !/^scenes-[a-z0-9-]+$/.test(value)) throw new Error('--dir scenes-<name>');
  return value;
})();
/** The scene folder: the trial's (`scenes` / `holdout`) or `--dir` beside it. */
export const sceneRoot = (root: string) =>
  named ? join(dirname(root), named + (root.endsWith('holdout') ? '-holdout' : '')) : root;
/** The results group: `cf`, or `cf-light` for `--dir scenes-light`. */
export const resultGroup = (group: string) => (named ? `${group}-${named.slice('scenes-'.length)}` : group);
