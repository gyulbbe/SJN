/**
 * Today's app picture (current-refine.ts) of each sentence-variant result (run-prompt.ts), named after
 * the scene's earlier result so the review puts it beside that one's app picture (no AI call).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-material/variant-pictures.ts [--app]
 * Output: test-results/fixture-material-20261118/pictures/<id>.<semi|china|app>.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { png } from '../extra-ai/app-view';
import { haze } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { OUT } from './paths.mjs';

const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });
const only = process.argv.includes('--app') ? (['app'] as const) : (['semi', 'china'] as const);
for (const variant of only)
  for (const source of haze(`mat-${variant}`)) {
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
    console.log(source.id.padEnd(30), `${Math.round(performance.now() - started)} ms`, `bodies ${app.bodies?.length ?? 0}`);
  }
