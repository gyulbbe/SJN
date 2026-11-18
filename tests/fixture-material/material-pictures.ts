/**
 * Candidate pictures for the ceramics the model drew as metal (no AI call,
 * docs/fixture-material-20261118.md): per result today's app picture and, when a ceramic looks metal
 * (material-method.ts metalScores), P1 (that ceramic back as the render's).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-material/material-pictures.ts [--set reg]
 *   [--ids a,b] [--bands 6.5] [--ratio 3] [--tag p1]
 * Output: test-results/fixture-material-20261118/pictures/<id>.<tag>.png (P1), <id>.<tag>f.png (P1 + F1
 *   feet), <tag>-<set>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { liftFeet, metalScores, pasteRender } from './material-method';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'reg') as HazeSet;
const only = arg('ids') ? new Set(arg('ids').split(',')) : undefined;
const minBands = Number(arg('bands', '6.5')),
  minRatio = Number(arg('ratio', '3'));
const tag = arg('tag', 'p1');
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });
const rows = [];
for (const source of haze(set)) {
  if (only && !only.has(source.id)) continue;
  const loaded = await loadInput(source);
  if (!loaded) continue;
  const { input } = loaded;
  const app = refineCurrentResult(input);
  if (!app.shown) continue;
  const started = performance.now();
  const scores = metalScores(input, app);
  const metal = new Set(scores.filter((s) => s.bands >= minBands && s.ratio >= minRatio).map((s) => s.fixture));
  const pasted = metal.size ? pasteRender(input, metal) : undefined;
  const p1 = pasted?.image ?? app.shown;
  // F1 on top: on the picture P1 made (its own outline), else on the app's.
  const feet = liftFeet(input, pasted ? { ...pasted.again, shown: pasted.image } : app);
  const ms = Math.round(performance.now() - started);
  writeFileSync(join(dir, `${source.id}.${tag}.png`), await png(p1));
  writeFileSync(join(dir, `${source.id}.${tag}f.png`), await png(feet.image ?? p1));
  rows.push({ id: source.id, metal: [...metal], scores, feet: feet.lifted, ms });
  console.log(
    source.id.padEnd(26),
    metal.size ? `metal ${[...metal].map((k) => input.fixtures[k].kind).join(',')}` : '-',
    `feet ${feet.lifted}`,
    `${ms} ms`,
  );
}
writeFileSync(join(OUT as string, `${tag}-${set}.json`), JSON.stringify(rows, null, 1));
