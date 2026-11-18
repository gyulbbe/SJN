/**
 * The app's finishing steps (src/lib/ai-export/current-refine.ts) against the trial's chosen picture
 * (sb5lkf, tests/fixture-shadows/edge-pictures.ts), pixel for pixel (no AI call,
 * docs/fixture-shadows-20261118.md).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shadows/app-check.ts [--set reg] [--rule sb5lkf]
 */
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { pixels } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from './load';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'reg') as HazeSet;
const rule = arg('rule', 'sb5lkf');
let differ = 0,
  checked = 0;
for (const source of haze(set)) {
  const loaded = await loadInput(source);
  if (!loaded) continue;
  const started = performance.now();
  const app = refineCurrentResult(loaded.input);
  const ms = Math.round(performance.now() - started);
  const shown = app.shown ?? loaded.input.raw;
  const trial = await pixels(join(OUT as string, 'pictures', `${source.id}.${rule}.png`));
  let n = 0;
  for (let i = 0; i < shown.data.length; i += 4)
    if (
      shown.data[i] !== trial.data[i] ||
      shown.data[i + 1] !== trial.data[i + 1] ||
      shown.data[i + 2] !== trial.data[i + 2]
    )
      n++;
  checked++;
  if (n) differ++;
  console.log(
    source.id.padEnd(26),
    n ? `${n} px differ` : 'same',
    `${ms} ms`,
    `bodies ${app.bodies?.length ?? 0}`,
  );
}
console.log(`${set}: ${checked - differ}/${checked} same as ${rule}`);
