/**
 * The design picture (the capture on the result's grid) of results whose ref the fixture-streaks trial
 * never drew (the standard-model held-out set), for the review (no AI call).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-material/ref-pictures.ts --set holdout
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectCapture } from '../../src/lib/ai-export/color';
import { png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { OUT, STREAKS } from './paths.mjs';

const i = process.argv.indexOf('--set');
const set = (i > 0 ? process.argv[i + 1] : 'holdout') as HazeSet;
for (const source of haze(set)) {
  if (existsSync(join(STREAKS as string, 'pictures', `${source.id}.ref.png`))) continue;
  const loaded = await loadInput(source);
  if (!loaded) continue;
  const { raw, capture, layout } = loaded.input;
  writeFileSync(join(OUT as string, 'pictures', `${source.id}.ref.png`), await png(projectCapture(capture, layout, { width: raw.width, height: raw.height })));
  console.log(source.id);
}
