/**
 * Face colours of today's app on a few results (no AI call, docs/glossy-tile-20261121.md): the
 * render's, the model's and the corrected face mean (L*), to see why a glossy wall ends lighter.
 *
 * Usage: node tests/run-browser-test.mjs tests/glossy-tile/probe.ts --only g-olive
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pixels } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { pixels } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { GLARE } from './paths.mjs';

const i = process.argv.indexOf('--only');
const only = i > 0 ? process.argv[i + 1].split(',') : undefined;
const done = new Set<string>();
for (const [set, cut] of [
  ['glare-final', 6],
  ['glare-diffsemi', 9],
] as const)
  for (const source of haze(set as HazeSet)) {
    const id = source.id.slice(0, -cut);
    if (done.has(id) || (only && !only.some((o) => id.startsWith(o)))) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    done.add(id);
    const softFile = join(GLARE as string, 'soft-scenes', 'r60', 'behind', source.layers, 'behind.png');
    const soft: Pixels | undefined = existsSync(softFile) ? await pixels(softFile) : undefined;
    const app = refineCurrentResult({ ...loaded.input, ...(soft ? { soft } : {}) });
    console.log(id, 'restored', app.joints?.restored.map((f) => f.key).join(','));
    const residual = new Map(app.review.residual?.map((c) => [c.region, c]));
    for (const c of app.review.changes)
      console.log(
        `  ${c.kind} #${c.region}: render L* ${c.reference[0].toFixed(1)}, model ${c.result[0].toFixed(1)}, after ${residual.get(c.region)?.result[0].toFixed(1)}`,
      );
  }
