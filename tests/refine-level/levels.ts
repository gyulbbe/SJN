/**
 * The refine-level trial's levels (no AI call, docs/refine-level-20261120.md): today's refine with less
 * taken back toward the design (current-refine.ts `tuning`), on the registered results of today's
 * prompt (photo-product scenes `pp-final`, glossy-tile and registered scenes `glare-final`/`diffsemi`).
 * Written beside the fixture-glare pictures as `<id>.lv<n>.png` (L0 is today's app).
 *
 * Usage: node tests/run-browser-test.mjs tests/refine-level/levels.ts [--only pp-]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { LEVELS } from './levels-config';
import { GLARE } from './paths.mjs';

const i = process.argv.indexOf('--only');
const only = i > 0 ? process.argv[i + 1].split(',') : undefined;
const dir = join(GLARE as string, 'pictures');
const done = new Set<string>();
for (const [set, cut] of [
  ['pp-final', 6],
  ['glare-final', 6],
  ['glare-diffsemi', 9],
] as const)
  for (const source of haze(set as HazeSet)) {
    const id = source.id.slice(0, -cut);
    if (!/^(pp|g|n|r)-/.test(id) || done.has(id)) continue;
    if (only && !only.some((o) => id.startsWith(o))) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    done.add(id);
    const started = performance.now();
    for (const [n, tuning] of LEVELS.entries()) {
      const app = refineCurrentResult({ ...loaded.input, tuning });
      writeFileSync(join(dir, `${id}.lv${n}.png`), await png(app.shown ?? loaded.input.raw));
    }
    console.log(id.padEnd(22), `${Math.round(performance.now() - started)} ms for ${LEVELS.length} levels`);
  }
