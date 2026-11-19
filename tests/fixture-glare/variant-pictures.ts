/**
 * Today's app picture (current-refine.ts) of each fixture-glare preamble result (run-glare.ts), named after
 * the scene's earlier result so the review puts it beside that one's app picture (no AI call).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-glare/variant-pictures.ts [--variants soft,nometal]
 * Output: test-results/fixture-glare-20261119/pictures/<id>.<soft|nometal>.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { OUT } from './paths.mjs';

const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });
const i = process.argv.indexOf('--variants');
const variants = (i > 0 ? process.argv[i + 1] : 'soft,nometal').split(',');
for (const variant of variants)
  for (const source of haze(`glare-${variant}` as HazeSet)) {
    const loaded = await loadInput(source);
    const id = source.id.slice(0, -variant.length - 1);
    if (!loaded) {
      console.log(source.id.padEnd(30), 'framing moved: not refined');
      continue;
    }
    const started = performance.now();
    const app = refineCurrentResult(loaded.input);
    writeFileSync(join(dir, `${id}.${variant}.png`), await png(app.shown ?? loaded.input.raw));
    writeFileSync(join(dir, `${id}.${variant}-raw.png`), await png(loaded.input.raw));
    console.log(
      source.id.padEnd(30),
      `${Math.round(performance.now() - started)} ms`,
      `bodies ${app.bodies?.length ?? 0}`,
    );
  }
