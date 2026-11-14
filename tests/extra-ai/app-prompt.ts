/**
 * After the added-objects sentence went into the app (2026-11-14): the app's prompt for every trial
 * scene must be exactly what the trial sent for the end sentence (O1e, `names-end`), so the results
 * rated are what the app sends. Compares buildFluxPrompt(scene) with the prompt recorded in each
 * names-end result on disk and, for scenes not sent yet, with the trial's own composition. No AI call.
 *
 * Usage: node tests/run-browser-test.mjs tests/extra-ai/app-prompt.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFluxPrompt } from '../../src/lib/ai-export/prompt';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { fluxRequest } from './methods';
import { HOLDOUT, RESULTS, SCENES } from './paths.mjs';

let failed = 0;
for (const root of [SCENES, HOLDOUT] as string[]) {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const { scene } = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8')) as { scene: FluxScene };
    const app = buildFluxPrompt(scene);
    const trial = fluxRequest('names-end', dir).prompt;
    const sent = [424242, 777001]
      .map((seed) => join(RESULTS as string, 'cf', 'names-end', `${name}-${seed}.json`))
      .filter((file) => existsSync(file))
      .map((file) => (JSON.parse(readFileSync(file, 'utf8')) as { prompt: string }).prompt);
    const same = app === trial && sent.every((prompt) => prompt === app);
    if (!same) failed++;
    console.log(
      `${same ? 'same' : 'DIFFERENT'} ${name}: app ${app.length}, trial ${trial.length}, sent ${sent.length}`,
    );
  }
}
if (failed) throw new Error(`${failed} scenes differ`);
